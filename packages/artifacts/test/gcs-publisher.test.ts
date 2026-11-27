import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle, type LogicalSourceBundle } from '@natcut/domain';
import { beforeAll, expect, it, vi } from 'vitest';
import { ArtifactIntegrityError, createGcsArtifactPublisher, createGcsArtifactReader } from '../src/index.ts';

let bundle: LogicalSourceBundle;
beforeAll(async () => {
  const { sheetWidthPx: width, sheetHeightPx: height } = DEVFEST_SG_V1;
  bundle = await encodeLogicalSourceBundle({
    colorEvidence: NATIVE_SRGB_EVIDENCE,
    width, height, profile: DEVFEST_SG_V1, renderVersion: 'fixture-v1', geometryVersion: 'v1',
    rgba: new Uint8Array(width * height * 4), mask: new Uint8Array(width * height),
  });
});

const generation = '9007199254740993';
function storage() {
  const send = vi.fn<typeof fetch>();
  const getRequestHeaders = vi.fn(async () => new Headers({ Authorization: 'Bearer fixture' }));
  const bucket = { name: 'artifacts', storage: {
    apiEndpoint: 'https://example.invalid', authClient: { getRequestHeaders },
  } };
  return { send, getRequestHeaders, publisher: createGcsArtifactPublisher(bucket, send), reader: createGcsArtifactReader(bucket, send) };
}

function bytesResponse(bytes: Uint8Array = bundle.bytes, headers?: HeadersInit) {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), headers ? { headers } : {});
}

it('reads a single authenticated generation at the derived path and verifies both components', async () => {
  const { reader, send } = storage();
  send.mockResolvedValueOnce(bytesResponse());
  const receipt = { descriptor: bundle.descriptor, generation };
  const verified = await reader.read(receipt);
  expect(verified.receipt).toEqual(receipt);
  expect(Buffer.from(verified.bytes).equals(bundle.bytes)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, init] = send.mock.calls[0]!;
  expect(String(url)).toBe('https://example.invalid/storage/v1/b/artifacts/o/logical%2Fv2%2F' +
    bundle.descriptor.bundleSha256 + '?alt=media&generation=' + generation);
  expect(init?.method ?? 'GET').toBe('GET');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture');
  expect(new Headers(init?.headers).get('range')).toBe('bytes=0-' + bundle.bytes.length);
});

it.each(['missing', 'encoding', 'stored encoding', 'length header', 'extra', 'short', 'range', 'status', 'generation', 'color', 'mask', 'bundle', 'nonbinary'] as const)(
  'rejects %s pinned evidence without a metadata lookup or fallback', async (variant) => {
    const { reader, send } = storage();
    const descriptor = { ...bundle.descriptor };
    const headers = new Headers();
    let bytes = bundle.bytes;
    let status = 200;
    if (variant === 'missing') status = 404;
    if (variant === 'encoding') headers.set('content-encoding', 'gzip');
    if (variant === 'stored encoding') headers.set('x-goog-stored-content-encoding', 'br');
    if (variant === 'length header') headers.set('content-length', '17');
    if (variant === 'generation') headers.set('x-goog-generation', '3');
    if (variant === 'range') { status = 206; headers.set('content-range', 'bytes 0-32/33'); }
    if (variant === 'status') status = 201;
    if (variant === 'short') bytes = bytes.subarray(1);
    if (variant === 'extra') bytes = new Uint8Array(bytes.length + 1);
    if (variant === 'color') descriptor.colorSha256 = '1'.repeat(64);
    if (variant === 'mask') descriptor.maskSha256 = '2'.repeat(64);
    if (variant === 'bundle') descriptor.bundleSha256 = '3'.repeat(64);
    if (variant === 'nonbinary') { bytes = bytes.slice(); bytes[descriptor.colorByteLength] = 1; }
    send.mockResolvedValueOnce(new Response(bytesResponse(bytes).body, { headers, status }));
    await expect(reader.read({ descriptor, generation })).rejects.toBeInstanceOf(ArtifactIntegrityError);
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([401, 403, 429, 503])('classifies HTTP %i as retryable and makes one request', async status => {
  const { reader, send } = storage();
  send.mockResolvedValueOnce(new Response(null, { status }));
  const error = await reader.read({ descriptor: bundle.descriptor, generation }).catch(cause => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ArtifactIntegrityError);
  expect(send).toHaveBeenCalledTimes(1);
});

it('rejects unregistered profiles and non-decimal generations before fetching', async () => {
  const { reader, send } = storage();
  const descriptor = bundle.descriptor;
  await expect(reader.read({ descriptor, generation: 'latest' })).rejects.toBeInstanceOf(ArtifactIntegrityError);
  await expect(reader.read({ descriptor: { ...descriptor, profile: { ...descriptor.profile, version: 72 } }, generation }))
    .rejects.toBeInstanceOf(ArtifactIntegrityError);
  expect(send).not.toHaveBeenCalled();
});

it('creates at the derived path, supplies credentials and pins the exact returned generation', async () => {
  const { publisher, send } = storage();
  send.mockResolvedValueOnce(Response.json({ generation })).mockResolvedValueOnce(bytesResponse());
  expect(await publisher.publish(bundle)).toEqual({ descriptor: bundle.descriptor, generation });
  const [[upload, options], [read, verification]] = send.mock.calls as [[URL, RequestInit], [URL, RequestInit]];
  expect(upload.pathname).toBe('/upload/storage/v1/b/artifacts/o');
  expect(Object.fromEntries(upload.searchParams)).toEqual({
    ifGenerationMatch: '0', name: 'logical/v2/' + bundle.descriptor.bundleSha256, uploadType: 'multipart', fields: 'generation',
  });
  expect(options.method).toBe('POST');
  expect(new Headers(options.headers).get('authorization')).toBe('Bearer fixture');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(decodeURIComponent(read.pathname)).toBe('/storage/v1/b/artifacts/o/logical/v2/' + bundle.descriptor.bundleSha256);
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
