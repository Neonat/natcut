import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { buildPhysicalProof } from '../packages/printer/src/physical-proof.ts';
import { createBrowserPhysicalCoordinator } from '../src/browser-physical-coordinator.mjs';

let proof;
before(async () => { proof = await buildPhysicalProof(); });

function journalDouble(events) {
  return {
    reserve(_evidence, _hash) { events.push('reserve'); return true; },
    recordPrinterJobId(_submission, _hash, jobId) { events.push(`job:${jobId}`); },
    recordFrameIntent(_submission, _hash, sequence, kind, index) { events.push(`pending:${sequence}:${kind}:${index}`); },
    recordFrameAcknowledged(_submission, _hash, sequence) { events.push(`ack:${sequence}`); },
    markReconciliation(_submission, _hash, reason) { events.push(`hold:${reason}`); },
    close() { events.push('close'); },
  };
}

test('checkpoints one browser-owned declaration and every frame before completing on observation hold', async () => {
  const events = [];
  const coordinator = createBrowserPhysicalCoordinator({
    approvalFingerprint: proof.summary.approvalFingerprint,
    journalPath: '/tmp/browser-proof.sqlite',
    createJournal: () => journalDouble(events),
  });
  const approval = { approvalFingerprint: proof.summary.approvalFingerprint, confirmation: 'SEND ONE SHEET' };
  const begun = coordinator.begin(approval, proof);
  assert.equal(begun.declaration.method, 'combo-job');
  assert.ok(begun.totalFrames > 2);
  assert.deepEqual(events, ['reserve']);

  coordinator.recordJobId({ attemptId: begun.attemptId, jobId: 91 });
  assert.deepEqual(events, ['reserve', 'job:91']);
  for (let sequence = 0; sequence < begun.totalFrames; sequence += 1) {
    const next = coordinator.nextFrame({ attemptId: begun.attemptId, sequence });
    assert.equal(next.sequence, sequence);
    assert.match(next.kind, /^(plt|jpeg)$/);
    assert.ok(next.frame instanceof Uint8Array);
    assert.match(events.at(-1), new RegExp(`^pending:${sequence}:`));
    coordinator.acknowledgeFrame({ attemptId: begun.attemptId, sequence });
    assert.equal(events.at(-1), `ack:${sequence}`);
  }
  assert.deepEqual(coordinator.finish({ attemptId: begun.attemptId }), {
    kind: 'needs_reconciliation', reason: 'physical_observation_required',
  });
  assert.equal(events.at(-1), 'hold:physical_observation_required');
});

test('rejects mismatched approval before creating or reserving a journal', () => {
  let journals = 0;
  const coordinator = createBrowserPhysicalCoordinator({
    approvalFingerprint: proof.summary.approvalFingerprint,
    journalPath: '/tmp/browser-proof.sqlite',
    createJournal: () => { journals += 1; return journalDouble([]); },
  });
  assert.throws(() => coordinator.begin({
    approvalFingerprint: '0'.repeat(64), confirmation: 'SEND ONE SHEET',
  }, proof), /approval/i);
  assert.equal(journals, 0);
});

test('does not expose another frame until the current frame acknowledgement is durable', () => {
  const coordinator = createBrowserPhysicalCoordinator({
    approvalFingerprint: proof.summary.approvalFingerprint,
    journalPath: '/tmp/browser-proof.sqlite',
    createJournal: () => journalDouble([]),
  });
  const begun = coordinator.begin({
    approvalFingerprint: proof.summary.approvalFingerprint, confirmation: 'SEND ONE SHEET',
  }, proof);
  coordinator.recordJobId({ attemptId: begun.attemptId, jobId: 92 });
  coordinator.nextFrame({ attemptId: begun.attemptId, sequence: 0 });
  assert.throws(() => coordinator.nextFrame({ attemptId: begun.attemptId, sequence: 1 }), /acknowledgement/i);
  assert.throws(() => coordinator.acknowledgeFrame({ attemptId: begun.attemptId, sequence: 1 }), /sequence/i);
});
