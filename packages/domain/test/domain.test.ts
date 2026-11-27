import { describe, expect, it, vi } from 'vitest';
import {
  CompositionManifestSchema,
  DEVFEST_SG_V1,
  GEOMETRY_LIMITS,
  GeometryReportSchema,
  PrintProfileSchema,
  PublicStatusSchema,
  SubmissionSchema,
  canTransitionPublicStatus,
  canVisitorLeave,
  canonicalManifestJson,
  geometryIssuesHash,
  manifestHash,
  sha256Hex,
} from '../src/index.ts';

const validManifest = {
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
} as const;

describe('CompositionManifestSchema', () => {
  it('accepts the exact sprite-only manifest contract', () => {
    expect(CompositionManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it('accepts an optional trainer asset and every controlled variant', () => {
    expect(
      CompositionManifestSchema.parse({
        ...validManifest,
        trainerAssetId: 'trainer/session-123',
        theme: 'side-by-side',
        brandingVariant: 'logo-and-species',
        cutGroups: [{ id: 'portrait', members: ['sprite', 'trainer', 'branding'] }],
        cutMarginMm: 0.5,
      }),
    ).toMatchObject({ trainerAssetId: 'trainer/session-123', cutMarginMm: 0.5 });
  });

  it.each([0.49, 3.01, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid cut margin %s',
    (cutMarginMm) => {
      expect(() => CompositionManifestSchema.parse({ ...validManifest, cutMarginMm })).toThrow();
    },
  );

  it('rejects unknown fields at every public object boundary', () => {
    expect(() => CompositionManifestSchema.parse({ ...validManifest, surprise: true })).toThrow();
    expect(() =>
      CompositionManifestSchema.parse({
        ...validManifest,
        cutGroups: [{ id: 'main', members: ['sprite'], surprise: true }],
      }),
    ).toThrow();
  });
});

describe('operator print profile', () => {
  it('pins the DevFest profile to the agreed physical values', () => {
    expect(DEVFEST_SG_V1).toEqual({
      id: 'devfest-sg-v1',
      version: 1,
      mediaSize: 5013,
      mediaType: 2030,
      sheetWidthPx: 1200,
      sheetHeightPx: 2100,
      rasterWidthPx: 1216,
      rasterHeightPx: 2128,
      printQuality: 4,
      copies: 1,
      knifePressure: 42,
      cutHoles: false,
      alphaThreshold: 128,
      jpegMaxBytes: 1_048_576,
    });
    expect(PrintProfileSchema.parse(DEVFEST_SG_V1)).toEqual(DEVFEST_SG_V1);
  });

  it('pins geometry safety limits independently of visitor controls', () => {
    expect(GEOMETRY_LIMITS).toEqual({
      safetyGapMm: 1.5,
      preferredEdgeClearanceMm: 3,
      maxContours: 64,
      maxContourPoints: 50_000,
    });
  });
});

describe('public state machine', () => {
  it('contains only visitor-facing queue states', () => {
    for (const status of ['joining', 'queued', 'next', 'printing', 'ready', 'collected', 'cancelled']) {
      expect(PublicStatusSchema.parse(status)).toBe(status);
    }
    expect(() => PublicStatusSchema.parse('uploading_cut')).toThrow();
  });

  it.each([
    ['joining', 'queued'],
    ['joining', 'cancelled'],
    ['queued', 'next'],
    ['queued', 'cancelled'],
    ['next', 'printing'],
    ['printing', 'ready'],
    ['ready', 'collected'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionPublicStatus(from, to)).toBe(true);
  });

  it.each([
    ['queued', 'joining'],
    ['next', 'cancelled'],
    ['printing', 'queued'],
    ['ready', 'printing'],
    ['collected', 'ready'],
    ['cancelled', 'queued'],
    ['queued', 'queued'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(canTransitionPublicStatus(from, to)).toBe(false);
  });

  it('lets visitors leave only before they are next', () => {
    expect(canVisitorLeave('joining')).toBe(true);
    expect(canVisitorLeave('queued')).toBe(true);
    for (const status of ['next', 'printing', 'ready', 'collected', 'cancelled'] as const) {
      expect(canVisitorLeave(status)).toBe(false);
    }
  });
});

describe('SHA-256', () => {
  it.each(['native', 'insecure HTTP'])('hashes only the requested byte view in %s', async (context) => {
    if (context === 'insecure HTTP') vi.stubGlobal('crypto', {});
    try {
      const bytes = new TextEncoder().encode('_abc_').subarray(1, 4);
      await expect(sha256Hex(bytes)).resolves.toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('canonical manifest hashing', () => {
  it.each(['native', 'insecure HTTP'])('preserves the canonical manifest hash in %s', async (context) => {
    if (context === 'insecure HTTP') vi.stubGlobal('crypto', {});
    try {
      await expect(manifestHash(validManifest)).resolves.toBe(
        '82d655bd0983b14975add3264ad91060df411271ac42521198be4296f4352619',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['native', 'insecure HTTP'])('preserves the canonical warning hash in %s', async (context) => {
    if (context === 'insecure HTTP') vi.stubGlobal('crypto', {});
    try {
      await expect(geometryIssuesHash([{
        code: 'CUT_CONTOURS_OVERLAP',
        severity: 'warning',
        message: 'Two cut groups overlap.',
        cutGroupIds: ['main', 'brand'],
      }])).resolves.toBe('0d84cefa58b78e1b9397a62a7ca6d636a654fe227835555043fc9eaad553835d');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('canonicalizes object key order', async () => {
    const reordered = {
      renderVersion: validManifest.renderVersion,
      cutMarginMm: validManifest.cutMarginMm,
      cutGroups: validManifest.cutGroups,
      brandingVariant: validManifest.brandingVariant,
      theme: validManifest.theme,
      trainerAssetId: validManifest.trainerAssetId,
      spriteAssetId: validManifest.spriteAssetId,
      schemaVersion: validManifest.schemaVersion,
    };

    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(validManifest));
    expect(await manifestHash(reordered)).toBe(await manifestHash(validManifest));
  });

  it('preserves array order as meaningful', async () => {
    const reversed = { ...validManifest, cutGroups: [...validManifest.cutGroups].reverse() };
    expect(await manifestHash(reversed)).not.toBe(await manifestHash(validManifest));
  });

  it('rejects unknown and non-finite input before canonicalizing', () => {
    expect(() => canonicalManifestJson({ ...validManifest, extra: true })).toThrow();
    expect(() => canonicalManifestJson({ ...validManifest, cutMarginMm: Number.NaN })).toThrow();
  });
});

describe('stored record schemas', () => {
  const geometryReport = {
    valid: true,
    severity: 'warning',
    issues: [
      {
        code: 'CUT_CONTOURS_OVERLAP',
        severity: 'warning',
        message: 'Two cut groups overlap.',
        cutGroupIds: ['main', 'brand'],
      },
    ],
    contourCount: 2,
    pointCount: 120,
    cutLengthMm: 428.7,
    minimumContourGapMm: 0,
    edgeClearanceMm: 4.8,
    geometryVersion: '1',
    rasterHash: 'a'.repeat(64),
    acknowledgedByVisitor: true,
    acknowledgedAt: '2026-11-23T12:00:00.000Z',
  } as const;

  it('accepts a warning geometry report and immutable submission record', () => {
    expect(GeometryReportSchema.parse(geometryReport)).toEqual(geometryReport);

    const submission = {
      id: 'submission-1',
      ownerUid: 'anonymous-1',
      eventId: 'devfest-sg',
      idempotencyKey: 'idem-1',
      manifest: validManifest,
      manifestHash: 'b'.repeat(64),
      printSpec: { profileId: 'devfest-sg-v1', profileVersion: 1, cutMarginMm: 1.5 },
      validation: geometryReport,
      publicStatus: 'queued',
      publicStatusTokenHash: 'c'.repeat(64),
      queueNumber: 1,
      jobsAhead: 0,
      acceptedAt: '2026-11-23T12:00:00.000Z',
      cancelledAt: null,
      requeuedFrom: null,
      updatedAt: '2026-11-23T12:00:00.000Z',
    };

    expect(SubmissionSchema.parse(submission)).toEqual(submission);
    expect(() => SubmissionSchema.parse({ ...submission, physicalState: 'uploading_cut' })).toThrow();
    const stored = SubmissionSchema.strip();
    for (const fields of [{ recordVersion: 3 }, { recordVersion: 1 }, { recordVersion: 2 }, { artifact: {} }]) {
      expect(stored.safeParse({ ...submission, ...fields }).success).toBe(false);
    }
  });
});
