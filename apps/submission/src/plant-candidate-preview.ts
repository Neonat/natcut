import { normalizeSpritePng } from '@natcut/render';
import type { PlantFlowKey, PlantFlowRepository } from './plant-flow-repository.ts';
import type { SproutPlantJobClient } from './sprout-client.ts';

export class PlantCandidatePreviewUnavailableError extends Error {}

export function createPlantCandidatePreview(deps: {
  flows: PlantFlowRepository;
  sprout: SproutPlantJobClient;
  nowMs?: () => number;
}) {
  const nowMs = deps.nowMs ?? Date.now;
  return async (key: PlantFlowKey, candidateId: string): Promise<Buffer> => {
    const flow = await deps.flows.get(key);
    const remaining = flow ? Date.parse(flow.liveDeadlineAt) - nowMs() : 0;
    if (!flow || !flow.plantJobId || flow.accepted || flow.eligibility === 'needs_reconciliation' || remaining <= 0) {
      throw new PlantCandidatePreviewUnavailableError('Candidate is no longer available for live preview.');
    }
    const status = await deps.sprout.status(flow.plantJobId, AbortSignal.timeout(remaining));
    if (status.plantJobId !== flow.plantJobId || status.generationIntentId !== flow.generationIntentId ||
      status.state !== 'candidate_ready' || status.outcome || status.candidate?.candidateId !== candidateId ||
      Date.parse(flow.liveDeadlineAt) <= nowMs()) {
      throw new PlantCandidatePreviewUnavailableError('Candidate does not match the active plant flow.');
    }
    const bytes = await deps.sprout.candidate(flow.plantJobId, status.candidate,
      AbortSignal.timeout(Math.max(1, Date.parse(flow.liveDeadlineAt) - nowMs())));
    const normalized = await normalizeSpritePng(bytes, candidateId, 20_000_000);
    const latest = await deps.flows.get(key);
    if (!latest || latest.generationIntentId !== flow.generationIntentId || latest.plantJobId !== flow.plantJobId ||
      latest.accepted || Date.parse(latest.liveDeadlineAt) <= nowMs()) {
      throw new PlantCandidatePreviewUnavailableError('Candidate became unavailable during preview.');
    }
    return normalized.png;
  };
}
