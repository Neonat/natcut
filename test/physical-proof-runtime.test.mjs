import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPhysicalProofRuntime } from '../src/physical-proof-runtime.mjs';

const fingerprint = 'a'.repeat(64);
const proof = {
  summary: { approvalFingerprint: fingerprint },
  artifacts: { print: { bytes: new Uint8Array([1]) }, cut: { bytes: new Uint8Array([2]) } },
  binding: { submissionId: 'proof' },
};

test('prepares proof bytes without opening USB and refuses send when approval is disabled', async () => {
  let opens = 0;
  const runtime = createPhysicalProofRuntime({
    approvalFingerprint: undefined,
    journalPath: '/tmp/not-used.sqlite',
    buildProof: async () => proof,
    openSession: async () => { opens += 1; throw new Error('must not open'); },
  });

  assert.equal(runtime.physicalSendEnabled, false);
  assert.equal(await runtime.preparePhysicalProof(), proof);
  await assert.rejects(
    runtime.sendPhysicalProof({ approvalFingerprint: fingerprint, confirmation: 'SEND ONE SHEET' }, proof),
    /separate approval/i,
  );
  assert.equal(opens, 0);
});
test('runs one exact approved attempt and closes both journal and USB session', async () => {
  const events = [];
  const journal = { close() { events.push('journal:close'); } };
  const session = { io: {}, async close() { events.push('session:close'); } };
  const runtime = createPhysicalProofRuntime({
    approvalFingerprint: fingerprint,
    journalPath: '/tmp/proof.sqlite',
    buildProof: async () => proof,
    openSession: async () => { events.push('session:open'); return session; },
    createQcJournal: () => ({ getPhysicalAttemptEvidence: () => null, close() {} }),
    createJournal(path) { assert.equal(path, '/tmp/proof.sqlite'); events.push('journal:open'); return journal; },
    createTransport(io) { assert.equal(io, session.io); events.push('transport:create'); return {}; },
    runAttempt: async (artifacts, binding, dependencies) => {
      assert.equal(artifacts, proof.artifacts);
      assert.equal(binding, proof.binding);
      assert.equal(dependencies.journal, journal);
      events.push('attempt');
      return { kind: 'needs_reconciliation', reason: 'physical_observation_required' };
    },
  });

  assert.equal(runtime.physicalSendEnabled, true);
  assert.deepEqual(
    await runtime.sendPhysicalProof({ approvalFingerprint: fingerprint, confirmation: 'SEND ONE SHEET' }, proof),
    { kind: 'needs_reconciliation', reason: 'physical_observation_required' },
  );
  assert.deepEqual(events, [
    'journal:open', 'session:open', 'transport:create', 'attempt', 'session:close', 'journal:close',
  ]);
});
test('rejects a mismatched proof fingerprint before opening the journal or USB', async () => {
  let sideEffects = 0;
  const runtime = createPhysicalProofRuntime({
    approvalFingerprint: fingerprint,
    journalPath: '/tmp/proof.sqlite',
    openSession: async () => { sideEffects += 1; },
    createJournal: () => { sideEffects += 1; },
  });
  await assert.rejects(
    runtime.sendPhysicalProof(
      { approvalFingerprint: 'b'.repeat(64), confirmation: 'SEND ONE SHEET' },
      proof,
    ),
    /does not match/i,
  );
  assert.equal(sideEffects, 0);
});
test('the old arbitrary PNG setting cannot replace trusted diagnostic print pixels', async () => {
  const runtime = createPhysicalProofRuntime({
    proofImagePath: '/proof/printed-red-contour.png',
    readProofImage: async () => { throw new Error('untrusted image read'); },
    buildProof: async () => proof,
  });
  assert.equal(await runtime.preparePhysicalProof(), proof);
});

test('a fresh direct runtime refuses a locked journal before opening the mutation journal or USB', async () => {
  const calls = [];
  const runtime = createPhysicalProofRuntime({
    approvalFingerprint: fingerprint, journalPath: '/synthetic/locked.sqlite',
    createQcJournal() {
      return {
        getPhysicalAttemptEvidence: () => ({ outcome: { disposition: 'locked_no_resend' } }),
        close() { calls.push('evidence:close'); },
      };
    },
    createJournal() { calls.push('transport:journal'); },
    openSession() { calls.push('usb:open'); },
  });
  await assert.rejects(runtime.sendPhysicalProof({ approvalFingerprint: fingerprint, confirmation: 'SEND ONE SHEET' }, proof),
    { code: 'ATTEMPT_LOCKED' });
  assert.deepEqual(calls, ['evidence:close']);
});
