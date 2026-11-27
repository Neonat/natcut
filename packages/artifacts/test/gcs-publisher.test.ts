import { DEVFEST_SG_V1, encodeLogicalSourceBundle, type LogicalSourceBundle } from '@natcut/domain';
import { beforeAll, expect, it, vi } from 'vitest';
import { createGcsArtifactPublisher } from '../src/index.ts';

let bundle: LogicalSourceBundle;
beforeAll(async () => {
  const { sheetWidthPx: width, sheetHeightPx: height } = DEVFEST_SG_V1;
  bundle = await encodeLogicalSourceBundle({
    width, height, profile: DEVFEST_SG_V1, renderVersion: 'fixture-v1', geometryVersion: 'v1',
    rgba: new Uint8Array(width * height * 4), mask: new Uint8Array(width * height),
  });
});

const generation = '9007199254740993';
function storage() {
  const send = vi.fn<typeof fetch>();
  const getRequestHeaders = vi.fn(async () => new Headers({ Authorization: 'Bearer fixture' }));
  const publisher = createGcsArtifactPublisher({ name: 'artifacts', storage: {
    apiEndpoint: 'https://example.invalid', authClient: { getRequestHeaders },
  } }, send);
  return { send, getRequestHeaders, publisher };
}

function bytesResponse(bytes: Uint8Array = bundle.bytes, headers?: HeadersInit) {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), headers ? { headers } : {});
}

it('creates at the derived path, supplies credentials and pins the exact returned generation', async () => {
  const { publisher, send } = storage();
  send.mockResolvedValueOnce(Response.json({ generation })).mockResolvedValueOnce(bytesResponse());
  expect(await publisher.publish(bundle)).toEqual({ descriptor: bundle.descriptor, generation });
  const [[upload, options], [read, verification]] = send.mock.calls as [[URL, RequestInit], [URL, RequestInit]];
  expect(upload.pathname).toBe('/upload/storage/v1/b/artifacts/o');
  expect(Object.fromEntries(upload.searchParams)).toEqual({
    ifGenerationMatch: '0', name: 'logical/v1/' + bundle.descriptor.bundleSha256, uploadType: 'multipart', fields: 'generation',
  });
  expect(options.method).toBe('POST');
  expect(new Headers(options.headers).get('authorization')).toBe('Bearer fixture');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(decodeURIComponent(read.pathname)).toBe('/storage/v1/b/artifacts/o/logical/v1/' + bundle.descriptor.bundleSha256);
  expect(Object.fromEntries(read.searchParams)).toEqual({ alt: 'media', generation });
  expect(new Headers(verification.headers).get('range')).toBe('bytes=0-' + bundle.bytes.length);
  expect(send).toHaveBeenCalledTimes(2);
});

it.each([412, 503, 'ECONNRESET'])('resolves and verifies an existing generation after %s', async (code) => {
  const { publisher, send } = storage();
  if (typeof code === 'number') send.mockResolvedValueOnce(new Response(null, { status: code }));
  else send.mockRejectedValueOnce(new Error(code));
  send.mockResolvedValueOnce(Response.json({ generation })).mockResolvedValueOnce(bytesResponse());
  expect(await publisher.publish(bundle)).toEqual({ descriptor: bundle.descriptor, generation });
  expect(send.mock.calls.map(([url]) => new URL(String(url)).search)).toEqual([
    expect.stringContaining('ifGenerationMatch=0'), '?fields=generation', '?alt=media&generation=' + generation,
  ]);
});

it.each(['different', 'short', 'long', 'encoded'] as const)('rejects %s bytes for an existing object', async (variant) => {
  const { publisher, send } = storage();
  let bytes = bundle.bytes.slice();
  if (variant === 'short') bytes = bytes.subarray(1);
  if (variant === 'long') bytes = new Uint8Array(bytes.length + 1);
  if (variant === 'different') bytes[0] = 1;
  send.mockResolvedValueOnce(new Response(null, { status: 412 })).mockResolvedValueOnce(Response.json({ generation }))
    .mockResolvedValueOnce(bytesResponse(bytes, variant === 'encoded' ? { 'x-goog-stored-content-encoding': 'gzip' } : {}));
  await expect(publisher.publish(bundle)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(3);
});

it('fails closed on a missing pinned generation, large metadata, invalid generation, invalid input or denied creation', async () => {
  const { publisher, send } = storage();
  send.mockResolvedValueOnce(Response.json({ generation })).mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(publisher.publish(bundle)).rejects.toThrow('404');
  send.mockResolvedValueOnce(bytesResponse(new Uint8Array(1025)));
  await expect(publisher.publish(bundle)).rejects.toThrow(/length/);
  send.mockResolvedValueOnce(Response.json({ generation: '0' }));
  await expect(publisher.publish(bundle)).rejects.toThrow();
  await expect(publisher.publish({ ...bundle, bytes: new Uint8Array(1) })).rejects.toThrow();
  send.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(publisher.publish(bundle)).rejects.toThrow('403');
  expect(send).toHaveBeenCalledTimes(5);
});

it('aborts credential acquisition without starting an HTTP request', async () => {
  const { publisher, send, getRequestHeaders } = storage();
  const entered = Promise.withResolvers<void>();
  const credentials = Promise.withResolvers<Headers>();
  getRequestHeaders.mockImplementationOnce(() => { entered.resolve(); return credentials.promise; });
  const controller = new AbortController();
  const pending = publisher.publish(bundle, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled');
  credentials.resolve(new Headers());
  expect(send).not.toHaveBeenCalled();
});
