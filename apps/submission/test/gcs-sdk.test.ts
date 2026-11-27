import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { createGcsArtifactPublisher, createGcsArtifactReader } from '@natcut/artifacts';
import { expect, it, vi } from 'vitest';
import { artifact, bundle } from './fixtures/artifact.ts';

it('sends the verified multipart upload, create precondition and lossless generation for an Admin storage bucket', async () => {
  const requests: string[] = [];
  let exists = false;
  const generation = artifact.generation;
  const object = 'logical/v1/' + bundle.descriptor.bundleSha256;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (request.method === 'POST' && url.searchParams.get('ifGenerationMatch') === '0' &&
      url.searchParams.get('name') === object) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const payload = Buffer.concat(chunks);
      const boundary = request.headers['content-type']?.split('boundary=')[1];
      const metadata = JSON.stringify({ name: object, contentType: 'application/octet-stream',
        md5Hash: createHash('md5').update(bundle.bytes).digest('base64') });
      const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      if (request.headers.authorization !== 'Bearer local' || !payload.subarray(0, prefix.length).equals(prefix) ||
        !payload.subarray(prefix.length, -suffix.length).equals(bundle.bytes) || !payload.subarray(-suffix.length).equals(suffix)) {
        response.writeHead(400).end();
        return;
      }
      requests.push('create');
      response.writeHead(exists ? 412 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(exists ? { error: { code: 412, message: 'exists' } } : { generation }));
      exists = true;
    } else if (request.method === 'GET' && decodeURIComponent(url.pathname).endsWith('/o/' + object)) {
      if (url.searchParams.get('alt') === 'media' && url.searchParams.get('generation') === generation &&
        request.headers.range === 'bytes=0-' + bundle.bytes.length) {
        requests.push('pinned read');
        response.writeHead(206, { 'Content-Range': `bytes 0-${bundle.bytes.length - 1}/${bundle.bytes.length}` });
        response.end(bundle.bytes);
      } else if (!url.searchParams.has('alt')) {
        requests.push('lookup');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ generation }));
      } else {
        response.writeHead(400).end();
      }
    } else {
      response.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
  vi.stubEnv('STORAGE_EMULATOR_HOST', 'http://127.0.0.1:' + address.port);
  const admin = initializeApp({ projectId: 'demo-natcut' }, 'storage-wire-test');
  try {
    const bucket = getStorage(admin).bucket('test-artifacts');
    vi.spyOn(bucket.storage.authClient, 'getRequestHeaders').mockResolvedValue(new Headers({ Authorization: 'Bearer local' }));
    const publisher = createGcsArtifactPublisher(bucket);
    expect(await publisher.publish(bundle)).toEqual(artifact);
    expect(await publisher.publish(bundle)).toEqual(artifact);
    expect(requests).toEqual(['create', 'pinned read', 'create', 'lookup', 'pinned read']);
  } finally {
    vi.unstubAllEnvs();
    await deleteApp(admin);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(['upload', 'metadata', 'media', 'worker media headers', 'worker media body'])('closes a stalled %s socket on cancellation', async (phase) => {
  const entered = Promise.withResolvers<void>();
  const receivedHeaders = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    const step = request.method === 'POST' ? 'upload' : request.url?.includes('alt=media') ? 'media' : 'metadata';
    request.resume();
    if (step === phase || phase.startsWith('worker media')) {
      if (phase === 'worker media body') response.write(Buffer.alloc(8));
      request.socket.once('close', () => closed.resolve());
      entered.resolve();
      return; // Intentionally leave the connection open, including response headers.
    }
    response.writeHead(step === 'upload' && phase === 'metadata' ? 412 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ generation: artifact.generation }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
  vi.stubEnv('STORAGE_EMULATOR_HOST', 'http://127.0.0.1:' + address.port);
  const admin = initializeApp({ projectId: 'demo-natcut' }, 'abort-' + phase);
  try {
    const bucket = getStorage(admin).bucket('test-artifacts');
    vi.spyOn(bucket.storage.authClient, 'getRequestHeaders').mockResolvedValue(new Headers({ Authorization: 'Bearer local' }));
    const controller = new AbortController();
    const completion = phase.startsWith('worker media')
      ? createGcsArtifactReader(bucket, async (...args) => {
        const response = await fetch(...args);
        receivedHeaders.resolve();
        return response;
      }).read(artifact, { signal: controller.signal })
      : createGcsArtifactPublisher(bucket).publish(bundle, { signal: controller.signal });
    const result = completion.then(() => 'accepted', () => 'aborted');
    await entered.promise;
    if (phase === 'worker media body') await receivedHeaders.promise;
    controller.abort();
    expect(await Promise.race([Promise.all([result, closed.promise]), delay(600, 'still open')])).toEqual(['aborted', undefined]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await deleteApp(admin);
  }
});
