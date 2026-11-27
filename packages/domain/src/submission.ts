import { z } from 'zod';
import { GeometryReportSchema } from './geometry.ts';
import { CompositionManifestSchema } from './manifest.ts';
import { ArtifactReceiptSchema } from './print-artifact.ts';
import { PublicStatusSchema } from './state-machine.ts';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime();

export const PrintSpecSchema = z
  .object({
    profileId: z.string().trim().min(1),
    profileVersion: z.number().int().positive(),
    cutMarginMm: z.number().finite().min(0.5).max(3).refine((value) => !Object.is(value, -0)),
  })
  .strict();

export const SubmissionSchema = z
  .object({
    id: z.string().trim().min(1),
    recordVersion: z.literal(2).optional(),
    artifact: ArtifactReceiptSchema.optional(),
    ownerUid: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    manifest: CompositionManifestSchema,
    manifestHash: sha256Schema,
    printSpec: PrintSpecSchema,
    validation: GeometryReportSchema,
    publicStatus: PublicStatusSchema,
    publicStatusTokenHash: sha256Schema,
    queueNumber: z.number().int().positive(),
    jobsAhead: z.number().int().nonnegative(),
    acceptedAt: timestampSchema,
    cancelledAt: timestampSchema.nullable(),
    requeuedFrom: z.string().trim().min(1).nullable(),
    updatedAt: timestampSchema,
  })
  .strict().refine(({ recordVersion, artifact, validation, manifest, printSpec }) => {
    if (recordVersion === undefined) return artifact === undefined;
    if (!artifact) return false;
    const { descriptor } = artifact;
    return descriptor.maskSha256 === validation.rasterHash &&
      descriptor.geometryVersion === validation.geometryVersion &&
      descriptor.renderVersion === manifest.renderVersion &&
      descriptor.profile.id === printSpec.profileId && descriptor.profile.version === printSpec.profileVersion &&
      manifest.cutMarginMm === printSpec.cutMarginMm;
  }, { message: 'Stored artifact must match the record version, validation and print specification.' });

export type PrintSpec = z.infer<typeof PrintSpecSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
