import { artifactReader, claimFixture, submission, verifiedClaim } from './fixtures/submission.ts';
import { describe, expect, it, vi } from 'vitest';
import { JobStore, recoverInterruptedJobs, startWorker, type LocalJobState } from '../src/index.ts';

async function insertInState(store: JobStore, state: LocalJobState) {
  const claim = claimFixture('submission-' + state);
  store.insertClaimed(await verifiedClaim(claim));
  store.transition(claim.submission.id, state, claim.claimedAt);
}

describe('restart recovery', () => {
  it.each(['declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting'] as const)(
    'marks interrupted %s work as needs_reconciliation without invoking execution',
    async (state) => {
      const store = new JobStore(':memory:');
      await insertInState(store, state);
      const executor = { execute: vi.fn() };
      const recovered = recoverInterruptedJobs(store, '2026-11-23T12:05:00.000Z', executor);
      expect(recovered).toEqual([`submission-${state}`]);
      expect(store.getBySubmissionId(`submission-${state}`)?.state).toBe('needs_reconciliation');
      expect(executor.execute).not.toHaveBeenCalled();
      store.close();
    },
  );

  it.each(['claimed', 'rendering', 'validating', 'ready_to_declare'] as const)(
    'leaves safe pre-declaration state %s resumable',
    async (state) => {
      const store = new JobStore(':memory:');
      await insertInState(store, state);
      expect(recoverInterruptedJobs(store, '2026-11-23T12:05:00.000Z')).toEqual([]);
      expect(store.getBySubmissionId(`submission-${state}`)?.state).toBe(state);
      store.close();
    },
  );

  it('does not rewrite uncertain work while another live executor owns the journal', async () => {
    const store = new JobStore(':memory:');
    await insertInState(store, 'cutting');
    expect(store.tryAcquireExecutionGuard('live-executor', process.pid)).toBe(true);
    expect(recoverInterruptedJobs(store, '2026-11-23T12:05:00.000Z')).toEqual([]);
    expect(store.getBySubmissionId('submission-cutting')?.state).toBe('cutting');
    store.releaseExecutionGuard('live-executor');
    expect(recoverInterruptedJobs(store, '2026-11-23T12:06:00.000Z')).toEqual(['submission-cutting']);
    store.close();
  });

  it('resumes a safe pre-declaration journal before claiming new cloud work', async () => {
    const store = new JobStore(':memory:');
    const claim = { submission: { ...submission('submission-validating'), publicStatus: 'next' as const }, workerId: 'mac-1', claimedAt: '2026-11-23T12:00:01.000Z' };
    store.insertClaimed(await verifiedClaim(claim));
    store.transition(claim.submission.id, 'validating', claim.claimedAt);
    const executor = { execute: vi.fn(async () => undefined) };
    const cloud = {
      isReadyAcknowledged: async () => false, recoverClaim: vi.fn().mockResolvedValue(claim),
      claimNextSubmission: vi.fn(),
      beginExecution: vi.fn().mockResolvedValue('acquired'),
      updatePublicStatus: vi.fn(),
    };
    const result = await startWorker({
      workerId: 'mac-1', artifactReader, cloud, store, executor, now: () => '2026-11-23T12:05:00.000Z',
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'completed', submissionId: 'submission-validating' });
    store.close();
  });
});
