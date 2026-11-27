import { crc32 } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { readSproutRun } from '@natcut/pipeline';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPguRTQAMIMMAYAOtYGucH+emcAAAAASUVORK5CYII=';
const url = 'https://cdn.example.test/fern/v3.png';
const render = { event: 'step_done', step: '2b', status: 'success', renderSource: 'model', rawSpriteB64: 'intermediate' };
const cutout = { event: 'step_done', step: '2c', status: 'success', removeBgOk: true, finishedSpriteB64: 'intermediate' };
const plant = { name: 'Asplénium', spriteUrl: 'data:image/png;base64,' + png, taxonomy: {}, moves: [] };
const fresh = {
  event: 'complete', finalPlant: plant, finalSpriteB64: png, totalTimeMs: 123,
  avatarId: 'private-avatar', saved: true, discovery: { firstDiscoveredByName: 'Private' }, candidate: null,
};
const cached = { event: 'complete', finalPlant: { ...plant, spriteUrl: url }, spriteReused: true, finalSpriteUrl: url };
const generated = { kind: 'generated', plantName: 'Asplénium', totalTimeMs: 123, pngBase64: png };

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

function run(...events: unknown[]) {
  return readSproutRun(chunks(events.map(frame).join('')));
}

describe('Sprout POST /api/pipeline/run-stream', () => {
  it('returns only the finished PNG and plant label from a fresh scan', async () => {
    expect(await run(
      { event: 'step_start', step: '1' },
      { event: 'step_done', step: '2a', prompt: 'private prompt' },
      render, cutout, { event: 'step_done', step: '2d', finishedSpriteB64: 'intermediate' }, fresh,
    )).toEqual(generated);
  });

  it('preserves a cached URL as an untrusted reference and omits absent timing', async () => {
    expect(await run(
      { event: 'sprite_cache_hit', step: '2a', spriteUrl: url, speciesKey: 'fern' },
      { event: 'step_done', step: '3', spriteReused: true }, cached,
    )).toEqual({ kind: 'cached-reference', plantName: 'Asplénium', untrustedUrl: url });
  });

  it.each([
    [{ event: 'needs_name', step: '1', error: 'No plant identified' }, 'needs-name'],
    [{ event: 'low_confidence', step: '1', error: 'Uncertain', name: 'Fern', probability: 0.22, threshold: 0.5 }, 'low-confidence'],
    [{ event: 'error', step: '1', reason: 'invalid_image', error: 'private diagnostic' }, 'upstream-error'],
    [{ event: 'pipeline_error', error: 'private diagnostic' }, 'upstream-error'],
  ])('maps $event to the public fallback reason', async (event, reason) => {
    expect(await run(event)).toEqual({ kind: 'fallback', reason });
  });

  it('accepts bytewise UTF-8, CRLF delimiters, comments, and multiline SSE data', async () => {
    const wire = ': keepalive\n\n' + frame(render) + frame(cutout) +
      frame(fresh).replace(',"finalPlant"', ',\ndata: "finalPlant"');
    const bytes = Buffer.from(wire.replaceAll('\n', '\r\n'));
    async function* bytewise() {
      for (const byte of bytes) yield Uint8Array.of(byte);
    }
    expect(await readSproutRun(bytewise())).toEqual(generated);
  });

  it('requires the terminal and its blank-line delimiter', async () => {
    for (const wire of ['', frame(render), frame(render) + frame(cutout), frame(cached).trimEnd(), frame(cached) + 'data: {']) {
      expect(await readSproutRun(chunks(wire))).toEqual({ kind: 'fallback', reason: 'incomplete' });
    }
    expect(await run(render, { event: 'awaiting_stage2c_confirmation' })).toEqual({ kind: 'fallback', reason: 'incomplete' });
  });

  it('reports a source failure after a complete frame', async () => {
    async function* interrupted() {
      yield Buffer.from(frame(cached));
      throw new Error('private transport details');
    }
    expect(await readSproutRun(interrupted())).toEqual({ kind: 'fallback', reason: 'upstream-error' });
  });

  it('skips opening the source when already cancelled', async () => {
    const open = vi.fn(() => chunks(frame(cached)));
    expect(await readSproutRun({ [Symbol.asyncIterator]: open }, AbortSignal.abort())).toEqual({ kind: 'fallback', reason: 'cancelled' });
    expect(open).not.toHaveBeenCalled();
  });

  it('cancels a pending read and closes the iterator even if cleanup stalls', async () => {
    const started = Promise.withResolvers<void>();
    const stalled = new Promise<IteratorResult<Uint8Array>>(() => {});
    const close = vi.fn(() => stalled);
    const source = { [Symbol.asyncIterator]: () => ({
      next() { started.resolve(); return stalled; }, return: close,
    }) };
    const controller = new AbortController();
    const result = readSproutRun(source, controller.signal);
    await started.promise;
    controller.abort();
    expect(await result).toEqual({ kind: 'fallback', reason: 'cancelled' });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    [cached, cached],
    [{ event: 'needs_name', error: 'No plant' }, cached],
    [render, cutout, fresh, fresh],
    [render, cutout, fresh, { event: 'pipeline_error', error: 'Late failure' }],
  ])('rejects repeated or conflicting terminals', async (...terminals) => {
    expect(await run(...terminals)).toEqual({ kind: 'fallback', reason: 'malformed' });
  });

  it.each([
    { ...fresh, finalSpriteUrl: url }, { ...fresh, spriteReused: true },
    { ...fresh, totalTimeMs: -1 }, { ...fresh, totalTimeMs: '123' },
    { ...fresh, finalPlant: null }, { ...fresh, finalPlant: { name: ['Fern'] } },
    { ...fresh, finalPlant: { name: '<b>Fern</b>' } }, { ...fresh, finalPlant: { name: 'F\u202eern' } },
    { ...fresh, finalPlant: { name: 'x'.repeat(129) } },
    { event: 'error', error: {} },
  ])('rejects malformed terminal fields', async event => {
    expect(await run(render, cutout, event)).toEqual({ kind: 'fallback', reason: 'malformed' });
  });

  it.each([
    { ...cached, spriteReused: 'true' }, { ...cached, finalSpriteB64: png },
    { event: 'complete', finalPlant: plant, finalSpriteUrl: url },
  ])('requires the cache flag and excludes mixed output', async event => {
    expect(await run(event)).toEqual({ kind: 'fallback', reason: 'malformed' });
  });

  it('rejects a cached terminal after fresh generation stages', async () => {
    expect(await run(render, cutout, cached)).toEqual({ kind: 'fallback', reason: 'malformed' });
  });

  it.each(['sprite/catalog-id', 'javascript:alert(0)', 'https://user:pass@cdn.example.test/fern', 'https://cdn.example.test/\nfern'])(
    'rejects an invalid cached reference', async finalSpriteUrl => {
      expect(await run({ ...cached, finalSpriteUrl })).toEqual({ kind: 'fallback', reason: 'malformed' });
    },
  );

  it.each([
    [{ ...render, renderSource: 'placeholder', status: 'warn' }, cutout],
    [{ ...render, renderSource: 'photoCrop' }, cutout],
    [{ ...render, status: 'warn' }, cutout],
    [render, { ...cutout, removeBgOk: false }],
    [render, { ...cutout, status: 'warn' }],
    [render, { ...cutout, removeBgOk: 'true' }],
  ])('requires successful model render and cutout evidence', async (rendered, cut) => {
    expect(await run(rendered, cut, fresh)).toEqual({ kind: 'fallback', reason: 'degraded' });
  });

  it('requires both stages and the output on the complete frame', async () => {
    for (const events of [[fresh], [cutout, fresh], [render, fresh], [render, cutout, { event: 'complete', finalPlant: plant }]]) {
      expect(await run(...events)).toEqual({ kind: 'fallback', reason: 'incomplete' });
    }
  });

  it('rejects invalid JSON, UTF-8 and event envelopes', async () => {
    for (const wire of ['data: {\n\n', frame(null), frame([]), frame({}), Buffer.from([100,97,116,97,58,255,10,10])]) {
      expect(await readSproutRun(chunks(wire))).toEqual({ kind: 'fallback', reason: 'malformed' });
    }
  });

  it('rejects invalid base64, other formats and corrupt PNGs', async () => {
    const bytes = Buffer.from(png, 'base64');
    const brokenPixels = Buffer.from(bytes);
    const idat = brokenPixels.indexOf('IDAT');
    brokenPixels[idat + 4] = 0;
    const end = idat + 4 + brokenPixels.readUInt32BE(idat - 4);
    brokenPixels.writeUInt32BE(crc32(brokenPixels.subarray(idat, end)), end);
    for (const finalSpriteB64 of [
      '', 1, png + '!', png.slice(0, -1), Buffer.from('text').toString('base64'),
      bytes.subarray(0, 8).toString('base64'), bytes.subarray(0, -12).toString('base64'),
      brokenPixels.toString('base64'),
    ]) {
      expect(await run(render, cutout, { ...fresh, finalSpriteB64 })).toEqual({ kind: 'fallback', reason: 'malformed' });
    }
  });

  it('bounds an unterminated frame, the aggregate body, final bytes, and decoded pixels', async () => {
    const megabyte = 1024 * 1024;
    const block = Buffer.alloc(megabyte, 97);
    expect(await readSproutRun(chunks(block, block, block, block, 'a'))).toEqual({ kind: 'fallback', reason: 'too-large' });

    const comment = Buffer.from(':' + 'a'.repeat(megabyte - 3) + '\n\n');
    async function* oversizedRun() {
      for (let i = 0; i < 16; i++) yield comment;
      yield Buffer.from(frame(cached));
    }
    expect(await readSproutRun(oversizedRun())).toEqual({ kind: 'fallback', reason: 'too-large' });
    const bigImage = Buffer.from(png, 'base64');
    bigImage.writeUInt32BE(1025, 16);
    bigImage.writeUInt32BE(1024, 20);
    bigImage.writeUInt32BE(crc32(bigImage.subarray(12, 29)), 29);
    for (const finalSpriteB64 of [Buffer.alloc(megabyte + 1).toString('base64'), bigImage.toString('base64')]) {
      expect(await run(render, cutout, { ...fresh, finalSpriteB64 })).toEqual({ kind: 'fallback', reason: 'too-large' });
    }
  });
});
