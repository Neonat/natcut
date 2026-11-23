import { describe, expect, it, vi } from 'vitest';
import { JobStore, SimulatedPrinter, runLocalJob, runWorkerOnce, type ClaimedSubmission, type CloudQueue } from '../src/index.ts';

function claimed(): ClaimedSubmission {
  return {
    submission: {
      id: 'submission-1',
      ownerUid: 'visitor',
      eventId: 'devfest-sg',
      idempotencyKey: 'request-1',
      manifest: {
        schemaVersion: 1,
        spriteAssetId: 'sprite/monstera-v1',
        trainerAssetId: null,
        theme: 'default',
        brandingVariant: 'logo',
        cutGroups: [{ id: 'main', members: ['sprite', 'branding'] }],
        cutMarginMm: 1.5,
        renderVersion: 'fixture-v1',
      },
      manifestHash: 'a'.repeat(64),
      printSpec: { profileId: 'devfest-sg-v1', profileVersion: 1, cutMarginMm: 1.5 },
      validation: {
        valid: true,
        severity: 'ok',
        issues: [],
        contourCount: 1,
        pointCount: 12,
        cutLengthMm: 100,
        minimumContourGapMm: null,
        edgeClearanceMm: 4,
        geometryVersion: 'natcut-geometry-v1',
        rasterHash: 'b'.repeat(64),
        acknowledgedByVisitor: false,
        acknowledgedAt: null,
      },
      publicStatus: 'next',
      publicStatusTokenHash: 'c'.repeat(64),
      queueNumber: 1,
      jobsAhead: 0,
      acceptedAt: '2026-11-23T12:00:00.000Z',
      cancelledAt: null,
      requeuedFrom: null,
      updatedAt: '2026-11-23T12:00:01.000Z',
    },
    workerId: 'mac-1',
    claimedAt: '2026-11-23T12:00:01.000Z',
  };
}

describe('simulated worker', () => {
  it('persists the exact phase order and publishes only visitor-facing states', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      updatePublicStatus: vi.fn().mockResolvedValue(undefined),
    };
    const store = new JobStore(':memory:');
    let tick = 0;
    const now = () => `2026-11-23T12:00:${String(++tick).padStart(2, '0')}.000Z`;
    const phases: string[] = [];
    const result = await runWorkerOnce({
      workerId: 'mac-1',
      cloud,
      store,
      executor: new SimulatedPrinter({ now, onPhase: (phase) => phases.push(phase) }),
      now,
    });

    expect(result).toEqual({ kind: 'completed', submissionId: 'submission-1' });
    expect(phases).toEqual([
      'rendering',
      'validating',
      'ready_to_declare',
      'declaring',
      'uploading_cut',
      'uploading_image',
      'printing',
      'cutting',
      'ready',
    ]);
    expect(cloud.beginExecution).toHaveBeenCalledWith('submission-1', 'mac-1', expect.any(String), expect.any(String));
    expect(cloud.updatePublicStatus).toHaveBeenCalledWith('submission-1', 'ready', expect.any(String));
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready');
    store.close();
  });

  it('returns idle without inserting a local job when the cloud queue is empty', async () => {
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1',
      cloud: { recoverClaim: vi.fn().mockResolvedValue(null), claimNextSubmission: vi.fn().mockResolvedValue(null), beginExecution: vi.fn(), updatePublicStatus: vi.fn() },
      store,
      executor: new SimulatedPrinter(),
      now: () => '2026-11-23T12:00:00.000Z',
    });
    expect(result).toEqual({ kind: 'idle' });
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it('recreates the durable local row when a crash happened immediately after the cloud claim', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(claim),
      claimNextSubmission: vi.fn(),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      updatePublicStatus: vi.fn().mockResolvedValue(undefined),
    };
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', cloud, store, executor: new SimulatedPrinter(),
    });
    expect(result).toEqual({ kind: 'completed', submissionId: 'submission-1' });
    expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready');
    store.close();
  });

  it('fences overlapping invocations that recover the same worker lease', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(claim),
      claimNextSubmission: vi.fn(),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      updatePublicStatus: vi.fn().mockResolvedValue(undefined),
    };
    const store = new JobStore(':memory:');
    let releaseExecution!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const executor = { execute: vi.fn(async () => blocked) };

    const first = runWorkerOnce({ workerId: 'mac-1', cloud, store, executor });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    const second = await runWorkerOnce({ workerId: 'mac-1', cloud, store, executor });
    expect(second).toEqual({ kind: 'busy', submissionId: 'submission-1' });
    releaseExecution();
    await expect(first).resolves.toEqual({ kind: 'completed', submissionId: 'submission-1' });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('does not recreate and execute a missing local journal after cloud printing began', async () => {
    const claim = claimed();
    claim.submission.publicStatus = 'printing';
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(claim),
      claimNextSubmission: vi.fn(),
      beginExecution: vi.fn(),
      updatePublicStatus: vi.fn(),
    };
    const store = new JobStore(':memory:');
    const executor = { execute: vi.fn() };
    const result = await runWorkerOnce({ workerId: 'mac-1', cloud, store, executor });
    expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: 'submission-1' });
    expect(store.getBySubmissionId('submission-1')?.state).toBe('needs_reconciliation');
    expect(executor.execute).not.toHaveBeenCalled();
    store.close();
  });

  it('publishes a recovered ready journal and releases it without re-executing', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValue(null),
      beginExecution: vi.fn(),
      updatePublicStatus: vi.fn().mockResolvedValue(undefined),
    };
    const store = new JobStore(':memory:');
    store.insertClaimed(claim);
    store.transition('submission-1', 'ready', '2026-11-23T12:00:10.000Z');
    const executor = { execute: vi.fn() };
    const result = await runWorkerOnce({ workerId: 'mac-1', cloud, store, executor });
    expect(result).toEqual({ kind: 'idle' });
    expect(cloud.updatePublicStatus).toHaveBeenNthCalledWith(
      1, 'submission-1', 'printing', '2026-11-23T12:00:10.000Z',
    );
    expect(cloud.updatePublicStatus).toHaveBeenNthCalledWith(
      2, 'submission-1', 'ready', '2026-11-23T12:00:10.000Z',
    );
    expect(store.listPendingPublicStatuses()).toEqual([]);
    expect(executor.execute).not.toHaveBeenCalled();
    store.close();
  });

  it('waits for cloud recovery instead of pinning a recovered ready job for execution', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(claim),
      claimNextSubmission: vi.fn(),
      beginExecution: vi.fn(),
      updatePublicStatus: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const store = new JobStore(':memory:');
    store.insertClaimed(claim);
    store.transition('submission-1', 'ready', '2026-11-23T12:00:10.000Z');
    const executor = { execute: vi.fn() };
    const result = await runWorkerOnce({ workerId: 'mac-1', cloud, store, executor });
    expect(result).toEqual({ kind: 'waiting_for_cloud', submissionId: 'submission-1' });
    expect(executor.execute).not.toHaveBeenCalled();
    store.close();
  });

  it('retains completed local state when ready publication fails after the execution marker', async () => {
    const claim = claimed();
    const updatePublicStatus = vi.fn().mockRejectedValue(new Error('offline'));
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      updatePublicStatus,
    };
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', cloud, store, executor: new SimulatedPrinter(),
      now: () => '2026-11-23T12:00:10.000Z',
    });
    expect(result.kind).toBe('completed');
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready');
    expect(store.listPendingPublicStatuses().map((entry) => entry.status)).toEqual(['ready']);
    store.close();
  });

  it('stops before physical execution when the cloud execution marker cannot be published', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockRejectedValue(new Error('offline')),
      updatePublicStatus: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const phases: string[] = [];
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', cloud, store,
      executor: new SimulatedPrinter({ onPhase: (phase) => phases.push(phase) }),
      now: () => '2026-11-23T12:00:10.000Z',
    });
    expect(result.kind).toBe('waiting_for_cloud');
    expect(phases).toEqual(['rendering', 'validating', 'ready_to_declare', 'declaring']);
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready_to_declare');
    expect(store.listPendingPublicStatuses()).toEqual([]);
    store.close();
  });

  it('does not execute a stale prepared snapshot after another invocation completed it', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn(), claimNextSubmission: vi.fn(), beginExecution: vi.fn().mockResolvedValue('acquired'), updatePublicStatus: vi.fn().mockResolvedValue(undefined),
    };
    const store = new JobStore(':memory:');
    store.insertClaimed(claim);
    const staleSnapshot = store.getBySubmissionId('submission-1')!;
    const firstExecutor = new SimulatedPrinter();
    await runLocalJob({ workerId: 'mac-1', cloud, store, executor: firstExecutor }, staleSnapshot);
    const secondExecutor = { execute: vi.fn() };
    const result = await runLocalJob(
      { workerId: 'mac-1', cloud, store, executor: secondExecutor },
      staleSnapshot,
    );
    expect(result).toEqual({ kind: 'completed', submissionId: 'submission-1' });
    expect(secondExecutor.execute).not.toHaveBeenCalled();
    store.close();
  });
});
