import { describe, expect, it, vi } from 'vitest';
import { JobStore, recoverInterruptedJobs, startWorker, type LocalJobState, type LocalPrintJob } from '../src/index.ts';

function job(state: LocalJobState): LocalPrintJob {
  return {
    id: `local-${state}`,
    submissionId: `submission-${state}`,
    queueNumber: 1,
    manifestHash: 'a'.repeat(64),
    rasterHash: 'b'.repeat(64),
    printProfileSnapshotJson: '{}',
    geometryReportJson: '{}',
    jpegPath: '', jpegSha256: 'c'.repeat(64), jpegBytes: 0,
    pltPath: '', pltSha256: 'd'.repeat(64), pltBytes: 0,
    state,
    printerJobId: null,
    uploadPhase: 'none',
    lastPrinterState: null,
    lastPrinterSubState: null,
    lastAlertsJson: '[]',
    acceptedAt: '2026-11-23T12:00:00.000Z',
    stateChangedAt: '2026-11-23T12:00:01.000Z',
    lastError: null,
  };
}

describe('restart recovery', () => {
  it.each(['declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting'] as const)(
    'marks interrupted %s work as needs_reconciliation without invoking execution',
    (state) => {
      const store = new JobStore(':memory:');
      store.insert(job(state));
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
    (state) => {
      const store = new JobStore(':memory:');
      store.insert(job(state));
      expect(recoverInterruptedJobs(store, '2026-11-23T12:05:00.000Z')).toEqual([]);
      expect(store.getBySubmissionId(`submission-${state}`)?.state).toBe(state);
      store.close();
    },
  );

  it('resumes a safe pre-declaration journal before claiming new cloud work', async () => {
    const store = new JobStore(':memory:');
    store.insert(job('validating'));
    const executor = { execute: vi.fn(async () => undefined) };
    const cloud = {
      recoverClaim: vi.fn().mockResolvedValue({
        submission: {
          id: 'submission-validating',
          manifestHash: 'a'.repeat(64),
          queueNumber: 1,
        },
        workerId: 'mac-1',
        claimedAt: '2026-11-23T12:00:01.000Z',
      }),
      claimNextSubmission: vi.fn(),
      updatePublicStatus: vi.fn(),
    };
    const result = await startWorker({
      workerId: 'mac-1', cloud, store, executor, now: () => '2026-11-23T12:05:00.000Z',
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(cloud.claimNextSubmission).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'completed', submissionId: 'submission-validating' });
    store.close();
  });
});
