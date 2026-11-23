import { describe, expect, it, vi } from 'vitest';
import { JobStore, SimulatedPrinter, runWorkerOnce, type ClaimedSubmission, type CloudQueue } from '../src/index.ts';

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
      claimNextSubmission: vi.fn().mockResolvedValueOnce(claim),
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
    expect(cloud.updatePublicStatus).toHaveBeenNthCalledWith(1, 'submission-1', 'printing', expect.any(String));
    expect(cloud.updatePublicStatus).toHaveBeenNthCalledWith(2, 'submission-1', 'ready', expect.any(String));
    expect(store.getBySubmissionId('submission-1')?.state).toBe('ready');
    store.close();
  });

  it('returns idle without inserting a local job when the cloud queue is empty', async () => {
    const store = new JobStore(':memory:');
    const result = await runWorkerOnce({
      workerId: 'mac-1',
      cloud: { claimNextSubmission: vi.fn().mockResolvedValue(null), updatePublicStatus: vi.fn() },
      store,
      executor: new SimulatedPrinter(),
      now: () => '2026-11-23T12:00:00.000Z',
    });
    expect(result).toEqual({ kind: 'idle' });
    expect(store.list()).toHaveLength(0);
    store.close();
  });
});
