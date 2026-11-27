import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildPhysicalProof } from '../packages/printer/src/physical-proof.ts';
import { SqliteTransportAttemptJournal } from '@natcut/printer/transport-attempt';

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
  const exactProof = await buildPhysicalProof();
  const approvalFingerprint = exactProof.summary.approvalFingerprint;
  const events = [];
  const journal = {
    reserve() { events.push('reserve'); return true; },
    markReconciliation(_submission, _hash, reason) { events.push(reason); },
    close() { events.push('journal:close'); },
  };
  const session = { io: {}, async close() { events.push('session:close'); } };
  const runtime = createPhysicalProofRuntime({
    approvalFingerprint,
    journalPath: '/synthetic/proof.sqlite',
    openSession: async () => { events.push('session:open'); return session; },
    createQcJournal: () => ({ getPhysicalAttemptEvidence: () => null, close() {} }),
    createJournal(path) { assert.equal(path, '/synthetic/proof.sqlite'); events.push('journal:open'); return journal; },
    createTransport(io) {
      assert.equal(io, session.io);
      events.push('transport:create');
      return { async declareCombo() { events.push('declare'); return {}; } };
    },
  });

  assert.equal(runtime.physicalSendEnabled, true);
  assert.deepEqual(
    await runtime.sendPhysicalProof({ approvalFingerprint, confirmation: 'SEND ONE SHEET' }, exactProof),
    { kind: 'needs_reconciliation', reason: 'printer_job_id_invalid' },
  );
  assert.deepEqual(events, [
    'journal:open', 'reserve', 'session:open', 'transport:create', 'declare', 'printer_job_id_invalid', 'session:close', 'journal:close',
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

for (const [other, preferredWinner] of [['direct', null], ['browser', 'browser'], ['browser', 'direct']]) {
  const order = preferredWinner ? ' with ' + preferredWinner + ' reserving first' : '';
  test('only the reservation owner can reach transport in a direct versus ' + other + ' race' + order, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'natcut-reservation-race-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const journalPath = join(directory, 'synthetic.sqlite');
    new SqliteTransportAttemptJournal(journalPath).close();
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const compete = async mode => {
      const worker = new Worker(new URL('./fixtures/physical-reservation-racer.mjs', import.meta.url), {
        workerData: { mode, journalPath, gate, preferredWinner },
      });
      t.after(() => worker.terminate());
      return (await once(worker, 'message'))[0];
    };
    const contenders = await Promise.all([compete('direct'), compete(other)]);
    assert.equal(contenders.filter(item => item.reserved).length, 1);
    const winner = contenders.find(item => item.reserved);
    if (preferredWinner) assert.equal(winner.mode, preferredWinner);
    const loser = contenders.find(item => !item.reserved);
    assert.deepEqual(loser.hardware, []);
    assert.equal(loser.code, 'ATTEMPT_ALREADY_STARTED');
    assert.deepEqual(winner.hardware, winner.mode === 'direct'
      ? ['open', 'create', 'declare'].map(call => ({ call, reserved: true })) : []);
  });
}
