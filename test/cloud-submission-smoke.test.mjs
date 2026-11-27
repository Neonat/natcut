import assert from 'node:assert/strict';
import test from 'node:test';
import { manifestHash } from '@natcut/domain';

import { artifact, bundle, submissionInput } from '../apps/submission/test/fixtures/artifact.ts';
import {
  runSubmissionSmoke,
  validateSubmissionSmokeArguments,
} from '../scripts/cloud-submission-smoke.ts';

const manifest = submissionInput('unused').manifest;

async function acceptedRecord(idempotencyKey, overrides = {}) {
  const input = submissionInput(idempotencyKey);
  return {
    ...input,
    id: 'cloud-smoke-1',
    recordVersion: 2,
    publicStatus: 'queued',
    queueNumber: 6,
    jobsAhead: 0,
    cancelledAt: null,
    updatedAt: input.acceptedAt,
    manifestHash: await manifestHash(input.manifest),
    ...overrides,
  };
}

function memoryAttemptStore(initial = null) {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => { value = structuredClone(next); },
    value: () => value,
  };
}

test('rejects target overrides and requires a Firebase public API key', () => {
  assert.doesNotThrow(() => validateSubmissionSmokeArguments([], { NATCUT_FIREBASE_API_KEY: 'public-key' }));
  assert.throws(() => validateSubmissionSmokeArguments(['--url', 'https://other.example'], {
    NATCUT_FIREBASE_API_KEY: 'public-key',
  }), /does not accept arguments/);
  assert.throws(() => validateSubmissionSmokeArguments([], {}), /NATCUT_FIREBASE_API_KEY/);
});

test('uses fixed NatCut endpoints, a fresh key, and verifies its immutable V2 receipt bytes', async () => {
  const calls = [];
  let inspectedId;
  const attemptStore = memoryAttemptStore();
  const request = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=public-key') {
      assert.equal(init.method, 'POST');
      return Response.json({ idToken: 'visitor-token', localId: 'visitor-one' });
    }
    if (url === 'https://natcut.web.app/api/v1/submissions') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer visitor-token');
      const body = JSON.parse(String(init.body));
      assert.equal(body.idempotencyKey, 'cloud-smoke-fixed-nonce');
      assert.deepEqual(body.manifest, manifest);
      return Response.json({
        submissionId: 'cloud-smoke-1', queueNumber: 6, jobsAhead: 0,
        publicStatus: 'queued', statusToken: 'not-returned-by-smoke',
      }, { status: 201 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await runSubmissionSmoke({
    apiKey: 'public-key',
    manifest,
    request,
    uuid: () => 'fixed-nonce',
    verifyApiKey: async (key) => assert.equal(key, 'public-key'),
    attemptStore,
    recoverAcceptedAttempt: async () => { throw new Error('unexpected recovery'); },
    inspectSubmission: async (id) => {
      inspectedId = id;
      return acceptedRecord('cloud-smoke-fixed-nonce');
    },
    readArtifact: async (receipt) => {
      assert.deepEqual(receipt, artifact);
      return bundle.bytes;
    },
  });

  assert.equal(inspectedId, 'cloud-smoke-1');
  assert.deepEqual(calls, [
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=public-key',
    'https://natcut.web.app/api/v1/submissions',
  ]);
  assert.deepEqual(result, {
    submissionId: 'cloud-smoke-1',
    queueNumber: 6,
    publicStatus: 'queued',
    idempotencyKey: 'cloud-smoke-fixed-nonce',
    ownerUid: 'visitor-one',
    eventId: 'devfest-sg',
    objectName: `logical/v1/${artifact.descriptor.bundleSha256}`,
    generation: artifact.generation,
    bundleSha256: artifact.descriptor.bundleSha256,
    profileId: artifact.descriptor.profile.id,
    profileVersion: artifact.descriptor.profile.version,
  });
  assert.equal(attemptStore.value().state, 'verified');
  assert.equal(JSON.stringify(attemptStore.value()).includes('visitor-token'), false);
});

test('stops when the stored artifact generation differs from the accepted API evidence', async () => {
  const attemptStore = memoryAttemptStore();
  await assert.rejects(() => runSubmissionSmoke({
    apiKey: 'public-key',
    manifest,
    uuid: () => 'mismatch',
    verifyApiKey: async () => {},
    attemptStore,
    recoverAcceptedAttempt: async () => null,
    request: async (input) => String(input).includes('accounts:signUp')
      ? Response.json({ idToken: 'visitor-token', localId: 'visitor-one' })
      : Response.json({ submissionId: 'cloud-smoke-1', queueNumber: 6, jobsAhead: 0, publicStatus: 'queued', statusToken: 'x' }, { status: 201 }),
    inspectSubmission: async () => acceptedRecord('cloud-smoke-mismatch', {
      artifact: { ...artifact, generation: '9007199254740994' },
    }),
    readArtifact: async (receipt) => {
      if (receipt.generation !== artifact.generation) throw new Error('artifact generation mismatch');
      return bundle.bytes;
    },
  }), /generation|artifact/i);
});

test('rejects a foreign Firebase API key before signup or submission', async () => {
  let requests = 0;
  await assert.rejects(() => runSubmissionSmoke({
    apiKey: 'foreign-key',
    manifest,
    request: async () => { requests += 1; throw new Error('network must stay unused'); },
    verifyApiKey: async () => { throw new Error('Firebase API key does not belong to the NatCut web app.'); },
    attemptStore: memoryAttemptStore(),
    recoverAcceptedAttempt: async () => null,
    inspectSubmission: async () => { throw new Error('unexpected inspection'); },
    readArtifact: async () => { throw new Error('unexpected read'); },
  }), /does not belong/);
  assert.equal(requests, 0);
});

test('rejects a stored manifest hash that is not the canonical requested design', async () => {
  await assert.rejects(() => runSubmissionSmoke({
    apiKey: 'public-key',
    manifest,
    uuid: () => 'wrong-manifest',
    verifyApiKey: async () => {},
    attemptStore: memoryAttemptStore(),
    recoverAcceptedAttempt: async () => null,
    request: async (input) => String(input).includes('accounts:signUp')
      ? Response.json({ idToken: 'visitor-token', localId: 'visitor-one' })
      : Response.json({ submissionId: 'cloud-smoke-1', queueNumber: 6, jobsAhead: 0, publicStatus: 'queued', statusToken: 'x' }, { status: 201 }),
    inspectSubmission: async () => acceptedRecord('cloud-smoke-wrong-manifest', { manifestHash: 'a'.repeat(64) }),
    readArtifact: async () => bundle.bytes,
  }), /manifest/i);
});

test('recovers a committed submission after a lost response without creating another ticket or storing a bearer token', async () => {
  const attemptStore = memoryAttemptStore();
  let signupCount = 0;
  let submitCount = 0;
  const request = async (input) => {
    if (String(input).includes('accounts:signUp')) {
      signupCount += 1;
      return Response.json({ idToken: 'visitor-token', localId: 'visitor-one' });
    }
    submitCount += 1;
    throw new TypeError('response lost after commit');
  };
  const common = {
    apiKey: 'public-key', manifest, request, uuid: () => 'lost-response',
    verifyApiKey: async () => {}, attemptStore,
    inspectSubmission: async () => acceptedRecord('cloud-smoke-lost-response'),
    readArtifact: async () => bundle.bytes,
  };

  await assert.rejects(() => runSubmissionSmoke({ ...common, recoverAcceptedAttempt: async () => null }), /response lost/);
  assert.equal(attemptStore.value().state, 'authenticated');
  assert.equal(JSON.stringify(attemptStore.value()).includes('visitor-token'), false);

  const result = await runSubmissionSmoke({
    ...common,
    recoverAcceptedAttempt: async (attempt) => {
      assert.equal(attempt.ownerUid, 'visitor-one');
      assert.equal(attempt.idempotencyKey, 'cloud-smoke-lost-response');
      return { submissionId: 'cloud-smoke-1', queueNumber: 6, publicStatus: 'queued' };
    },
  });
  assert.equal(result.submissionId, 'cloud-smoke-1');
  assert.equal(signupCount, 1);
  assert.equal(submitCount, 1);
});
