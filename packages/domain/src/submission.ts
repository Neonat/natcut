import { z } from 'zod';
import { GeometryReportSchema } from './geometry.ts';
import { CompositionManifestSchema } from './manifest.ts';
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
  .strict();

export type PrintSpec = z.infer<typeof PrintSpecSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
