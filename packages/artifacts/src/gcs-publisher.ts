import { createHash, randomUUID } from 'node:crypto';
import { ArtifactGenerationSchema, artifactObjectPath, decodeLogicalSourceBundle, type ArtifactReceipt } from '@natcut/domain';
import type { ArtifactPublisher } from './publisher.ts';
import { ArtifactIntegrityError, parseArtifactReceipt, verifyArtifactBytes, type ArtifactReader } from './reader.ts';

export const NATCUT_ARTIFACT_BUCKET = 'sprout-dev-66f08-natcut-artifacts';

interface GcsBucket {
  name: string;
  storage: {
    apiEndpoint: string;
    authClient: { getRequestHeaders(url: URL): Promise<Headers> };
  };
}

const requestTimeoutMs = 15_000;
class StorageHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('GCS request failed with status ' + status);
    this.status = status;
  }
}

// The storage SDK's teeny-request transport drops AbortSignal before calling
// node-fetch. Use the Admin bucket's credential and endpoint with native fetch
// so cancellation closes the socket even while waiting for response headers.
async function request(bucket: GcsBucket, url: URL, init: RequestInit, publication: AbortSignal, send: typeof fetch) {
  const signal = AbortSignal.any([publication, AbortSignal.timeout(requestTimeoutMs)]);
  signal.throwIfAborted();
  const abort = Promise.withResolvers<never>();
  const onAbort = () => abort.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const credentials = await Promise.race([bucket.storage.authClient.getRequestHeaders(url), abort.promise]);
    signal.throwIfAborted();
    const headers = new Headers(credentials);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const response = await send(url, { ...init, headers, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new StorageHttpError(response.status);
    }
    return response;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function consume(response: Response, limit: number, visit: (bytes: Uint8Array, offset: number) => void) {
  if (!response.body) throw new ArtifactIntegrityError('Missing GCS response body.');
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return offset;
      if (value.byteLength > limit - offset) throw new ArtifactIntegrityError('GCS response exceeds expected byte length.');
      visit(value, offset);
      offset += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

async function readGeneration(response: Response): Promise<string> {
  const json = Buffer.alloc(1024); // Both metadata requests ask only for the decimal generation.
  const length = await consume(response, json.length, (chunk, offset) => json.set(chunk, offset));
  return ArtifactGenerationSchema.parse(JSON.parse(json.toString('utf8', 0, length))?.generation);
}

function bucketPath(bucket: GcsBucket) {
  return 'storage/v1/b/' + encodeURIComponent(bucket.name) + '/o';
}

function objectUrl(bucket: GcsBucket, name: string) {
  return new URL('/' + bucketPath(bucket) + '/' + encodeURIComponent(name), bucket.storage.apiEndpoint);
}

async function readPinned(
  bucket: GcsBucket, receipt: ArtifactReceipt, signal: AbortSignal, send: typeof fetch,
  visit: (chunk: Uint8Array, offset: number) => void,
) {
  const { generation, descriptor } = receipt;
  const { byteLength } = descriptor;
  const object = objectUrl(bucket, artifactObjectPath(descriptor.bundleSha256));
  object.search = new URLSearchParams({ alt: 'media', generation }).toString();
  let response: Response;
  try {
    response = await request(bucket, object, { headers: {
      Range: 'bytes=0-' + byteLength, 'Accept-Encoding': 'gzip', 'Cache-Control': 'no-store',
    } }, signal, send);
  } catch (error) {
    if (error instanceof StorageHttpError && [404, 410, 416].includes(error.status)) {
      throw new ArtifactIntegrityError(error.message, { cause: error });
    }
    throw error;
  }
  const range = response.headers.get('content-range');
  const complete = (response.status === 200 && range === null) ||
    (response.status === 206 && range === `bytes 0-${byteLength - 1}/${byteLength}`);
  const encoded = ['content-encoding', 'x-goog-stored-content-encoding'].some((key) => {
    const value = response.headers.get(key);
    return value !== null && value !== 'identity';
  });
  const lengthHeader = response.headers.get('content-length');
  const observedGeneration = response.headers.get('x-goog-generation');
  if (!complete || encoded || (lengthHeader !== null && lengthHeader !== String(byteLength)) ||
      (observedGeneration !== null && observedGeneration !== generation)) {
    await response.body?.cancel();
    throw new ArtifactIntegrityError('Unexpected pinned object response, generation, encoding or length.');
  }
  const length = await consume(response, byteLength, visit);
  if (length !== byteLength) throw new ArtifactIntegrityError('Pinned object byte length mismatch.');
}

export function createGcsArtifactReader(bucket: GcsBucket, send: typeof fetch = fetch): ArtifactReader {
  return {
    async read(input, { signal = AbortSignal.timeout(requestTimeoutMs) } = {}) {
      signal.throwIfAborted();
      const receipt = parseArtifactReceipt(input);
      const bytes = new Uint8Array(receipt.descriptor.byteLength);
      await readPinned(bucket, receipt, signal, send, (chunk, offset) => bytes.set(chunk, offset));
      const verified = await verifyArtifactBytes(bytes, receipt);
      signal.throwIfAborted();
      return verified;
    },
  };
}

export function createGcsArtifactPublisher(bucket: GcsBucket, send: typeof fetch = fetch): ArtifactPublisher {
  return {
    async publish(bundle, { signal = AbortSignal.timeout(30_000) } = {}) {
      signal.throwIfAborted();
      const { bytes, descriptor } = await decodeLogicalSourceBundle(bundle.bytes, bundle.descriptor);
      signal.throwIfAborted();
      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const name = artifactObjectPath(descriptor.bundleSha256);
      const upload = new URL('/upload/' + bucketPath(bucket), bucket.storage.apiEndpoint);
      upload.search = new URLSearchParams({ uploadType: 'multipart', ifGenerationMatch: '0', name, fields: 'generation' }).toString();

      // GCS verifies md5Hash before it installs a multipart upload. A damaged
      // upload therefore cannot occupy this create-only content address.
      const boundary = 'natcut-' + randomUUID();
      const metadata = JSON.stringify({ name, contentType: 'application/octet-stream', md5Hash: createHash('md5').update(data).digest('base64') });
      const body = new Blob([`--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`, bytes, `\r\n--${boundary}--\r\n`]);
      let result: Response;
      try {
        result = await request(bucket, upload, {
          method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
        }, signal, send);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof StorageHttpError && ![408, 412, 429].includes(error.status) && error.status < 500) throw error;
        const lookup = objectUrl(bucket, name);
        lookup.search = 'fields=generation';
        result = await request(bucket, lookup, {}, signal, send);
      }
      const generation = await readGeneration(result);
      await readPinned(bucket, { descriptor, generation }, signal, send, (chunk, offset) => {
        if (!data.subarray(offset, offset + chunk.length).equals(chunk)) {
          throw new ArtifactIntegrityError('Pinned object bytes differ from verified bundle.');
        }
      });
      signal.throwIfAborted();
      return { generation, descriptor };
    },
  };
}
