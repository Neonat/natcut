import { ArtifactIntegrityError, verifyArtifactBytes, type ArtifactReader } from '@natcut/artifacts';
import { DEVFEST_SG_V1, encodeLogicalSourceBundle, manifestHash, type CompositionManifest, type Submission } from '@natcut/domain';
import type { ClaimedSubmission } from '../../src/cloud-queue.ts';
import { verifyClaim } from '../../src/artifact-verification.ts';

const { sheetWidthPx: width, sheetHeightPx: height } = DEVFEST_SG_V1;
export const bundle = await encodeLogicalSourceBundle({
  profile: DEVFEST_SG_V1, width, height, renderVersion: 'fixture-v1', geometryVersion: 'natcut-geometry-v1',
  rgba: new Uint8Array(width * height * 4), mask: new Uint8Array(width * height),
});
const artifact = { descriptor: bundle.descriptor, generation: '1' };
export const artifactReader: ArtifactReader = {
  async read(receipt) {
    if (receipt.generation !== artifact.generation) throw new ArtifactIntegrityError('Missing fixture generation.');
    return verifyArtifactBytes(bundle.bytes, receipt);
  },
};
export const verifiedClaim = (claim: ClaimedSubmission) =>
  verifyClaim(claim, artifactReader, AbortSignal.timeout(5000), () => claim.claimedAt);

export function claimFixture(id: string): ClaimedSubmission {
  const ticket = submission(id);
  return { submission: { ...ticket, publicStatus: 'next' }, workerId: 'mac-1', claimedAt: ticket.updatedAt };
}

const manifest: CompositionManifest = {
  schemaVersion: 1, spriteAssetId: 'sprite/monstera-v1', trainerAssetId: null,
  theme: 'default', brandingVariant: 'logo',
  cutGroups: [{ id: 'main', members: ['sprite', 'branding'] }], cutMarginMm: 1.5, renderVersion: 'fixture-v1',
};
const hash = await manifestHash(manifest);

export function submission(id = 'submission-race', queueNumber = 1): Submission {
  return {
    id, ownerUid: 'visitor', eventId: 'devfest-sg', idempotencyKey: `race-${queueNumber}`,
    recordVersion: 2, artifact: structuredClone(artifact), manifest: structuredClone(manifest), manifestHash: hash,
    printSpec: { profileId: 'devfest-sg-v1', profileVersion: 1, cutMarginMm: 1.5 },
    validation: {
      valid: true, severity: 'ok', issues: [], contourCount: 1, pointCount: 12, cutLengthMm: 100,
      minimumContourGapMm: null, edgeClearanceMm: 4, geometryVersion: 'natcut-geometry-v1',
      rasterHash: artifact.descriptor.maskSha256, acknowledgedByVisitor: false, acknowledgedAt: null,
    },
    publicStatus: 'queued', publicStatusTokenHash: 'c'.repeat(64), queueNumber, jobsAhead: queueNumber - 1,
    acceptedAt: '2026-11-23T12:00:00.000Z', cancelledAt: null, requeuedFrom: null,
    updatedAt: '2026-11-23T12:00:00.000Z',
  } as const;
}
