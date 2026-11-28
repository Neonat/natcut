import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { verifyArtifactBytes } from '@natcut/artifacts';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '@natcut/domain';
import { preparePhysicalArtifacts } from '@natcut/printer';
import { verifyClaim } from '../src/artifact-verification.ts';
import { JobStore } from '../src/job-store.ts';
import { prepareNextWorkerJob, runLocalJob } from '../src/worker.ts';
import { SqliteTransportAttemptJournal } from '../../../packages/printer/src/transport-attempt.ts';
import { QueuePhysicalQcJournal } from '../../../packages/printer/src/queue-physical-qc.ts';
import { assertFreshPhysicalSendJournal, completeObservedPhysicalJob, PhysicalQueueExecutor, printerIsIdle, transportJournalPath } from '../../../scripts/physical-queue-bridge.ts';
import { submission } from './fixtures/submission.ts';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'natcut-queue-physical-'));
  const profile = DEVFEST_SG_V1;
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
  for (let y = 200; y < 250; y++) for (let x = 200; x < 250; x++) {
    const pixel = y * profile.sheetWidthPx + x;
    rgba.set([230, 20, 80, 255], pixel * 4);
    mask[pixel] = 255;
  }
  const bundle = await encodeLogicalSourceBundle({
    colorEvidence: NATIVE_SRGB_EVIDENCE, profile,
    width: profile.sheetWidthPx, height: profile.sheetHeightPx,
    renderVersion: 'fixture-v1', geometryVersion: 'natcut-geometry-v1', rgba, mask,
  });
  const receipt = { descriptor: bundle.descriptor, generation: '1' };
  const id = 'physical-queue-fixture';
  const base = submission(id);
  const ticket = { ...base, artifact: receipt, publicStatus: 'next',
    validation: { ...base.validation, rasterHash: bundle.descriptor.maskSha256 } };
  const claim = { submission: ticket, workerId: 'mac-1', claimedAt: ticket.updatedAt };
  const reader = { read: async () => verifyArtifactBytes(bundle.bytes, receipt) };
  const verified = await verifyClaim(claim, reader, AbortSignal.timeout(10_000), () => claim.claimedAt);
  const store = new JobStore(path.join(directory, 'worker.sqlite'));
  store.insertClaimed(verified);
  const physical = await preparePhysicalArtifacts(await verifyArtifactBytes(bundle.bytes, receipt));
  const expected = {
    submissionId: id, bundleSha256: bundle.descriptor.bundleSha256,
    jpegSha256: physical.print.sha256, pltSha256: physical.cut.sha256,
  };
  const remote = { ...claim, submission: { ...ticket }, executionToken: null };
  const cloud = {
    recoverClaim: vi.fn(async () => remote), claimNextSubmission: vi.fn(),
    beginExecution: vi.fn(async (_id, _worker, token) => {
      remote.executionToken = token;
      remote.submission.publicStatus = 'printing';
      return 'acquired';
    }),
    completeExecution: vi.fn(async () => 'committed'),
  };
  const transport = {
    declareCombo: vi.fn(async () => ({ jobId: 37 })),
    sendFrameAndWaitForAck: vi.fn(async () => undefined),
  };
  const session = { io: { read: async () => new Uint8Array(), write: async () => undefined }, close: vi.fn(async () => undefined) };
  const openSession = vi.fn(async () => session);
  const inspectSession = vi.fn(async () => ({ firmwareShapeVerified: true, status: { state: 30, sub: 2000, alerts: [] }, activeJobs: [] }));
  const journalDirectory = path.join(directory, 'attempts');
  const journalJob = store.getBySubmissionId(id);
  const prepared = {
    submissionId: id, eventId: ticket.eventId, queueNumber: ticket.queueNumber,
    manifestHash: ticket.manifestHash, geometryReportJson: journalJob.geometryReportJson,
    artifactReceiptJson: journalJob.artifactReceiptJson,
  };
  const cleanup = async () => { store.close(); await rm(directory, { recursive: true, force: true }); };
  return { id, directory, store, cloud, reader, transport, session, openSession, inspectSession,
    journalDirectory, expected, prepared, cleanup };
}

describe('physical queue bridge', () => {
  it('refuses a reused journal and never publishes an unrelated pending ticket in exact-ticket mode', async () => {
    const f = await fixture();
    try {
      expect(() => assertFreshPhysicalSendJournal(f.store)).toThrow(/fresh ticket-specific/);
      const cloud = { recoverClaim: vi.fn(), claimNextSubmission: vi.fn() };
      const store = { listPendingPublicStatuses: () => [{ submissionId: 'another-ticket', status: 'ready' }] };
      expect(await prepareNextWorkerJob({ workerId: 'mac-1', expectedSubmissionId: f.id,
        cloud, store, artifactReader: f.reader })).toEqual({ kind: 'needs_reconciliation', submissionId: 'another-ticket' });
      expect(cloud.recoverClaim).not.toHaveBeenCalled();
      expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('treats only awake or asleep idle with no alerts and no active jobs as ready', () => {
    const asleep = { firmwareShapeVerified: true, status: { state: 30, sub: 2000, alerts: [] }, activeJobs: [] };
    expect(printerIsIdle(asleep)).toBe(true);
    expect(printerIsIdle({ ...asleep, status: { ...asleep.status, state: 20 } })).toBe(true);
    expect(printerIsIdle({ ...asleep, status: { ...asleep.status, state: 40 } })).toBe(false);
    expect(printerIsIdle({ ...asleep, status: { ...asleep.status, alerts: [1] } })).toBe(false);
    expect(printerIsIdle({ ...asleep, activeJobs: [9] })).toBe(false);
    expect(printerIsIdle({ ...asleep, firmwareShapeVerified: false })).toBe(false);
  });

  it('fences cloud execution before USB, holds the ticket for physical QC, then publishes only the observed pass', async () => {
    const f = await fixture();
    try {
      const order = [];
      f.cloud.beginExecution.mockImplementationOnce(async (_id, _worker, token) => {
        order.push('cloud');
        const remote = await f.cloud.recoverClaim();
        remote.executionToken = token;
        remote.submission.publicStatus = 'printing';
        return 'acquired';
      });
      f.transport.declareCombo.mockImplementationOnce(async () => { order.push('usb'); return { jobId: 37 }; });
      const executor = new PhysicalQueueExecutor({
        store: f.store, workerId: 'mac-1', journalDirectory: f.journalDirectory, expected: f.expected,
        openSession: f.openSession, inspectSession: f.inspectSession, createTransport: () => f.transport,
      });
      const result = await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared);
      expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: f.id });
      expect(order).toEqual(['cloud', 'usb']);
      expect(f.cloud.completeExecution).not.toHaveBeenCalled();
      expect(f.store.getBySubmissionId(f.id).state).toBe('needs_reconciliation');
      const journal = new SqliteTransportAttemptJournal(transportJournalPath(f.journalDirectory, f.id), { existingOnly: true });
      try { expect(journal.get(f.id).reason).toBe('physical_observation_required'); }
      finally { journal.close(); }
      const declarations = f.transport.declareCombo.mock.calls.length;
      expect(await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared)).toEqual(result);
      expect(f.transport.declareCombo).toHaveBeenCalledTimes(declarations);
      const completed = await completeObservedPhysicalJob({ store: f.store, cloud: f.cloud, workerId: 'mac-1',
        journalDirectory: f.journalDirectory, expected: f.expected });
      expect(completed).toEqual({ kind: 'completed', submissionId: f.id });
      expect(f.cloud.completeExecution).toHaveBeenCalledTimes(1);
      expect(f.store.getBySubmissionId(f.id).completionAcknowledgedAt).toBeTruthy();
      expect(await completeObservedPhysicalJob({ store: f.store, cloud: f.cloud, workerId: 'mac-1',
        journalDirectory: f.journalDirectory, expected: f.expected })).toEqual(completed);
    } finally { await f.cleanup(); }
  }, 30_000);

  it('rejects a changed JPEG before opening USB or taking a cloud execution lease', async () => {
    const f = await fixture();
    try {
      const executor = new PhysicalQueueExecutor({
        store: f.store, workerId: 'mac-1', journalDirectory: f.journalDirectory,
        expected: { ...f.expected, jpegSha256: sha('wrong') },
        openSession: f.openSession, inspectSession: f.inspectSession, createTransport: () => f.transport,
      });
      const result = await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared);
      expect(result.kind).toBe('failed');
      expect(f.openSession).not.toHaveBeenCalled();
      expect(f.cloud.beginExecution).not.toHaveBeenCalled();
      expect(f.transport.declareCombo).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  }, 30_000);

  it('never declares USB when the cloud execution fence rejects the ticket', async () => {
    const f = await fixture();
    try {
      f.cloud.beginExecution.mockResolvedValueOnce('fenced');
      const executor = new PhysicalQueueExecutor({
        store: f.store, workerId: 'mac-1', journalDirectory: f.journalDirectory, expected: f.expected,
        openSession: f.openSession, inspectSession: f.inspectSession, createTransport: () => f.transport,
      });
      const result = await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared);
      expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: f.id });
      expect(f.transport.declareCombo).not.toHaveBeenCalled();
      expect(f.cloud.completeExecution).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  }, 30_000);

  it('does not mark an ambiguous upload ready even if the operator requests completion', async () => {
    const f = await fixture();
    try {
      f.transport.sendFrameAndWaitForAck.mockRejectedValueOnce(new Error('unknown acknowledgement'));
      const executor = new PhysicalQueueExecutor({
        store: f.store, workerId: 'mac-1', journalDirectory: f.journalDirectory, expected: f.expected,
        openSession: f.openSession, inspectSession: f.inspectSession, createTransport: () => f.transport,
      });
      expect(await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared)).toEqual({ kind: 'needs_reconciliation', submissionId: f.id });
      await expect(completeObservedPhysicalJob({ store: f.store, cloud: f.cloud, workerId: 'mac-1',
        journalDirectory: f.journalDirectory, expected: f.expected })).rejects.toThrow(/fully acknowledged/);
      expect(f.cloud.completeExecution).not.toHaveBeenCalled();
      expect(f.store.getBySubmissionId(f.id).state).toBe('needs_reconciliation');
    } finally { await f.cleanup(); }
  }, 30_000);

  it('recovers the fully acknowledged attempt after a crash before local reconciliation', async () => {
    const f = await fixture();
    try {
      const executor = new PhysicalQueueExecutor({
        store: f.store, workerId: 'mac-1', journalDirectory: f.journalDirectory, expected: f.expected,
        openSession: f.openSession, inspectSession: f.inspectSession, createTransport: () => f.transport,
      });
      await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared);
      f.store.transition(f.id, 'declaring', new Date().toISOString(), 'simulated crash before local reconciliation');
      expect(await completeObservedPhysicalJob({ store: f.store, cloud: f.cloud, workerId: 'mac-1',
        journalDirectory: f.journalDirectory, expected: f.expected })).toEqual({ kind: 'completed', submissionId: f.id });
      expect(f.transport.declareCombo).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  }, 30_000);

  it('replays an observed ready outbox after cloud committed but its response was lost', async () => {
    const f = await fixture();
    try {
      const executor = new PhysicalQueueExecutor({
        store: f.store, workerId: 'mac-1', journalDirectory: f.journalDirectory, expected: f.expected,
        openSession: f.openSession, inspectSession: f.inspectSession, createTransport: () => f.transport,
      });
      await runLocalJob({ workerId: 'mac-1', cloud: f.cloud, store: f.store,
        executor, artifactReader: f.reader }, f.prepared);
      const file = transportJournalPath(f.journalDirectory, f.id);
      const transport = new SqliteTransportAttemptJournal(file, { existingOnly: true });
      const evidenceHash = transport.get(f.id).evidenceHash;
      transport.close();
      const physical = new QueuePhysicalQcJournal(file);
      physical.recordPass(f.id, evidenceHash, new Date().toISOString());
      physical.close();
      f.store.transitionAndStagePublicStatus(f.id, 'ready', new Date().toISOString(), 'ready');
      f.cloud.recoverClaim.mockResolvedValueOnce(null);
      f.cloud.completeExecution.mockResolvedValueOnce('confirmed');
      expect(await completeObservedPhysicalJob({ store: f.store, cloud: f.cloud, workerId: 'mac-1',
        journalDirectory: f.journalDirectory, expected: f.expected })).toEqual({ kind: 'completed', submissionId: f.id });
      expect(f.cloud.recoverClaim).not.toHaveBeenCalled();
      expect(f.cloud.completeExecution).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  }, 30_000);

  it('cannot claim a simulator-ready job as a physical completion', async () => {
    const f = await fixture();
    try {
      f.store.getOrCreateExecutionToken(f.id);
      f.store.transitionAndStagePublicStatus(f.id, 'ready', new Date().toISOString(), 'ready');
      await expect(completeObservedPhysicalJob({ store: f.store, cloud: f.cloud, workerId: 'mac-1',
        journalDirectory: f.journalDirectory, expected: f.expected })).rejects.toThrow(/open database|exact transport attempt is missing/i);
      expect(f.cloud.completeExecution).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  }, 30_000);
});
