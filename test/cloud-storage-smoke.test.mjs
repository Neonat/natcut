import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runStorageSmoke,
  validateStorageSmokeArguments,
} from '../scripts/cloud-storage-smoke.mjs';

const bucket = 'sprout-dev-66f08-natcut-artifacts';
const objectName = 'smoke/v1/15caa08c0d713a94ee7e5143d5e715444af420421f7e6d83fd4b7bfdfea6e5af';
const bytes = new TextEncoder().encode('{"natcut":"storage-smoke"}\n');

function response(body, init = {}) {
  return new Response(body, { status: 200, ...init });
}

function exactGcs(options = {}) {
  const calls = [];
  let createCount = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const authorization = new Headers(init.headers).get('authorization');
    calls.push({ url: url.href, method: init.method ?? 'GET', authorization });

    if (url.hostname === 'storage.googleapis.com' && url.pathname === `/upload/storage/v1/b/${bucket}/o`) {
      assert.equal(authorization, 'Bearer submission-token');
      assert.equal(url.searchParams.get('uploadType'), 'media');
      assert.equal(url.searchParams.get('name'), objectName);
      assert.equal(url.searchParams.get('ifGenerationMatch'), '0');
      createCount += 1;
      if (createCount === 2 && options.duplicateAccepted !== true) {
        return response(JSON.stringify({ error: { code: 412 } }), { status: 412 });
      }
      return response(JSON.stringify({
        bucket,
        name: objectName,
        generation: options.generation ?? '9007199254740993',
        size: String(bytes.byteLength),
      }), { headers: { 'content-type': 'application/json' } });
    }

    if (url.hostname === 'storage.googleapis.com' &&
      url.pathname === `/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`) {
      assert.equal(url.searchParams.get('alt'), 'media');
      assert.equal(url.searchParams.get('generation'), '9007199254740993');
      assert.ok(['Bearer submission-token', 'Bearer worker-token'].includes(authorization));
      const payload = options.corruptRead === authorization ? new Uint8Array([0]) : bytes;
      return response(payload);
    }

    return response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
  };
  return { fetch, calls };
}

test('rejects all target overrides before requesting credentials', () => {
  assert.doesNotThrow(() => validateStorageSmokeArguments([]));
  assert.throws(() => validateStorageSmokeArguments(['--bucket', 'other']), /does not accept arguments/);
});

test('creates once and reads the exact generation as submission and worker identities', async () => {
  const gcs = exactGcs();
  const result = await runStorageSmoke({
    bytes,
    objectName,
    fetch: gcs.fetch,
    accessToken: async (identity) => identity.includes('natcut-submission') ? 'submission-token' : 'worker-token',
  });

  assert.deepEqual(result, {
    bucket,
    objectName,
    generation: '9007199254740993',
    size: bytes.byteLength,
    sha256: '15caa08c0d713a94ee7e5143d5e715444af420421f7e6d83fd4b7bfdfea6e5af',
    readers: ['natcut-submission', 'natcut-worker'],
  });
  assert.equal(gcs.calls.length, 4);
});

test('rejects an upload response for a different generation shape', async () => {
  const gcs = exactGcs({ generation: 'not-decimal' });
  await assert.rejects(() => runStorageSmoke({
    bytes,
    objectName,
    fetch: gcs.fetch,
    accessToken: async () => 'submission-token',
  }), /decimal generation/);
});

test('requires duplicate creation to fail with the precondition', async () => {
  const gcs = exactGcs({ duplicateAccepted: true });
  await assert.rejects(() => runStorageSmoke({
    bytes,
    objectName,
    fetch: gcs.fetch,
    accessToken: async () => 'submission-token',
  }), /duplicate create unexpectedly succeeded/);
});

test('rejects bytes that differ on an exact-generation identity read', async () => {
  const gcs = exactGcs({ corruptRead: 'Bearer worker-token' });
  await assert.rejects(() => runStorageSmoke({
    bytes,
    objectName,
    fetch: gcs.fetch,
    accessToken: async (identity) => identity.includes('natcut-submission') ? 'submission-token' : 'worker-token',
  }), /natcut-worker read returned different bytes/);
});
