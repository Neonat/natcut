// Read-only Liene PixCut S1 protocol client.
// Framing and device constants are informed by BrenCut by brennan (LTKMN),
// MIT licensed. See THIRD_PARTY_NOTICES.md.

export const VID = 0x302c;
export const PID = 0x3101;
export const CTRL = Object.freeze({ iface: 2, out: 0x06, in: 0x86 });
export const DATA = Object.freeze({ iface: 3, out: 0x04, in: 0x84 });

const PRINTER_STATE = Object.freeze({
  10: 'initializing',
  20: 'idle',
  30: 'asleep',
  40: 'busy',
  50: 'off',
  60: 'error',
});

const SUB_STATE = Object.freeze({
  1000: 'init',
  2000: 'idle',
  3001: 'printing',
  3002: 'receiving file',
  3005: 'printing',
  3006: 'cancelling',
  3014: 'rendering',
  3015: 'initializing',
  3016: 'decoding',
  3017: 'loading paper',
  3018: 'printing yellow',
  3019: 'printing magenta',
  3020: 'printing cyan',
  3021: 'laminating',
  3022: 'preheating',
  3023: 'cooling down',
  3025: 'feeding',
  3026: 'ejecting',
  3028: 'picking for cut',
  3029: 'cutter homing',
  3030: 'cutting',
  3031: 'ejecting cut sheet',
  7000: 'aborted',
  8000: 'cancelled',
  9000: 'completed',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

export function frameJson(object) {
  return encoder.encode(`cmd json\n${JSON.stringify(object)}`);
}

export function takeJson(text) {
  const objects = [];
  let index = text.indexOf('{');
  let start = index;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let consumed = 0;

  for (; index >= 0 && index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(start, index + 1).replace(/[\0\r]/g, '');
        try {
          objects.push(JSON.parse(raw));
        } catch {
          // Ignore malformed noise and continue looking for a valid reply.
        }
        consumed = index + 1;
      }
    }
  }

  return [objects, text.slice(consumed)];
}

export function alertCodes(value) {
  const codes = [];
  for (const match of JSON.stringify(value ?? '').matchAll(/::(\d+)/g)) {
    const code = Number(match[1]);
    if (code !== 0) codes.push(code);
  }
  return codes;
}

export class ReadOnlyPixCut {
  #io;
  #log;
  #nextId;
  #pending = '';
  #queue = Promise.resolve();
  #timeoutMs;

  constructor(io, { log = () => {}, startingId = (Date.now() & 0x7fff) + 1, timeoutMs = 10_000 } = {}) {
    this.#io = io;
    this.#log = log;
    this.#nextId = startingId;
    this.#timeoutMs = timeoutMs;
  }

  async identify() {
    return this.#getProps(['model', 'sku', 'firmware-revision', 'hardware-revision', 'media-size']);
  }

  async status() {
    const properties = await this.#getProps(['printer-state', 'printer-sub-state', 'printer-state-alerts']);
    const state = Number(properties['printer-state']);
    const sub = Number(properties['printer-sub-state']);
    const alerts = alertCodes(properties['printer-state-alerts']);
    return {
      state,
      sub,
      alerts,
      label: PRINTER_STATE[state] ?? `state ${state}`,
      subLabel: SUB_STATE[sub] ?? `${sub}`,
    };
  }

  async activeJobs() {
    const response = await this.#request('get-job-id-list', {});
    return String(JSON.stringify(response.result ?? ''))
      .match(/\d+/g)
      ?.map(Number)
      .filter((value) => value > 0) ?? [];
  }

  async snapshot() {
    const identity = await this.identify();
    const status = await this.status();
    const activeJobs = await this.activeJobs();
    return { identity, status, activeJobs };
  }

  async #getProps(names) {
    const response = await this.#request('get-prop', names);
    const values = Array.isArray(response.result) ? response.result : [];
    const properties = {};
    names.forEach((name, index) => {
      const value = values[index];
      properties[name] = value && typeof value === 'object' && name in value ? value[name] : value;
    });
    return properties;
  }

  #request(method, params) {
    const run = async () => {
      const id = this.#nextId;
      this.#nextId += 1;
      await this.#io.write(CTRL.out, frameJson({ id, method, params }));
      const deadline = Date.now() + this.#timeoutMs;

      while (Date.now() < deadline) {
        const bytes = await this.#io.read(CTRL.in, 4096, Math.max(1, deadline - Date.now()));
        if (!bytes?.length) continue;
        const [objects, remainder] = takeJson(this.#pending + decoder.decode(bytes));
        this.#pending = remainder.length > 65_536 ? '' : remainder;
        for (const object of objects) {
          if (object.id === id) return object;
          if (object.method === 'event.rpt_err') {
            throw new Error(`printer error event: ${JSON.stringify(object.params ?? object)}`);
          }
          this.#log('event', object);
        }
      }

      throw new Error(`no reply to ${method}`);
    };

    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }
}
