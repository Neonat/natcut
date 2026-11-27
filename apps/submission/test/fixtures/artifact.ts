import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '@natcut/domain';
import type { CreateSubmissionInput } from '../../src/repository.ts';

const { sheetWidthPx: width, sheetHeightPx: height } = DEVFEST_SG_V1;
export const bundle = await encodeLogicalSourceBundle({
  colorEvidence: NATIVE_SRGB_EVIDENCE,
  profile: DEVFEST_SG_V1, width, height,
  rgba: new Uint8Array(width * height * 4), mask: new Uint8Array(width * height),
  renderVersion: 'fixture-v1', geometryVersion: 'natcut-geometry-v1',
});
export const artifact = { descriptor: bundle.descriptor, generation: '9007199254740993' };

export function submissionInput(idempotencyKey: string): CreateSubmissionInput {
  return {
    artifact,
    ownerUid: 'visitor-one',
    eventId: 'devfest-sg',
    idempotencyKey,
    manifest: {
      schemaVersion: 1,
      spriteAssetId: 'sprite/monstera-v1',
      trainerAssetId: null,
      theme: 'default',
      brandingVariant: 'logo',
      cutGroups: [
        { id: 'main', members: ['sprite'] },
        { id: 'brand', members: ['branding'] },
      ],
      cutMarginMm: 1.5,
      renderVersion: 'fixture-v1',
    },
    manifestHash: 'a'.repeat(64),
    printSpec: { profileId: 'devfest-sg-v1', profileVersion: 1, cutMarginMm: 1.5 },
    validation: {
      valid: true,
      severity: 'ok',
      issues: [],
      contourCount: 2,
      pointCount: 16,
      cutLengthMm: 120,
      minimumContourGapMm: 4,
      edgeClearanceMm: 5,
      geometryVersion: 'natcut-geometry-v1',
      rasterHash: artifact.descriptor.maskSha256,
      acknowledgedByVisitor: false,
      acknowledgedAt: null,
    },
    publicStatusTokenHash: 'c'.repeat(64),
    acceptedAt: '2026-11-23T12:00:00.000Z',
    requeuedFrom: null,
  };
}
