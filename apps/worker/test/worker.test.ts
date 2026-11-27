import { describe, expect, it, vi } from 'vitest';
import { JobStore, SimulatedPrinter, runLocalJob, runWorkerOnce, type ClaimedSubmission, type CloudQueue } from '../src/index.ts';

import { ArtifactIntegrityError, type ArtifactReader } from '@natcut/artifacts';
import { artifactReader, bundle, submission, verifiedClaim } from './fixtures/submission.ts';

function claimed(): ClaimedSubmission {
  return {
    submission: { ...submission('submission-1'), publicStatus: 'next' },
    workerId: 'mac-1',
    claimedAt: '2026-11-23T12:00:01.000Z',
  };
}

describe('simulated worker', () => {
  it('holds the legacy queue head before creating a job or starting any executor phase', async () => {
    const claim = claimed();
    delete claim.submission.recordVersion;
    delete claim.submission.artifact;
    const cloud = {
      recoverClaim: vi.fn().mockResolvedValue(claim), claimNextSubmission: vi.fn(),
      beginExecution: vi.fn(), completeExecution: vi.fn(),
    };
    const store = new JobStore(':memory:');
    const executor = { execute: vi.fn() };
    try {
      const result = await runWorkerOnce({ workerId: 'mac-1', artifactReader, cloud, store, executor });
      expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: claim.submission.id });
      expect(store.list()).toHaveLength(0);
      expect(executor.execute).not.toHaveBeenCalled();
      expect(cloud.beginExecution).not.toHaveBeenCalled();
      expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it.each(['unknown', 'malformed', 'manifest', 'spec', 'validation', 'unacknowledged', 'overflow', 'generation', 'bytes', 'missing'] as const)(
    'keeps %s evidence on hold before inserting a job, acquiring the fence or running a phase', async variant => {
      const claim = claimed();
      const ticket = claim.submission;
      if (variant === 'unknown') Object.assign(ticket, { recordVersion: 3 });
      if (variant === 'malformed') Object.assign(ticket.manifest, { extra: true });
      if (variant === 'manifest') ticket.manifestHash = 'f'.repeat(64);
      if (variant === 'spec') ticket.printSpec.cutMarginMm = 2.5;
      if (variant === 'validation') ticket.validation.rasterHash = 'f'.repeat(64);
      if (variant === 'unacknowledged') ticket.validation.severity = 'warning';
      if (variant === 'overflow') ticket.artifact!.generation = '9223372036854775808';
      const read = vi.fn<ArtifactReader['read']>(async receipt => {
        if (variant === 'missing') throw new ArtifactIntegrityError('Generation missing');
        if (variant === 'generation') return { receipt: { ...receipt, generation: '2' }, bytes: bundle.bytes };
        return { receipt, bytes: new Uint8Array(1) };
      });
      const cloud = {
        recoverClaim: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(claim), claimNextSubmission: vi.fn().mockResolvedValue(claim),
        beginExecution: vi.fn(), completeExecution: vi.fn(),
      };
      const store = new JobStore(':memory:');
      const executor = { execute: vi.fn() };
      try {
        const deps = { workerId: 'mac-1', cloud, store, executor, artifactReader: { read } };
        const expected = { kind: 'needs_reconciliation', submissionId: ticket.id };
        expect(await runWorkerOnce(deps)).toEqual(expected);
        expect(await runWorkerOnce({ ...deps, artifactReader })).toEqual(expected);
        expect(store.list()).toEqual([]);
        expect(store.hasArtifactHold(ticket.id)).toBe(true);
        expect(read).toHaveBeenCalledTimes(['generation', 'bytes', 'missing'].includes(variant) ? 1 : 0);
        expect(cloud.claimNextSubmission).toHaveBeenCalledTimes(1);
        expect(cloud.beginExecution).not.toHaveBeenCalled();
        expect(executor.execute).not.toHaveBeenCalled();
      } finally { store.close(); }
    },
  );

  it('retries the same cloud claim after an unavailable artifact read', async () => {
    const claim = claimed();
    const cloud = {
      recoverClaim: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(claim), claimNextSubmission: vi.fn().mockResolvedValue(claim),
      beginExecution: vi.fn().mockResolvedValue('acquired'), completeExecution: vi.fn().mockResolvedValue('committed'),
    };
    const store = new JobStore(':memory:');
    const execute = vi.fn(new SimulatedPrinter().execute.bind(new SimulatedPrinter()));
    const read = vi.fn<ArtifactReader['read']>().mockRejectedValueOnce(new Error('credentials unavailable')).mockImplementation(artifactReader.read);
    const deps = { workerId: 'mac-1', cloud, store, executor: { execute }, artifactReader: { read } };
    try {
      expect(await runWorkerOnce(deps)).toEqual({ kind: 'waiting_for_cloud', submissionId: claim.submission.id });
      expect(store.list()).toEqual([]);
      expect(store.hasArtifactHold(claim.submission.id)).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(cloud.beginExecution).not.toHaveBeenCalled();
      expect(await runWorkerOnce(deps)).toEqual({ kind: 'completed', submissionId: claim.submission.id });
      expect(read).toHaveBeenCalledTimes(2);
      expect(cloud.claimNextSubmission).toHaveBeenCalledTimes(1);
      expect(cloud.beginExecution).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });
  it('persists the exact phase order and publishes only visitor-facing states', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      completeExecution: vi.fn().mockResolvedValue('committed'),
    };
    const store = new JobStore(':memory:');
    let tick = 0;
    const now = () => `2026-11-23T12:00:${String(++tick).padStart(2, '0')}.000Z`;
    const phases: string[] = [];
    const result = await runWorkerOnce({
      workerId: 'mac-1', artifactReader,
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
    expect(cloud.beginExecution).toHaveBeenCalledWith('submission-1', 'mac-1', expect.any(String), expect.any(String), {
      receipt: claim.submission.artifact, manifestHash: claim.submission.manifestHash, validation: claim.submission.validation,
    });
    expect(cloud.completeExecution).toHaveBeenCalledWith({
      submissionId: 'submission-1', eventId: claim.submission.eventId, workerId: 'mac-1', executionToken: expect.any(String),
      receipt: claim.submission.artifact, manifestHash: claim.submission.manifestHash, validation: claim.submission.validation,
    }, expect.any(String));
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready');
    store.close();
  });

  it('returns idle without inserting a local job when the cloud queue is empty', async () => {
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', artifactReader,
      cloud: { recoverClaim: vi.fn().mockResolvedValue(null), claimNextSubmission: vi.fn().mockResolvedValue(null), beginExecution: vi.fn(), completeExecution: vi.fn() },
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
      completeExecution: vi.fn().mockResolvedValue('committed'),
    };
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', artifactReader, cloud, store, executor: new SimulatedPrinter(),
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
      completeExecution: vi.fn().mockResolvedValue('committed'),
    };
    const store = new JobStore(':memory:');
    let releaseExecution!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const simulator = new SimulatedPrinter();
    const executor = { execute: vi.fn(async (job, transition) => {
      await blocked;
      return simulator.execute(job, transition);
    }) };

    const first = runWorkerOnce({ workerId: 'mac-1', artifactReader, cloud, store, executor });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    const second = await runWorkerOnce({ workerId: 'mac-1', artifactReader, cloud, store, executor });
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
      completeExecution: vi.fn(),
    };
    const store = new JobStore(':memory:');
    const executor = { execute: vi.fn() };
    const result = await runWorkerOnce({ workerId: 'mac-1', artifactReader, cloud, store, executor });
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
      completeExecution: vi.fn().mockResolvedValue('committed'),
    };
    const store = new JobStore(':memory:');
    store.insertClaimed(await verifiedClaim(claim));
    store.transition('submission-1', 'ready', '2026-11-23T12:00:10.000Z');
    claim.submission.publicStatus = 'printing';
    claim.executionToken = store.getOrCreateExecutionToken(claim.submission.id);
    const executor = { execute: vi.fn() };
    const result = await runWorkerOnce({ workerId: 'mac-1', artifactReader, cloud, store, executor });
    expect(result).toEqual({ kind: 'idle' });
    expect(cloud.completeExecution).toHaveBeenCalledExactlyOnceWith({
      submissionId: 'submission-1', eventId: claim.submission.eventId, workerId: 'mac-1', executionToken: claim.executionToken,
      receipt: claim.submission.artifact, manifestHash: claim.submission.manifestHash, validation: claim.submission.validation,
    }, '2026-11-23T12:00:10.000Z');
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
      completeExecution: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const store = new JobStore(':memory:');
    store.insertClaimed(await verifiedClaim(claim));
    store.transition('submission-1', 'ready', '2026-11-23T12:00:10.000Z');
    claim.submission.publicStatus = 'printing';
    claim.executionToken = store.getOrCreateExecutionToken(claim.submission.id);
    const executor = { execute: vi.fn() };
    const result = await runWorkerOnce({ workerId: 'mac-1', artifactReader, cloud, store, executor });
    expect(result).toEqual({ kind: 'waiting_for_cloud', submissionId: 'submission-1' });
    expect(executor.execute).not.toHaveBeenCalled();
    store.close();
  });

  it.each([false, true])('holds local ready with cloud next without changing the outbox (ready intent present: %s)', async hasIntent => {
    const claim = claimed();
    const store = new JobStore(':memory:');
    const cloud = { recoverClaim: vi.fn().mockResolvedValue(claim), claimNextSubmission: vi.fn(), beginExecution: vi.fn(),
      completeExecution: vi.fn().mockResolvedValue('fenced') };
    const executor = { execute: vi.fn() };
    try {
      store.insertClaimed(await verifiedClaim(claim));
      store.transition(claim.submission.id, 'ready', claim.claimedAt);
      if (hasIntent) store.stagePublicStatus(claim.submission.id, 'ready', claim.claimedAt);
      const pending = store.listPendingPublicStatuses();
      expect(await runWorkerOnce({ workerId: claim.workerId, artifactReader, store, cloud, executor })).toEqual({
        kind: 'needs_reconciliation', submissionId: claim.submission.id,
      });
      expect(store.getState(claim.submission.id)).toBe('needs_reconciliation');
      expect(store.listPendingPublicStatuses()).toEqual(pending);
      expect(cloud.completeExecution).not.toHaveBeenCalled();
      expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
      expect(cloud.beginExecution).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it.each([false, true])('blocks a pending legacy ready intent when the current worker recovers a different claim: %s', async recoverDifferent => {
    const claim = claimed();
    const store = new JobStore(':memory:');
    const cloud = { recoverClaim: vi.fn().mockResolvedValue(recoverDifferent ? claim : null), claimNextSubmission: vi.fn(),
      beginExecution: vi.fn(), completeExecution: vi.fn() };
    const executor = { execute: vi.fn() };
    try {
      store.holdArtifact('legacy-head', claim.claimedAt, 'Legacy evidence.');
      store.stagePublicStatus('legacy-head', 'ready', claim.claimedAt);
      const pending = store.listPendingPublicStatuses();
      const result = await runWorkerOnce({ workerId: claim.workerId, artifactReader, store, cloud, executor });
      expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: 'legacy-head' });
      expect(store.listPendingPublicStatuses()).toEqual(pending);
      expect(cloud.completeExecution).not.toHaveBeenCalled();
      expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
      expect(cloud.beginExecution).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it.each([null, 'different-token'])('holds a ready intent with an unmatched recovered execution token %s', async executionToken => {
    const claim = claimed();
    claim.submission.publicStatus = 'printing';
    claim.executionToken = executionToken;
    const cloud = { recoverClaim: vi.fn().mockResolvedValue(claim), claimNextSubmission: vi.fn(), beginExecution: vi.fn(),
      completeExecution: vi.fn().mockResolvedValue('fenced') };
    const store = new JobStore(':memory:');
    const executor = { execute: vi.fn() };
    try {
      store.insertClaimed(await verifiedClaim(claim));
      store.getOrCreateExecutionToken(claim.submission.id);
      store.transitionAndStagePublicStatus(claim.submission.id, 'ready', claim.claimedAt, 'ready');
      const pending = store.listPendingPublicStatuses();
      expect(await runWorkerOnce({ workerId: claim.workerId, artifactReader, store, cloud, executor })).toEqual({
        kind: 'needs_reconciliation', submissionId: claim.submission.id,
      });
      expect(store.listPendingPublicStatuses()).toEqual(pending);
      expect(cloud.completeExecution).toHaveBeenCalledTimes(1);
      expect(executor.execute).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it('retains completed local state when ready publication fails after the execution marker', async () => {
    const claim = claimed();
    const completeExecution = vi.fn().mockRejectedValue(new Error('offline'));
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      completeExecution,
    };
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', artifactReader, cloud, store, executor: new SimulatedPrinter(),
      now: () => '2026-11-23T12:00:10.000Z',
    });
    expect(result).toEqual({ kind: 'waiting_for_cloud', submissionId: claim.submission.id });
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready');
    expect(store.listPendingPublicStatuses().map((entry) => entry.status)).toEqual(['ready']);
    store.close();
  });

  it('holds a malformed completion timestamp without calling the cloud fence', async () => {
    const claim = claimed();
    const store = new JobStore(':memory:');
    store.insertClaimed(await verifiedClaim(claim));
    store.getOrCreateExecutionToken(claim.submission.id);
    store.transitionAndStagePublicStatus(claim.submission.id, 'ready', claim.claimedAt, 'ready');
    store.stagePublicStatus(claim.submission.id, 'ready', 'not-an-iso-timestamp');
    const cloud = {
      recoverClaim: vi.fn(), claimNextSubmission: vi.fn(), beginExecution: vi.fn(), completeExecution: vi.fn(),
    };
    expect(await runWorkerOnce({ workerId: claim.workerId, artifactReader, cloud, store, executor: { execute: vi.fn() } })).toEqual({
      kind: 'needs_reconciliation', submissionId: claim.submission.id,
    });
    expect(cloud.completeExecution).not.toHaveBeenCalled();
    expect(store.listPendingPublicStatuses()).toMatchObject([{ updatedAt: 'not-an-iso-timestamp' }]);
    store.close();
  });

  it('holds a completed local execution when the cloud completion fence rejects its evidence', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      completeExecution: vi.fn().mockResolvedValue('fenced'),
    };
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', artifactReader, cloud, store, executor: new SimulatedPrinter(),
      now: () => '2026-11-23T12:00:10.000Z',
    });
    expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: claim.submission.id });
    expect(store.getBySubmissionId(claim.submission.id)?.state).toBe('needs_reconciliation');
    expect(store.listPendingPublicStatuses()).toMatchObject([{ submissionId: claim.submission.id, status: 'ready' }]);
  });

  it('stops before physical execution when the cloud execution marker cannot be published', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn().mockResolvedValue(null),
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
      beginExecution: vi.fn().mockRejectedValue(new Error('offline')),
      completeExecution: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const phases: string[] = [];
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1', artifactReader, cloud, store,
      executor: new SimulatedPrinter({ onPhase: (phase) => phases.push(phase) }),
      now: () => '2026-11-23T12:00:10.000Z',
    });
    expect(result.kind).toBe('waiting_for_cloud');
    expect(phases).toEqual(['rendering', 'validating', 'ready_to_declare']);
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready_to_declare');
    expect(store.listPendingPublicStatuses()).toEqual([]);
    store.close();
  });

  it('does not execute a stale prepared snapshot after another invocation completed it', async () => {
    const claim = claimed();
    const cloud: CloudQueue = {
      recoverClaim: vi.fn(), claimNextSubmission: vi.fn(), beginExecution: vi.fn().mockResolvedValue('acquired'), completeExecution: vi.fn().mockResolvedValue('committed'),
    };
    const store = new JobStore(':memory:');
    store.insertClaimed(await verifiedClaim(claim));
    const staleSnapshot = store.getBySubmissionId('submission-1')!;
    const firstExecutor = new SimulatedPrinter();
    await runLocalJob({ workerId: 'mac-1', artifactReader, cloud, store, executor: firstExecutor }, staleSnapshot);
    const secondExecutor = { execute: vi.fn() };
    const result = await runLocalJob(
      { workerId: 'mac-1', artifactReader, cloud, store, executor: secondExecutor },
      staleSnapshot,
    );
    expect(result).toEqual({ kind: 'completed', submissionId: 'submission-1' });
    expect(secondExecutor.execute).not.toHaveBeenCalled();
    store.close();
  });
});
