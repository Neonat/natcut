import { CTRL, DATA, frameJson, takeJson } from './protocol.mjs';

const decoder = new TextDecoder('latin1');

function dataProperty(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function printerJobId(result) {
  const entries = Array.isArray(result) ? result : [result];
  const candidates = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const key of ['job-id', 'job_id']) {
      const value = dataProperty(entry, key);
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff) {
        candidates.push(value);
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}
function validateFrame(frame, jobId) {
  if (!(frame instanceof Uint8Array)) throw new TypeError('Printer frame must be bytes.');
  const newline = frame.indexOf(10);
  if (newline < 0 || frame.byteLength < newline + 5) throw new Error('Invalid printer data frame.');
  const header = decoder.decode(frame.subarray(0, newline + 1));
  const match = /^cmd data EXTLEN=(\d+)\n$/.exec(header);
  const extlen = Number(match?.[1]);
  if (!match || extlen !== frame.byteLength - newline - 1) throw new Error('Invalid printer data frame length.');
  const embedded = new DataView(frame.buffer, frame.byteOffset + newline + 1, 4).getUint32(0, true);
  if (embedded !== jobId) throw new Error('Printer data frame job ID mismatch.');
}
export function createUsbTransportMutationPort(io, { startingId = (Date.now() & 0x7fff) + 1, timeoutMs = 10_000 } = {}) {
  if (!io || typeof io.write !== 'function' || typeof io.read !== 'function') {
    throw new TypeError('Printer mutation port requires read and write functions.');
  }
  let nextId = startingId;
  let pendingControl = '';

  return {
    async declareCombo(declaration) {
      if (!declaration || declaration.method !== 'combo-job' || !Array.isArray(declaration.params)) {
        throw new Error('Invalid combo declaration.');
      }
      const id = nextId;
      nextId += 1;
      const deadline = Date.now() + timeoutMs;
      await io.write(CTRL.out, frameJson({ id, method: declaration.method, params: declaration.params }), timeoutMs);
      while (Date.now() < deadline) {
        const bytes = await io.read(CTRL.in, 4096, Math.max(1, deadline - Date.now()));
        if (!bytes?.length) continue;
        const [objects, remainder] = takeJson(pendingControl + decoder.decode(bytes));
        pendingControl = remainder.length > 65_536 ? '' : remainder;
        for (const object of objects) {
          if (object.method === 'event.rpt_err') throw new Error(`Printer error event: ${JSON.stringify(object.params ?? object)}`);
          if (object.id !== id) continue;
          const error = object.error ?? object['error-code'];
          if (error !== undefined) throw new Error(`Printer rejected combo job: ${JSON.stringify(error)}`);
          const jobId = printerJobId(object.result);
          if (jobId === null) throw new Error('Printer combo reply did not contain one unambiguous job ID.');
          return { jobId };
        }
      }
      throw new Error('Printer combo declaration outcome is unknown.');
    },

    async sendFrameAndWaitForAck({ jobId, frame }) {
      validateFrame(frame, jobId);
      await io.write(DATA.out, frame, timeoutMs);
      const deadline = Date.now() + timeoutMs;
      let acknowledgement = '';
      while (Date.now() < deadline) {
        const bytes = await io.read(DATA.in, 4096, Math.max(1, deadline - Date.now()));
        if (bytes?.length) acknowledgement += decoder.decode(bytes);
        if (acknowledgement.length > 65_536) throw new Error('Printer data acknowledgement exceeded the safety limit.');
        const ok = /\bOK\b/.test(acknowledgement);
        const error = /\bER\b/.test(acknowledgement);
        if (ok && error) throw new Error('Printer returned an ambiguous data acknowledgement.');
        if (error) throw new Error(`Printer refused data frame: ${acknowledgement.trim()}`);
        if (ok) return;
      }
      throw new Error('Printer data acknowledgement outcome is unknown.');
    },
  };
}
