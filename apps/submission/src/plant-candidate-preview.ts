import { normalizeSpritePng } from '@natcut/render';
import { isDeepStrictEqual } from 'node:util';
import type { PlantCandidate } from './plant-job-contract.ts';
import type { PlantFlow, PlantFlowKey, PlantFlowRepository } from './plant-flow-repository.ts';
import type { SproutPlantJobClient } from './sprout-client.ts';

export class PlantCandidatePreviewUnavailableError extends Error {}

export function createPlantCandidatePreview(deps: {
  flows: PlantFlowRepository;
  sprout: SproutPlantJobClient;
  nowMs?: () => number;
}) {
  const nowMs = deps.nowMs ?? Date.now;
  const heldOnTime = (flow: PlantFlow, candidateId: string): PlantCandidate | null => {
    const held = (flow as PlantFlow & { heldCandidate?: { candidate: PlantCandidate; observedAt: string } | null }).heldCandidate;
    return held && held.candidate.candidateId === candidateId &&
      Date.parse(held.observedAt) < Date.parse(flow.liveDeadlineAt) ? held.candidate : null;
  };
  return async (key: PlantFlowKey, candidateId: string): Promise<Buffer> => {
    const flow = await deps.flows.get(key);
    const remaining = flow ? Date.parse(flow.liveDeadlineAt) - nowMs() : 0;
    if (!flow || !flow.plantJobId || flow.accepted || flow.eligibility === 'needs_reconciliation') {
      throw new PlantCandidatePreviewUnavailableError('Candidate is no longer available for live preview.');
    }
    let candidate = heldOnTime(flow, candidateId);
    if (!candidate) {
      if (remaining <= 0) throw new PlantCandidatePreviewUnavailableError('Candidate is no longer available for live preview.');
      const status = await deps.sprout.status(flow.plantJobId, AbortSignal.timeout(remaining));
      if (status.plantJobId !== flow.plantJobId || status.generationIntentId !== flow.generationIntentId ||
        status.state !== 'candidate_ready' || status.outcome || status.candidate?.candidateId !== candidateId ||
        Date.parse(flow.liveDeadlineAt) <= nowMs()) {
        throw new PlantCandidatePreviewUnavailableError('Candidate does not match the active plant flow.');
      }
      candidate = status.candidate;
    }
    const bytes = await deps.sprout.candidate(flow.plantJobId, candidate,
      AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining > 0 ? remaining : 10_000))));
    const normalized = await normalizeSpritePng(bytes, candidateId, 20_000_000);
    const latest = await deps.flows.get(key);
    if (!latest || latest.generationIntentId !== flow.generationIntentId || latest.plantJobId !== flow.plantJobId ||
      latest.accepted || (Date.parse(latest.liveDeadlineAt) <= nowMs() &&
        !isDeepStrictEqual(heldOnTime(latest, candidateId), candidate))) {
      throw new PlantCandidatePreviewUnavailableError('Candidate became unavailable during preview.');
    }
    return normalized.png;
  };
}
