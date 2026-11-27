const VID = 0x302c;
const PID = 0x3101;
const CTRL = { iface: 2, out: 0x06, in: 0x86 };
const DATA = { iface: 3, out: 0x04, in: 0x84 };
const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');

const printerStates = { 10: 'initializing', 20: 'idle', 30: 'asleep', 40: 'busy', 50: 'off', 60: 'error' };
const subStates = {
  1000: 'init', 2000: 'idle', 3001: 'printing', 3002: 'receiving file', 3005: 'printing',
  3014: 'rendering', 3017: 'loading paper', 3025: 'feeding', 3028: 'picking for cut',
  3029: 'cutter homing', 3030: 'cutting', 3031: 'ejecting cut sheet', 9000: 'completed',
};

function frameJson(object) {
  return encoder.encode(`cmd json\n${JSON.stringify(object)}`);
}
function takeJson(text) {
  const objects = [];
  let consumed = 0;
  let incomplete = null;
  for (const candidate of text.matchAll(/\{/g)) {
    const start = candidate.index;
    if (start < consumed) continue;
    let depth = 0;
    let string = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (string) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') string = false;
      } else if (character === '"') string = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) { end = index; break; }
    }
    if (end < 0) { incomplete ??= start; continue; }
    try {
      objects.push(JSON.parse(text.slice(start, end + 1).replace(/[\0\r]/g, '')));
      consumed = end + 1;
      incomplete = null;
    } catch {
    }
  }
  return [objects, text.slice(incomplete ?? consumed)];
}
function alertCodes(value) {
  return [...JSON.stringify(value ?? '').matchAll(/::(\d+)/g)].map((match) => Number(match[1])).filter(Boolean);
}
function jobIdFrom(result) {
  const entries = Array.isArray(result) ? result : [result];
  const ids = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const key of ['job-id', 'job_id']) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      const value = descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      if (Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff) ids.push(value);
    }
  }
  return ids.length === 1 ? ids[0] : null;
}

export function createWebUsbProtocol(io, { startingId = (Date.now() & 0x7fff) + 1, timeoutMs = 10_000 } = {}) {
  let nextId = startingId;
  let pending = '';

  async function request(method, params) {
    const id = nextId++;
    const deadline = Date.now() + timeoutMs;
    await io.write(CTRL.out, frameJson({ id, method, params }));
    while (Date.now() < deadline) {
      const bytes = await io.read(CTRL.in, 4096, Math.max(1, deadline - Date.now()));
      if (!bytes?.length) continue;
      const [objects, remainder] = takeJson(pending + decoder.decode(bytes));
      pending = remainder.length > 65_536 ? '' : remainder;
      for (const object of objects) {
        if (object.method === 'event.rpt_err') throw new Error(`Printer error event: ${JSON.stringify(object.params ?? object)}`);
        if (object.id !== id) continue;
        const error = object.error ?? object['error-code'];
        if (error !== undefined) throw new Error(`Printer rejected ${method}: ${JSON.stringify(error)}`);
        if (!Object.hasOwn(object, 'result')) throw new Error(`Invalid ${method} response.`);
        return object.result;
      }
    }
    throw new Error(`No reply to ${method}.`);
  }

  async function getProps(names) {
    const values = await request('get-prop', names);
    if (!Array.isArray(values)) throw new Error('Invalid get-prop response.');
    return Object.fromEntries(names.map((name, index) => {
      const value = values[index];
      return [name, value && typeof value === 'object' && name in value ? value[name] : value];
    }));
  }

  return {
    async snapshot() {
      const identity = await getProps(['model', 'sku', 'firmware-revision', 'hardware-revision', 'media-size']);
      const properties = await getProps(['printer-state', 'printer-sub-state', 'printer-state-alerts']);
      const state = Number(properties['printer-state']);
      const sub = Number(properties['printer-sub-state']);
      const alerts = alertCodes(properties['printer-state-alerts']);
      const jobs = await request('get-job-id-list', {});
      const activeJobs = String(JSON.stringify(jobs ?? '')).match(/\d+/g)?.map(Number).filter((value) => value > 0) ?? [];
      return {
        identity,
        status: { state, sub, alerts, label: printerStates[state] ?? `state ${state}`, subLabel: subStates[sub] ?? `${sub}` },
        activeJobs,
      };
    },

    async declare(declaration) {
      if (declaration?.method !== 'combo-job' || !Array.isArray(declaration.params)) throw new Error('Invalid combo declaration.');
      const id = jobIdFrom(await request(declaration.method, declaration.params));
      if (id === null) throw new Error('Printer declaration reply did not contain one unambiguous job ID.');
      return id;
    },

    async sendFrame(frame) {
      await io.write(DATA.out, frame);
      const deadline = Date.now() + timeoutMs;
      let acknowledgement = '';
      while (Date.now() < deadline) {
        const bytes = await io.read(DATA.in, 4096, Math.max(1, deadline - Date.now()));
        if (bytes?.length) acknowledgement += decoder.decode(bytes);
        const ok = /\bOK\b/.test(acknowledgement);
        const error = /\bER\b/.test(acknowledgement);
        if (ok && error) throw new Error('Printer returned an ambiguous data acknowledgement.');
        if (error) throw new Error(`Printer refused the data frame: ${acknowledgement.trim()}`);
        if (ok) return;
      }
      throw new Error('Printer data acknowledgement outcome is unknown.');
    },
  };
}

class InPipe {
  constructor(device, endpoint) {
    this.device = device;
    this.endpoint = endpoint;
    this.queue = [];
    this.waiters = [];
    this.alive = true;
    this.loop();
  }
  async loop() {
    while (this.alive) {
      try {
        const result = await this.device.transferIn(this.endpoint, 4096);
        if (result.status === 'stall') await this.device.clearHalt('in', this.endpoint);
        if (result.data?.byteLength) {
          this.push(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
        }
      } catch (error) {
        if (!this.alive) return;
        this.error = error;
        this.push(null);
        return;
      }
    }
  }
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.queue.push(value);
  }
  read(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const done = (value) => {
        clearTimeout(timer);
        if (value === null) reject(this.error ?? new Error('USB connection lost.'));
        else resolve(value);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(new Uint8Array());
      }, timeoutMs);
      this.waiters.push(done);
    });
  }
  stop() { this.alive = false; }
}

export function supportsWebUsb() {
  return typeof navigator !== 'undefined' && Boolean(navigator.usb);
}

export async function connectWebUsbPrinter(usb = navigator.usb) {
  const granted = typeof usb.getDevices === 'function' ? await usb.getDevices() : [];
  const device = granted.find((candidate) => candidate.vendorId === VID && candidate.productId === PID) ??
    await usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
  await device.open();
  try {
    if (!device.configuration) await device.selectConfiguration(1);
    await device.claimInterface(CTRL.iface);
    await device.claimInterface(DATA.iface);
    const pipes = new Map([
      [CTRL.in, new InPipe(device, CTRL.in & 0x0f)],
      [DATA.in, new InPipe(device, DATA.in & 0x0f)],
    ]);
    const io = {
      async write(endpoint, bytes) {
        const result = await device.transferOut(endpoint & 0x0f, bytes);
        if (result.status !== 'ok') throw new Error(`USB write ${result.status}.`);
      },
      read(endpoint, _length, timeoutMs) {
        const pipe = pipes.get(endpoint);
        if (!pipe) throw new Error('Unknown USB input endpoint.');
        return pipe.read(timeoutMs);
      },
    };
    return {
      device,
      protocol: createWebUsbProtocol(io),
      async close() {
        for (const pipe of pipes.values()) pipe.stop();
        try { await device.close(); } catch {
        }
      },
    };
  } catch (error) {
    try { await device.close(); } catch {
    }
    throw error;
  }
}
