import type { Submission } from '@natcut/domain';

export function submission(id = 'submission-race', queueNumber = 1): Submission {
  return {
    id, ownerUid: 'visitor', eventId: 'devfest-sg', idempotencyKey: `race-${queueNumber}`,
    manifest: {
      schemaVersion: 1, spriteAssetId: 'sprite/monstera-v1', trainerAssetId: null,
      theme: 'default', brandingVariant: 'logo',
      cutGroups: [{ id: 'main', members: ['sprite', 'branding'] }], cutMarginMm: 1.5, renderVersion: 'fixture-v1',
    },
    manifestHash: 'a'.repeat(64),
    printSpec: { profileId: 'devfest-sg-v1', profileVersion: 1, cutMarginMm: 1.5 },
    validation: {
      valid: true, severity: 'ok', issues: [], contourCount: 1, pointCount: 12, cutLengthMm: 100,
      minimumContourGapMm: null, edgeClearanceMm: 4, geometryVersion: 'natcut-geometry-v1',
      rasterHash: 'b'.repeat(64), acknowledgedByVisitor: false, acknowledgedAt: null,
    },
    publicStatus: 'queued', publicStatusTokenHash: 'c'.repeat(64), queueNumber, jobsAhead: queueNumber - 1,
    acceptedAt: '2026-11-23T12:00:00.000Z', cancelledAt: null, requeuedFrom: null,
    updatedAt: '2026-11-23T12:00:00.000Z',
  } as const;
}
