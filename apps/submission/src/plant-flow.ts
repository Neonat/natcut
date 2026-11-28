import { createHash } from 'node:crypto';
import { sprites, normalizeSpritePng } from '@natcut/render';
import { LIVE_DEADLINE_MS, PLANT_ID_THRESHOLD_BPS, PLANT_JOB_CONTRACT_VERSION,
  SourcePhotoReceiptSchema, requestIdentity, sourcePhotoDigest,
  type PlantCandidate, type PlantOutcome, type SourcePhotoReceipt } from './plant-job-contract.ts';
import { PlantFlowConflictError, type PlantFlow, type PlantFlowKey, type PlantFlowRepository } from './plant-flow-repository.ts';
import { SproutEvidenceConflictError, SproutHttpError, type SproutPlantJobClient } from './sprout-client.ts';

export type PlantFlowClock = { wallNowMs(): number; monoNowMs(): number };
export const systemPlantFlowClock: PlantFlowClock = {
  wallNowMs: () => Date.now(), monoNowMs: () => performance.now(),
};
class PlantDeadlineError extends Error {}
class PlantCandidateFetchTimeoutError extends Error {}

export type StartPlantFlowInput = PlantFlowKey & {
  sanitizedImage: Buffer;
  sourcePhotoReceipt: SourcePhotoReceipt;
  policyVersion: string;
  referenceSetId?: string;
  fallbackAssetId: string;
};

export interface TrustedCandidateRegistrar {
  stage(input: { flowKey: PlantFlowKey; generationIntentId: string;
    plantJobId: string; candidate: PlantCandidate; bytes: Buffer }): Promise<string>;
}

export function createTrustedCandidateRegistrar(writer: {
  stage(input: { sourcePng: Buffer; sourceSha256: string; sourceByteLength: number;
    png: Buffer; pngSha256: string; colorEvidence: Awaited<ReturnType<typeof normalizeSpritePng>>['colorEvidence'];
    flowKey: PlantFlowKey; generationIntentId: string; plantJobId: string;
    candidateId: string; sourceObjectGeneration: string }): Promise<string>;
}): TrustedCandidateRegistrar {
  return {
    async stage({ flowKey, generationIntentId, plantJobId, candidate, bytes }) {
      const normalized = await normalizeSpritePng(bytes, candidate.candidateId, 20_000_000);
      return writer.stage({ sourcePng: bytes, sourceSha256: candidate.sha256, sourceByteLength: candidate.byteLength,
        png: normalized.png, pngSha256: sourcePhotoDigest(normalized.png),
        colorEvidence: normalized.colorEvidence, flowKey, generationIntentId,
        plantJobId, candidateId: candidate.candidateId,
        sourceObjectGeneration: candidate.objectGeneration });
    },
  };
}

export type PlantFlowResult =
  | { state: 'needs_create_retry'; generationIntentId: string }
  | { state: 'waiting'; generationIntentId: string; remainingMs: number }
  | { state: 'identification_review'; generationIntentId: string; suggestions: { name: string; scoreBps: number }[] }
  | { state: 'candidate_available'; generationIntentId: string; candidate: PlantCandidate; remainingMs: number }
  | { state: 'accepted'; generationIntentId: string; decision: PlantOutcome; sproutAck: 'confirmed' | 'pending' | 'needs_reconciliation' }
  | { state: 'needs_reconciliation'; generationIntentId: string };

export function createPlantFlowCoordinator(deps: {
  repository: PlantFlowRepository;
  sprout: SproutPlantJobClient;
  registrar: TrustedCandidateRegistrar;
  clock?: PlantFlowClock;
}) {
  const clock = deps.clock ?? systemPlantFlowClock;
  const deadlines = new Map<string, number>();
  const remainingMs = (flow: PlantFlow) => {
    const wallRemaining = Date.parse(flow.liveDeadlineAt) - clock.wallNowMs();
    if (!deadlines.has(flow.generationIntentId)) deadlines.set(flow.generationIntentId, clock.monoNowMs() + Math.max(0, wallRemaining));
    return Math.max(0, Math.min(wallRemaining, deadlines.get(flow.generationIntentId)! - clock.monoNowMs()));
  };
  const now = () => new Date(clock.wallNowMs()).toISOString();
  const decisionId = (intentId: string) => createHash('sha256').update(`natcut-plant-outcome\0${intentId}`).digest('hex');
  const reconcile = (flow: PlantFlow): PlantFlowResult => ({ state: 'needs_reconciliation', generationIntentId: flow.generationIntentId });
  const heldCandidateResult = (flow: PlantFlow): PlantFlowResult => ({ state: 'candidate_available',
    generationIntentId: flow.generationIntentId, candidate: flow.heldCandidate!.candidate,
    remainingMs: remainingMs(flow) });
  async function deadlineResult(flow: PlantFlow): Promise<PlantFlowResult> {
    if (flow.heldCandidate) return heldCandidateResult(flow);
    if (flow.eligibility === 'eligible') return commitFallback(flow, 'deadline_elapsed');
    if (flow.eligibility === 'below_threshold') return { state: 'identification_review',
      generationIntentId: flow.generationIntentId, suggestions: flow.identificationSuggestions };
    return reconcile(flow);
  }
  async function withinDeadline<T>(flow: PlantFlow, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const remaining = remainingMs(flow);
    if (remaining === 0) throw new PlantDeadlineError('Plant live deadline elapsed.');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new PlantDeadlineError('Plant live deadline elapsed.')); }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function withinCandidateFetch<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new PlantCandidateFetchTimeoutError('Candidate fetch timed out.'));
      }, 5_000); }),
    ]); }
    finally { clearTimeout(timer); }
  }

  function reportAccepted(flow: PlantFlow): PlantFlowResult {
    if (!flow.accepted || !flow.plantJobId) return reconcile(flow);
    return { state: 'accepted', generationIntentId: flow.generationIntentId,
      decision: flow.accepted, sproutAck: flow.sproutAck };
  }

  async function commitFallback(flow: PlantFlow, reason: 'deadline_elapsed' | 'identification_below_threshold' | 'generation_failed' | 'operator_fallback') {
    const decision: PlantOutcome = { decisionId: decisionId(flow.generationIntentId), decidedAt: now(),
      outcome: 'catalog_fallback_accepted', catalogAssetId: flow.fallbackAssetId, reason };
    try { return reportAccepted(await deps.repository.commit(flow, flow.generationIntentId, decision)); }
    catch (error) {
      if (!(error instanceof PlantFlowConflictError) || reason !== 'deadline_elapsed') throw error;
      const latest = await deps.repository.get(flow);
      if (latest?.heldCandidate) return heldCandidateResult(latest);
      if (latest?.accepted) return reportAccepted(latest);
      throw error;
    }
  }

  return {
    async begin(input: StartPlantFlowInput): Promise<PlantFlowResult> {
      if (!sprites.some(sprite => sprite.id === input.fallbackAssetId)) throw new Error('Fallback must be an approved active catalog sprite.');
      const receipt = SourcePhotoReceiptSchema.parse(input.sourcePhotoReceipt);
      const digest = sourcePhotoDigest(input.sanitizedImage);
      const base = { contractVersion: PLANT_JOB_CONTRACT_VERSION, eventId: input.eventId,
        visitorSessionId: input.visitorSessionId, captureId: input.captureId,
        sanitizedImageBase64: input.sanitizedImage.toString('base64'), sanitizedImageSha256: digest,
        sourcePhotoReceipt: receipt, identificationThresholdBps: PLANT_ID_THRESHOLD_BPS,
        policyVersion: input.policyVersion,
        ...(input.referenceSetId ? { referenceSetId: input.referenceSetId } : {}) } as const;
      const flow = await deps.repository.reserve({ eventId: input.eventId,
        visitorSessionId: input.visitorSessionId, captureId: input.captureId,
        requestFingerprint: requestIdentity(base),
        liveDeadlineAt: new Date(clock.wallNowMs() + LIVE_DEADLINE_MS).toISOString(),
        fallbackAssetId: input.fallbackAssetId });
      if (flow.accepted) return reportAccepted(flow);
      if (flow.eligibility === 'needs_reconciliation') return reconcile(flow);
      if (flow.heldCandidate) return heldCandidateResult(flow);
      if (flow.plantJobId) {
        if (flow.eligibility === 'below_threshold') return { state: 'identification_review',
          generationIntentId: flow.generationIntentId, suggestions: flow.identificationSuggestions };
        return remainingMs(flow) === 0 ? deadlineResult(flow) :
          { state: 'waiting', generationIntentId: flow.generationIntentId, remainingMs: remainingMs(flow) };
      }
      let created;
      try {
        created = await withinDeadline(flow, signal => deps.sprout.create({ ...base,
          generationIntentId: flow.generationIntentId, liveDeadlineAt: flow.liveDeadlineAt }, signal));
      } catch (error) {
        if (error instanceof SproutEvidenceConflictError ||
          (error instanceof SproutHttpError && error.status >= 400 && error.status < 500)) {
          await deps.repository.observe(flow, flow.generationIntentId, 'needs_reconciliation');
          return reconcile(flow);
        }
        if (remainingMs(flow) === 0) return deadlineResult(flow);
        throw error;
      }
      const bound = await deps.repository.bind(flow, flow.generationIntentId, created.plantJobId);
      if (remainingMs(bound) === 0) return deadlineResult(bound);
      return { state: 'waiting', generationIntentId: flow.generationIntentId, remainingMs: remainingMs(bound) };
    },

    async advance(key: PlantFlowKey): Promise<PlantFlowResult> {
      const flow = await deps.repository.get(key);
      if (!flow) throw new Error('Unknown plant intent.');
      if (flow.accepted) return reportAccepted(flow);
      if (flow.heldCandidate) return heldCandidateResult(flow);
      if (!flow.plantJobId) return { state: 'needs_create_retry', generationIntentId: flow.generationIntentId };
      if (flow.eligibility === 'needs_reconciliation') return reconcile(flow);
      if (remainingMs(flow) === 0) return deadlineResult(flow);
      let status;
      try {
        status = await withinDeadline(flow, signal => deps.sprout.status(flow.plantJobId!, signal));
      } catch (error) {
        if (!(error instanceof PlantDeadlineError) && !(error instanceof TypeError) &&
          !(error instanceof SproutHttpError && error.status >= 500)) {
          await deps.repository.observe(key, flow.generationIntentId, 'needs_reconciliation');
          return reconcile(flow);
        }
        if (remainingMs(flow) === 0) return deadlineResult(flow);
        return { state: 'waiting', generationIntentId: flow.generationIntentId, remainingMs: remainingMs(flow) };
      }
      if (status.generationIntentId !== flow.generationIntentId || status.outcome || status.state === 'needs_reconciliation') {
        await deps.repository.observe(key, flow.generationIntentId, 'needs_reconciliation');
        return reconcile(flow);
      }
      const eligibility = status.state === 'below_threshold' ? 'below_threshold' :
        ['generation_queued', 'generating', 'candidate_ready', 'generation_failed', 'late_completed'].includes(status.state)
          ? 'eligible' : 'unknown';
      const observed = eligibility === 'unknown' ? flow : await deps.repository.observe(key, flow.generationIntentId,
        eligibility, status.state === 'below_threshold' ? status.identification?.suggestions ?? [] : undefined);
      if (observed.accepted) return reportAccepted(observed);
      if (observed.eligibility === 'needs_reconciliation') return reconcile(observed);
      if (status.state === 'below_threshold') return { state: 'identification_review',
        generationIntentId: flow.generationIntentId, suggestions: status.identification?.suggestions ?? [] };
      if (remainingMs(observed) === 0) return deadlineResult(observed);
      if (status.state === 'candidate_ready' && status.candidate) {
        try {
          const held = await deps.repository.holdCandidate(key, flow.generationIntentId, status.candidate, now());
          return held.accepted ? reportAccepted(held) : heldCandidateResult(held);
        } catch (error) {
          if (!(error instanceof PlantFlowConflictError)) throw error;
          const latest = await deps.repository.get(key);
          if (!latest) throw error;
          if (latest.accepted) return reportAccepted(latest);
          if (latest.heldCandidate) return heldCandidateResult(latest);
          if (remainingMs(latest) === 0) return deadlineResult(latest);
          throw error;
        }
      }
      if (status.state === 'generation_failed') return commitFallback(observed, 'generation_failed');
      return { state: 'waiting', generationIntentId: flow.generationIntentId, remainingMs: remainingMs(observed) };
    },

    async acceptFallback(key: PlantFlowKey, reason: 'identification_below_threshold' | 'operator_fallback'): Promise<PlantFlowResult> {
      const flow = await deps.repository.get(key);
      if (!flow || !flow.plantJobId) throw new Error('Plant job is not bound.');
      if (flow.accepted) return reportAccepted(flow);
      return commitFallback(flow, flow.eligibility === 'below_threshold' ? reason : 'operator_fallback');
    },

    async acceptGenerated(key: PlantFlowKey, candidateId: string): Promise<PlantFlowResult> {
      let flow = await deps.repository.get(key);
      if (!flow || !flow.plantJobId) throw new Error('Plant job is not bound.');
      if (flow.accepted) return reportAccepted(flow);
      if (flow.eligibility === 'needs_reconciliation') return reconcile(flow);
      if (!flow.heldCandidate) {
        const result = await this.advance(key);
        if (result.state !== 'candidate_available') return result;
        flow = (await deps.repository.get(key))!;
      }
      if (flow.heldCandidate?.candidate.candidateId !== candidateId) {
        throw new SproutEvidenceConflictError('Candidate differs from the on-time held candidate.');
      }
      let natcutAssetId;
      try {
        natcutAssetId = await withinCandidateFetch(async signal => {
          const bytes = await deps.sprout.candidate(flow.plantJobId!, flow.heldCandidate!.candidate, signal);
          return deps.registrar.stage({ flowKey: key, generationIntentId: flow.generationIntentId,
            plantJobId: flow.plantJobId!, candidate: flow.heldCandidate!.candidate, bytes });
        });
      } catch (error) {
        const latest = await deps.repository.get(key);
        if (latest?.accepted) return reportAccepted(latest);
        if (!(error instanceof PlantCandidateFetchTimeoutError) && !(error instanceof TypeError) &&
          !(error instanceof SproutHttpError && error.status >= 500)) {
          await deps.repository.observe(key, flow.generationIntentId, 'needs_reconciliation');
          return reconcile(flow);
        }
        throw error;
      }
      const decision: PlantOutcome = { decisionId: decisionId(flow.generationIntentId), decidedAt: now(),
        outcome: 'generated_accepted', candidateId, natcutAssetId, reason: 'candidate_ready_before_deadline' };
      return reportAccepted(await deps.repository.commit(key, flow.generationIntentId, decision));
    },

    async syncOutcome(key: PlantFlowKey): Promise<PlantFlowResult> {
      const flow = await deps.repository.get(key);
      if (!flow || !flow.accepted || !flow.plantJobId) throw new Error('No accepted plant outcome to synchronize.');
      if (flow.sproutAck !== 'pending') return reportAccepted(flow);
      let ack: 'confirmed' | 'needs_reconciliation' | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.sprout.outcome(flow.plantJobId, flow.accepted),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Sprout outcome acknowledgement timed out.')), 3_000);
          }),
        ]);
        ack = 'confirmed';
      } catch (error) {
        if (error instanceof SproutEvidenceConflictError ||
          (error instanceof SproutHttpError && error.status >= 400 && error.status < 500)) ack = 'needs_reconciliation';
      } finally {
        if (timer) clearTimeout(timer);
      }
      return reportAccepted(ack ? await deps.repository.recordAck(key, flow.generationIntentId, flow.accepted.decisionId, ack) : flow);
    },
  };
}
