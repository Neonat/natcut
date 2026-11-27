const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RUN_BYTES = 16 * 1024 * 1024;

export class WireFailure extends Error {
  readonly reason: 'malformed' | 'incomplete' | 'too-large' | 'cancelled';

  constructor(reason: WireFailure['reason']) {
    super(reason);
    this.reason = reason;
  }
}

function parseFrame(bytes: Uint8Array, decoder: TextDecoder): unknown {
  try {
    const lines = decoder.decode(bytes).split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:') || line === 'data');
    if (!data.length) return undefined; // SSE comments and metadata carry no payload.
    return JSON.parse(data.map(line => line.slice(5).replace(/^ /, '')).join('\n'));
  } catch {
    throw new WireFailure('malformed');
  }
}

export async function* sproutFrames(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  if (signal?.aborted) throw new WireFailure('cancelled');
  const iterator = chunks[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const frame = Buffer.allocUnsafe(MAX_FRAME_BYTES);
  let used = 0;
  let lineStart = 0;
  let total = 0;
  let finished = false;
  let interrupt: ((error: WireFailure) => void) | undefined;
  const onAbort = () => interrupt?.(new WireFailure('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (signal?.aborted) throw new WireFailure('cancelled');
      const next = signal
        ? await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            interrupt = reject;
            iterator.next().then(resolve, reject);
          })
        : await iterator.next();
      if (signal?.aborted) throw new WireFailure('cancelled');
      if (next.done) {
        finished = true;
        if (used) throw new WireFailure('incomplete');
        return;
      }
      total += next.value.byteLength;
      if (total > MAX_RUN_BYTES) throw new WireFailure('too-large');

      for (const byte of next.value) {
        if (used === frame.length) throw new WireFailure('too-large');
        frame[used++] = byte;
        if (byte !== 10) continue;
        const lineBytes = used - lineStart;
        if (lineBytes === 1 || (lineBytes === 2 && frame[lineStart] === 13)) {
          const payload = parseFrame(frame.subarray(0, lineStart), decoder);
          used = 0;
          if (payload !== undefined) yield payload;
        }
        lineStart = used;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // An async iterator may queue return() behind a stalled next().
    if (!finished) void iterator.return?.().catch(() => {});
  }
}
