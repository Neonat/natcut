import { createHash } from 'node:crypto';
import { SrgbColorEvidenceSchema, type SrgbColorEvidence } from '@natcut/domain';
import { z } from 'zod';

export const PLANT_JOB_CONTRACT_VERSION = 'sprout-plant-job-v1' as const;
export const PLANT_ID_THRESHOLD_BPS = 7000;
export const LIVE_DEADLINE_MS = 15_000;

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoUtc = z.string().datetime({ offset: true });
const state = z.enum(['received', 'identifying', 'below_threshold', 'generation_queued',
  'generating', 'candidate_ready', 'generation_failed', 'late_completed', 'needs_reconciliation']);
const reason = z.enum(['candidate_approved_before_deadline', 'candidate_ready_before_deadline', 'deadline_elapsed',
  'identification_below_threshold', 'generation_failed', 'operator_fallback']);

export const SourcePhotoReceiptSchema = z.object({
  mediaType: z.enum(['image/jpeg', 'image/png']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  colorEvidence: SrgbColorEvidenceSchema,
}).strict();
export type SourcePhotoReceipt = {
  mediaType: 'image/jpeg' | 'image/png'; width: number; height: number; colorEvidence: SrgbColorEvidence;
};

export const PlantJobCreateResponseSchema = z.object({
  plantJobId: id,
  generationIntentId: id,
  state,
  createdAt: isoUtc,
  liveDeadlineMs: z.literal(LIVE_DEADLINE_MS),
}).strict();
export type PlantJobCreateResponse = z.infer<typeof PlantJobCreateResponseSchema>;

export const PlantCandidateSchema = z.object({
  candidateId: id,
  sha256,
  byteLength: z.number().int().positive(),
  mediaType: z.literal('image/png'),
  objectGeneration: z.string().min(1),
}).strict();
export type PlantCandidate = z.infer<typeof PlantCandidateSchema>;

const outcomeBase = {
  decisionId: id,
  decidedAt: isoUtc,
  reason,
};
export const PlantOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ ...outcomeBase, outcome: z.literal('generated_accepted'), candidateId: id,
    natcutAssetId: z.string().min(1).max(256) }).strict(),
  z.object({ ...outcomeBase, outcome: z.literal('catalog_fallback_accepted'),
    catalogAssetId: z.string().min(1).max(256) }).strict(),
]);
export type PlantOutcome = z.infer<typeof PlantOutcomeSchema>;

export const PlantJobStatusSchema = z.object({
  plantJobId: id,
  generationIntentId: id,
  state,
  createdAt: isoUtc,
  liveDeadlineMs: z.literal(LIVE_DEADLINE_MS),
  identificationThresholdBps: z.literal(PLANT_ID_THRESHOLD_BPS),
  identification: z.object({
    isPlant: z.boolean(),
    suggestions: z.array(z.object({
      name: z.string().min(1), scoreBps: z.number().int().min(0).max(10_000),
    }).strict()),
    thresholdDecision: z.enum(['generate', 'review', 'retake']),
  }).strict().optional(),
  generationReservationId: id.optional(),
  candidate: PlantCandidateSchema.optional(),
  outcome: PlantOutcomeSchema.optional(),
  lateResultStored: z.boolean(),
}).strict();
export type PlantJobStatus = z.infer<typeof PlantJobStatusSchema>;

export type PlantJobCreateRequest = {
  contractVersion: typeof PLANT_JOB_CONTRACT_VERSION;
  generationIntentId: string;
  eventId: string;
  visitorSessionId: string;
  captureId: string;
  sanitizedImageBase64: string;
  sanitizedImageSha256: string;
  sourcePhotoReceipt: SourcePhotoReceipt;
  identificationThresholdBps: typeof PLANT_ID_THRESHOLD_BPS;
  liveDeadlineAt: string;
  policyVersion: string;
  referenceSetId?: string;
};

export function sourcePhotoDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function requestIdentity(input: Omit<PlantJobCreateRequest, 'generationIntentId' | 'liveDeadlineAt'>): string {
  return sourcePhotoDigest(Buffer.from(JSON.stringify(input)));
}
