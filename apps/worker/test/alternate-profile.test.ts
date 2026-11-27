import { isDeepStrictEqual } from 'node:util';
import { expect, it, vi } from 'vitest';
import { encodeLogicalSourceBundle, resolvePrintProfile } from '@natcut/domain';
import { verifyArtifactBytes } from '@natcut/artifacts';
import { JobStore, runWorkerOnce } from '../src/index.ts';
import { claimFixture } from './fixtures/submission.ts';

// Extend only this test's registry. Production currently publishes one profile.
vi.mock('../../../packages/domain/src/print-profile.ts', async importOriginal => {
  const original = await importOriginal<typeof import('@natcut/domain')>();
  const extra = Object.freeze({ ...original.DEVFEST_SG_V1, id: 'test-sheet', version: 7,
    sheetWidthPx: 4, sheetHeightPx: 3, knifePressure: 37 });
  return {
    ...original,
    resolvePrintProfile: (id: string, version: number) =>
      id === extra.id && version === extra.version ? extra : original.resolvePrintProfile(id, version),
    PublishedPrintProfileSchema: original.PublishedPrintProfileSchema.or(
      original.PrintProfileSchema.refine(value => isDeepStrictEqual(value, extra)).transform(() => extra),
    ),
  };
});

it('journals the accepted profile snapshot and source dimensions for another registered sheet', async () => {
  const profile = resolvePrintProfile('test-sheet', 7);
  const claim = claimFixture('alternate-profile');
  const ticket = claim.submission;
  const bundle = await encodeLogicalSourceBundle({
    profile, width: 4, height: 3, rgba: new Uint8Array(48), mask: new Uint8Array(12),
    renderVersion: ticket.manifest.renderVersion, geometryVersion: ticket.validation.geometryVersion,
  });
  ticket.artifact = { descriptor: bundle.descriptor, generation: '19' };
  ticket.printSpec = { ...ticket.printSpec, profileId: profile.id, profileVersion: profile.version };
  ticket.validation.rasterHash = bundle.descriptor.maskSha256;
  const store = new JobStore(':memory:');
  const cloud = { isReadyAcknowledged: async () => false, recoverClaim: vi.fn().mockResolvedValue(claim), claimNextSubmission: vi.fn(), beginExecution: vi.fn(), updatePublicStatus: vi.fn() };
  try {
    const result = await runWorkerOnce({ store, cloud, workerId: claim.workerId, executor: { execute: vi.fn() },
      artifactReader: { read: receipt => verifyArtifactBytes(bundle.bytes, receipt) } });
    expect(result.kind).toBe('completed');
    const job = store.getBySubmissionId(ticket.id)!;
    expect(JSON.parse(job.printProfileSnapshotJson)).toEqual(profile);
    expect(job.artifactBytes?.byteLength).toBe(60);
    expect(job.cutMaskSha256).toBe(bundle.descriptor.maskSha256);
  } finally { store.close(); }
});
