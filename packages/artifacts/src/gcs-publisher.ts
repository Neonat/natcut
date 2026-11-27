import { createHash, randomUUID } from 'node:crypto';
import { ArtifactGenerationSchema, artifactObjectPath, decodeLogicalSourceBundle } from '@natcut/domain';
import type { ArtifactPublisher } from './publisher.ts';

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
  if (!response.body) throw new Error('Missing GCS response body.');
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return offset;
      if (value.byteLength > limit - offset) throw new Error('GCS response exceeds expected byte length.');
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

async function verifyPinned(response: Response, expected: Buffer) {
  const range = response.headers.get('content-range');
  const complete = response.status === 200 ||
    (response.status === 206 && range === `bytes 0-${expected.length - 1}/${expected.length}`);
  const encoded = ['content-encoding', 'x-goog-stored-content-encoding'].some((key) => {
    const value = response.headers.get(key);
    return value !== null && value !== 'identity';
  });
  if (!complete || encoded) {
    await response.body?.cancel();
    throw new Error('Unexpected pinned object response, encoding or length.');
  }
  const length = await consume(response, expected.length, (chunk, offset) => {
    if (!expected.subarray(offset, offset + chunk.length).equals(chunk)) throw new Error('Pinned object bytes differ from verified bundle.');
  });
  if (length !== expected.length) throw new Error('Pinned object byte length mismatch.');
}

export function createGcsArtifactPublisher(bucket: GcsBucket, send: typeof fetch = fetch): ArtifactPublisher {
  return {
    async publish(bundle, { signal = AbortSignal.timeout(30_000) } = {}) {
      signal.throwIfAborted();
      const { bytes, descriptor } = await decodeLogicalSourceBundle(bundle.bytes, bundle.descriptor);
      signal.throwIfAborted();
      const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const name = artifactObjectPath(descriptor.bundleSha256);
      const bucketPath = 'storage/v1/b/' + encodeURIComponent(bucket.name) + '/o';
      const upload = new URL('/upload/' + bucketPath, bucket.storage.apiEndpoint);
      upload.search = new URLSearchParams({ uploadType: 'multipart', ifGenerationMatch: '0', name, fields: 'generation' }).toString();
      const object = new URL('/' + bucketPath + '/' + encodeURIComponent(name), bucket.storage.apiEndpoint);

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
        const lookup = new URL(object);
        lookup.search = 'fields=generation';
        result = await request(bucket, lookup, {}, signal, send);
      }
      const generation = await readGeneration(result);
      object.search = new URLSearchParams({ alt: 'media', generation }).toString();
      const verified = await request(bucket, object, { headers: {
        Range: 'bytes=0-' + data.length, 'Accept-Encoding': 'gzip', 'Cache-Control': 'no-store',
      } }, signal, send);
      await verifyPinned(verified, data);
      signal.throwIfAborted();
      return { generation, descriptor };
    },
  };
}
