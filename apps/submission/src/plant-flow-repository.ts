import { createHash, randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { PlantCandidate, PlantOutcome } from './plant-job-contract.ts';

export type PlantFlowKey = { eventId: string; visitorSessionId: string; captureId: string };
export type PlantFlow = PlantFlowKey & {
  generationIntentId: string;
  requestFingerprint: string;
  liveDeadlineAt: string;
  fallbackAssetId: string;
  plantJobId: string | null;
  eligibility: 'unknown' | 'eligible' | 'below_threshold' | 'needs_reconciliation';
  identificationSuggestions: { name: string; scoreBps: number }[];
  heldCandidate: { candidate: PlantCandidate; observedAt: string } | null;
  accepted: PlantOutcome | null;
  sproutAck: 'pending' | 'confirmed' | 'needs_reconciliation';
};

export class PlantFlowConflictError extends Error {
  constructor() { super('Plant intent is already bound to different evidence.'); }
}

export interface PlantFlowRepository {
  reserve(input: PlantFlowKey & { requestFingerprint: string; liveDeadlineAt: string; fallbackAssetId: string }): Promise<PlantFlow>;
  get(key: PlantFlowKey): Promise<PlantFlow | null>;
  bind(key: PlantFlowKey, generationIntentId: string, plantJobId: string): Promise<PlantFlow>;
  observe(key: PlantFlowKey, generationIntentId: string, eligibility: PlantFlow['eligibility'],
    suggestions?: PlantFlow['identificationSuggestions']): Promise<PlantFlow>;
  holdCandidate(key: PlantFlowKey, generationIntentId: string, candidate: PlantCandidate,
    observedAt: string): Promise<PlantFlow>;
  commit(key: PlantFlowKey, generationIntentId: string, decision: PlantOutcome): Promise<PlantFlow>;
  recordAck(key: PlantFlowKey, generationIntentId: string, decisionId: string,
    ack: 'confirmed' | 'needs_reconciliation'): Promise<PlantFlow>;
}

function documentId(key: PlantFlowKey): string {
  return createHash('sha256').update(`${key.eventId}\0${key.visitorSessionId}\0${key.captureId}`).digest('hex');
}

export function createPlantFlowRepository(firestore: Firestore): PlantFlowRepository {
  const collection = firestore.collection('natcutPlantFlows');
  const ref = (key: PlantFlowKey) => collection.doc(documentId(key));
  return {
    async reserve(input) {
      const fresh: PlantFlow = {
        eventId: input.eventId, visitorSessionId: input.visitorSessionId, captureId: input.captureId,
        generationIntentId: randomUUID(), requestFingerprint: input.requestFingerprint,
        liveDeadlineAt: input.liveDeadlineAt, fallbackAssetId: input.fallbackAssetId,
        plantJobId: null, eligibility: 'unknown', identificationSuggestions: [], heldCandidate: null,
        accepted: null, sproutAck: 'pending',
      };
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(input));
        if (!snapshot.exists) {
          transaction.create(ref(input), fresh);
          return fresh;
        }
        const existing = snapshot.data() as PlantFlow;
        if (existing.eventId !== input.eventId || existing.visitorSessionId !== input.visitorSessionId ||
          existing.captureId !== input.captureId || existing.requestFingerprint !== input.requestFingerprint ||
          existing.fallbackAssetId !== input.fallbackAssetId) throw new PlantFlowConflictError();
        return existing;
      });
    },
    async get(key) {
      const snapshot = await ref(key).get();
      return snapshot.exists ? snapshot.data() as PlantFlow : null;
    },
    bind(key, generationIntentId, plantJobId) {
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(key));
        if (!snapshot.exists) throw new PlantFlowConflictError();
        const existing = snapshot.data() as PlantFlow;
        if (existing.generationIntentId !== generationIntentId ||
          (existing.plantJobId !== null && existing.plantJobId !== plantJobId)) throw new PlantFlowConflictError();
        if (existing.plantJobId === null) transaction.update(ref(key), { plantJobId });
        return { ...existing, plantJobId };
      });
    },
    observe(key, generationIntentId, eligibility, suggestions) {
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(key));
        if (!snapshot.exists) throw new PlantFlowConflictError();
        const existing = snapshot.data() as PlantFlow;
        if (existing.generationIntentId !== generationIntentId) throw new PlantFlowConflictError();
        if (existing.accepted || existing.eligibility === 'needs_reconciliation') return existing;
        const next = existing.eligibility !== 'unknown' && existing.eligibility !== eligibility
          ? 'needs_reconciliation' : eligibility;
        const identificationSuggestions = suggestions?.length ? suggestions : existing.identificationSuggestions;
        if (next !== existing.eligibility || JSON.stringify(identificationSuggestions) !== JSON.stringify(existing.identificationSuggestions)) {
          transaction.update(ref(key), { eligibility: next, identificationSuggestions });
        }
        return { ...existing, eligibility: next, identificationSuggestions };
      });
    },
    holdCandidate(key, generationIntentId, candidate, observedAt) {
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(key));
        if (!snapshot.exists) throw new PlantFlowConflictError();
        const existing = snapshot.data() as PlantFlow;
        if (existing.generationIntentId !== generationIntentId || !existing.plantJobId ||
          existing.eligibility !== 'eligible' || !Number.isFinite(Date.parse(observedAt)) ||
          Date.parse(observedAt) >= Date.parse(existing.liveDeadlineAt)) throw new PlantFlowConflictError();
        if (existing.accepted) return existing;
        if (existing.heldCandidate) {
          if (existing.heldCandidate && JSON.stringify(existing.heldCandidate.candidate) !== JSON.stringify(candidate)) {
            throw new PlantFlowConflictError();
          }
          return existing;
        }
        const heldCandidate = { candidate, observedAt };
        transaction.update(ref(key), { heldCandidate });
        return { ...existing, heldCandidate };
      });
    },
    commit(key, generationIntentId, decision) {
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(key));
        if (!snapshot.exists) throw new PlantFlowConflictError();
        const existing = snapshot.data() as PlantFlow;
        if (existing.generationIntentId !== generationIntentId || !existing.plantJobId) throw new PlantFlowConflictError();
        if (existing.accepted) return existing;
        if ((existing.eligibility === 'needs_reconciliation' && decision.reason !== 'operator_fallback') ||
          (decision.outcome === 'generated_accepted' && (existing.eligibility !== 'eligible' ||
            !existing.heldCandidate || existing.heldCandidate.candidate.candidateId !== decision.candidateId ||
            decision.reason !== 'candidate_ready_before_deadline')) ||
          (decision.reason === 'deadline_elapsed' && (existing.eligibility !== 'eligible' || existing.heldCandidate)) ||
          (decision.reason === 'identification_below_threshold' && existing.eligibility !== 'below_threshold') ||
          (decision.reason === 'operator_fallback' && !['eligible', 'unknown', 'needs_reconciliation'].includes(existing.eligibility)) ||
          (decision.reason === 'generation_failed' && existing.eligibility !== 'eligible')) {
          throw new PlantFlowConflictError();
        }
        transaction.update(ref(key), { accepted: decision, sproutAck: 'pending' });
        return { ...existing, accepted: decision, sproutAck: 'pending' };
      });
    },
    recordAck(key, generationIntentId, decisionId, ack) {
      return firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(key));
        if (!snapshot.exists) throw new PlantFlowConflictError();
        const existing = snapshot.data() as PlantFlow;
        if (existing.generationIntentId !== generationIntentId || existing.accepted?.decisionId !== decisionId) {
          throw new PlantFlowConflictError();
        }
        if (existing.sproutAck === 'confirmed' || existing.sproutAck === 'needs_reconciliation') return existing;
        transaction.update(ref(key), { sproutAck: ack });
        return { ...existing, sproutAck: ack };
      });
    },
  };
}
