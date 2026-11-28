import { createHash } from 'node:crypto';
import { NATIVE_SRGB_EVIDENCE } from '@natcut/domain';
import { assertSupportedRecipe, catalogManifest, sprites } from '@natcut/render';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createPlantFlowCoordinator, createTrustedCandidateRegistrar, type PlantFlowClock } from '../src/plant-flow.ts';
import { PlantFlowConflictError, type PlantFlow, type PlantFlowKey, type PlantFlowRepository } from '../src/plant-flow-repository.ts';
import { sourcePhotoDigest, type PlantCandidate, type PlantJobCreateRequest, type PlantJobStatus, type PlantOutcome } from '../src/plant-job-contract.ts';
import { SproutEvidenceConflictError, SproutHttpError, type SproutPlantJobClient } from '../src/sprout-client.ts';

const key: PlantFlowKey = { eventId: 'devfest-sg', visitorSessionId: 'visitor-1', captureId: 'capture-1' };
const fallbackAssetId = sprites[0]!.id;
const photo = Buffer.from('sanitized-photo');
const input = { ...key, sanitizedImage: photo, sourcePhotoReceipt: {
  mediaType: 'image/jpeg' as const, width: 1, height: 1, colorEvidence: NATIVE_SRGB_EVIDENCE,
}, policyVersion: 'policy-v1', fallbackAssetId };

class MemoryFlows implements PlantFlowRepository {
  flow: PlantFlow | null = null;
  async reserve(value: PlantFlowKey & { requestFingerprint: string; liveDeadlineAt: string; fallbackAssetId: string }) {
    if (!this.flow) this.flow = { ...value, generationIntentId: 'intent-1', plantJobId: null, eligibility: 'unknown',
      identificationSuggestions: [], heldCandidate: null, accepted: null, sproutAck: 'pending' };
    else if (this.flow.requestFingerprint !== value.requestFingerprint || this.flow.fallbackAssetId !== value.fallbackAssetId) throw new PlantFlowConflictError();
    return this.flow;
  }
  async get() { return this.flow; }
  async bind(_key: PlantFlowKey, intentId: string, jobId: string) {
    if (!this.flow || this.flow.generationIntentId !== intentId || (this.flow.plantJobId && this.flow.plantJobId !== jobId)) throw new PlantFlowConflictError();
    this.flow = { ...this.flow, plantJobId: jobId };
    return this.flow;
  }
  async observe(_key: PlantFlowKey, intentId: string, eligibility: PlantFlow['eligibility'],
    suggestions?: PlantFlow['identificationSuggestions']) {
    if (!this.flow || this.flow.generationIntentId !== intentId) throw new PlantFlowConflictError();
    if (this.flow.eligibility === 'needs_reconciliation' || this.flow.accepted) return this.flow;
    this.flow = { ...this.flow, eligibility: this.flow.eligibility !== 'unknown' &&
      this.flow.eligibility !== eligibility ? 'needs_reconciliation' : eligibility,
      identificationSuggestions: suggestions ?? this.flow.identificationSuggestions };
    return this.flow;
  }
  async holdCandidate(_key: PlantFlowKey, intentId: string, candidate: PlantCandidate, observedAt: string) {
    if (!this.flow || this.flow.generationIntentId !== intentId || this.flow.eligibility !== 'eligible' ||
      Date.parse(observedAt) >= Date.parse(this.flow.liveDeadlineAt)) throw new PlantFlowConflictError();
    if (this.flow.accepted) return this.flow;
    if (this.flow.heldCandidate && this.flow.heldCandidate.candidate.candidateId !== candidate.candidateId) throw new PlantFlowConflictError();
    this.flow = { ...this.flow, heldCandidate: this.flow.heldCandidate ?? { candidate, observedAt } };
    return this.flow;
  }
  async commit(_key: PlantFlowKey, intentId: string, decision: PlantOutcome) {
    if (!this.flow || this.flow.generationIntentId !== intentId || !this.flow.plantJobId) throw new PlantFlowConflictError();
    if (this.flow.eligibility === 'needs_reconciliation' ||
      (decision.reason === 'deadline_elapsed' && this.flow.eligibility !== 'eligible')) throw new PlantFlowConflictError();
    if (!this.flow.accepted) this.flow = { ...this.flow, accepted: decision };
    return this.flow;
  }
  async recordAck(_key: PlantFlowKey, intentId: string, decisionId: string,
    ack: 'confirmed' | 'needs_reconciliation') {
    if (!this.flow || this.flow.generationIntentId !== intentId || this.flow.accepted?.decisionId !== decisionId) {
      throw new PlantFlowConflictError();
    }
    if (this.flow.sproutAck === 'pending') this.flow = { ...this.flow, sproutAck: ack };
    return this.flow;
  }
}

function harness() {
  let wall = 1_800_000_000_000;
  let mono = 100;
  const clock: PlantFlowClock = { wallNowMs: () => wall, monoNowMs: () => mono };
  const tick = (ms: number) => { wall += ms; mono += ms; };
  const regressWall = (ms: number) => { wall -= ms; };
  let currentStatus: PlantJobStatus = {
    plantJobId: 'job-1', generationIntentId: 'intent-1', state: 'generating',
    createdAt: new Date(wall).toISOString(), liveDeadlineMs: 15_000, identificationThresholdBps: 7000,
    lateResultStored: false,
  };
  const create = vi.fn(async (request: PlantJobCreateRequest) => ({
    plantJobId: 'job-1', generationIntentId: request.generationIntentId,
    state: 'received' as const, createdAt: new Date(wall).toISOString(), liveDeadlineMs: 15_000 as const,
  }));
  const status = vi.fn(async () => currentStatus);
  const candidate = vi.fn(async () => Buffer.from('candidate'));
  const outcome = vi.fn(async (_jobId: string, decision: PlantOutcome) => decision);
  const sprout: SproutPlantJobClient = { create, status, candidate, outcome };
  const repository = new MemoryFlows();
  const stage = vi.fn(async () => 'sprite/trusted-generated');
  const coordinator = createPlantFlowCoordinator({ repository, sprout, registrar: { stage }, clock });
  return { coordinator, repository, create, status, candidate, outcome, stage, tick, regressWall,
    setStatus: (value: Partial<PlantJobStatus>) => { currentStatus = { ...currentStatus, ...value }; } };
}

const candidateMeta: PlantCandidate = { candidateId: 'candidate-1', mediaType: 'image/png',
  sha256: sourcePhotoDigest(Buffer.from('candidate')), byteLength: 9, objectGeneration: '123' };

it('retries a lost create response with the same intent and original deadline', async () => {
  const h = harness();
  h.create.mockRejectedValueOnce(new Error('response lost'));
  await expect(h.coordinator.begin(input)).rejects.toThrow('response lost');
  const first = h.create.mock.calls[0]![0];
  h.tick(4_000);
  await h.coordinator.begin(input);
  expect(h.create.mock.calls[1]![0]).toEqual(first);
  expect(h.repository.flow!.liveDeadlineAt).toBe(first.liveDeadlineAt);
  await expect(h.coordinator.begin({ ...input, sanitizedImage: Buffer.from('different') })).rejects.toBeInstanceOf(PlantFlowConflictError);
});

it('holds a conflicting create response for reconciliation across retries', async () => {
  const h = harness();
  h.create.mockRejectedValueOnce(new SproutEvidenceConflictError('different intent'));
  expect(await h.coordinator.begin(input)).toMatchObject({ state: 'needs_reconciliation' });
  expect(h.repository.flow!.eligibility).toBe('needs_reconciliation');
  expect(await h.coordinator.begin(input)).toMatchObject({ state: 'needs_reconciliation' });
  expect(h.create).toHaveBeenCalledTimes(1);
});

it('commits one immutable fallback at the monotonic deadline and retries a lost outcome acknowledgement', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.tick(14_999);
  expect((await h.coordinator.advance(key)).state).toBe('waiting');
  h.tick(1);
  h.outcome.mockRejectedValueOnce(new Error('response lost'));
  const first = await h.coordinator.advance(key);
  expect(first).toMatchObject({ state: 'accepted', sproutAck: 'pending', decision: {
    outcome: 'catalog_fallback_accepted', catalogAssetId: fallbackAssetId, reason: 'deadline_elapsed' } });
  expect(h.outcome).not.toHaveBeenCalled();
  expect(await h.coordinator.syncOutcome(key)).toMatchObject({ state: 'accepted', sproutAck: 'pending' });
  h.setStatus({ state: 'late_completed', lateResultStored: true, candidate: candidateMeta });
  const retry = await h.coordinator.syncOutcome(key);
  expect(retry).toMatchObject({ state: 'accepted', sproutAck: 'confirmed', decision: h.repository.flow!.accepted });
  expect(h.outcome.mock.calls[1]![1]).toEqual(h.outcome.mock.calls[0]![1]);
  expect(h.candidate).not.toHaveBeenCalled();
  expect(h.stage).not.toHaveBeenCalled();
});

it('accepts a trusted candidate before deadline and never replaces it with fallback', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.setStatus({ state: 'candidate_ready', candidate: candidateMeta });
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'candidate_available', candidate: candidateMeta });
  const accepted = await h.coordinator.acceptGenerated(key, candidateMeta.candidateId);
  expect(accepted).toMatchObject({ state: 'accepted', decision: {
    outcome: 'generated_accepted', candidateId: candidateMeta.candidateId, natcutAssetId: 'sprite/trusted-generated' } });
  h.tick(20_000);
  expect((await h.coordinator.acceptFallback(key, 'operator_fallback'))).toEqual(accepted);
  expect(h.stage).toHaveBeenCalledTimes(1);
});

it('keeps an on-time candidate available for visitor review after the generation deadline', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.setStatus({ state: 'candidate_ready', candidate: candidateMeta });
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'candidate_available' });
  h.tick(15_001);
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'candidate_available', candidate: candidateMeta });
  expect(await h.coordinator.acceptGenerated(key, candidateMeta.candidateId)).toMatchObject({ state: 'accepted',
    decision: { outcome: 'generated_accepted', reason: 'candidate_ready_before_deadline' } });
});

it('does not expose a candidate first observed after the generation deadline', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.tick(15_000);
  h.setStatus({ state: 'late_completed', lateResultStored: true, candidate: candidateMeta });
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'accepted',
    decision: { outcome: 'catalog_fallback_accepted', reason: 'deadline_elapsed' } });
  expect(h.repository.flow!.heldCandidate).toBeNull();
  expect(h.stage).not.toHaveBeenCalled();
});

it('lets a visitor choose the catalog fallback after an on-time candidate is held', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  h.setStatus({ state: 'candidate_ready', candidate: candidateMeta });
  await h.coordinator.advance(key);
  h.tick(15_001);
  expect(await h.coordinator.acceptFallback(key, 'identification_below_threshold')).toMatchObject({ state: 'accepted',
    decision: { outcome: 'catalog_fallback_accepted', reason: 'operator_fallback' } });
  expect(h.stage).not.toHaveBeenCalled();
});

it('holds a different Sprout outcome for reconciliation and never synthesizes acceptance', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.setStatus({ outcome: { decisionId: 'foreign', decidedAt: new Date(1_800_000_000_000).toISOString(),
    outcome: 'catalog_fallback_accepted', catalogAssetId: fallbackAssetId, reason: 'operator_fallback' } });
  expect(await h.coordinator.advance(key)).toEqual({ state: 'needs_reconciliation', generationIntentId: 'intent-1' });
  expect(h.repository.flow!.accepted).toBeNull();
  h.tick(15_000);
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'needs_reconciliation' });
  expect(h.outcome).not.toHaveBeenCalled();
});

it('holds malformed remote evidence through the deadline', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.status.mockRejectedValueOnce(new SproutEvidenceConflictError('wrong job'));
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'needs_reconciliation' });
  expect(h.repository.flow!.accepted).toBeNull();
  h.tick(15_000);
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'needs_reconciliation' });
});

it('marks a contradictory outcome acknowledgement for reconciliation', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.tick(15_000);
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'accepted', sproutAck: 'pending' });
  h.outcome.mockRejectedValueOnce(new SproutEvidenceConflictError('different outcome'));
  expect(await h.coordinator.syncOutcome(key)).toMatchObject({ state: 'accepted', sproutAck: 'needs_reconciliation' });
});

it('keeps a below-threshold visitor in identification review after 15 seconds', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  h.setStatus({ state: 'below_threshold', identification: { isPlant: true,
    suggestions: [{ name: 'Rose', scoreBps: 6500 }], thresholdDecision: 'review' } });
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'identification_review',
    suggestions: [{ name: 'Rose', scoreBps: 6500 }] });
  h.tick(15_000);
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'identification_review',
    suggestions: [{ name: 'Rose', scoreBps: 6500 }] });
  expect(h.repository.flow!.accepted).toBeNull();
  expect(h.outcome).not.toHaveBeenCalled();
});

it('bounds a stalled status read by the remaining wait and falls back only for known eligible generation', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.tick(14_995);
  h.status.mockImplementationOnce(() => new Promise(() => { setTimeout(() => h.tick(5), 5); }));
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'accepted',
    decision: { outcome: 'catalog_fallback_accepted', reason: 'deadline_elapsed' } });
});

it('holds an unknown identification state when status stalls through the deadline', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  h.tick(14_995);
  h.status.mockImplementationOnce(() => new Promise(() => { setTimeout(() => h.tick(5), 5); }));
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'needs_reconciliation' });
  expect(h.repository.flow!.accepted).toBeNull();
});

it('commits eligible fallback when monotonic time expires despite wall-clock rollback', async () => {
  const h = harness();
  await h.coordinator.begin(input);
  await h.coordinator.advance(key);
  h.tick(14_999);
  h.regressWall(5_000);
  h.tick(1);
  expect(await h.coordinator.advance(key)).toMatchObject({ state: 'accepted',
    decision: { outcome: 'catalog_fallback_accepted', reason: 'deadline_elapsed' } });
});

it('does not expose or import a candidate if a concurrent fallback commits during status observation', async () => {
  for (const action of ['advance', 'accept'] as const) {
    const h = harness();
    await h.coordinator.begin(input);
    h.setStatus({ state: 'candidate_ready', candidate: candidateMeta });
    const original = h.repository.observe.bind(h.repository);
    h.repository.observe = async (...args) => {
      const observed = await original(...args);
      const accepted: PlantOutcome = { decisionId: 'winning-fallback', decidedAt: new Date(1_800_000_000_000).toISOString(),
        outcome: 'catalog_fallback_accepted', catalogAssetId: fallbackAssetId, reason: 'operator_fallback' };
      h.repository.flow = { ...observed, accepted };
      return h.repository.flow;
    };
    const result = action === 'advance' ? await h.coordinator.advance(key) :
      await h.coordinator.acceptGenerated(key, candidateMeta.candidateId);
    expect(result).toMatchObject({ state: 'accepted', decision: { outcome: 'catalog_fallback_accepted' } });
    expect(h.candidate).not.toHaveBeenCalled();
    expect(h.stage).not.toHaveBeenCalled();
  }
});

it('bounds a hung create, including identity-token acquisition, without restarting the intent', async () => {
  const h = harness();
  h.create.mockRejectedValueOnce(new TypeError('network unavailable'));
  await expect(h.coordinator.begin(input)).rejects.toThrow('network unavailable');
  h.tick(14_995);
  h.create.mockImplementationOnce(() => new Promise(() => { setTimeout(() => h.tick(5), 5); }));
  expect(await h.coordinator.begin(input)).toMatchObject({ state: 'needs_reconciliation' });
  expect(h.repository.flow!.plantJobId).toBeNull();
  expect(h.create).toHaveBeenCalledTimes(2);
});

it('revalidates fetched candidate PNG through the merged trusted sRGB boundary', async () => {
  const stage = vi.fn(async ({ png }: { png: Buffer }) => `sprite/${createHash('sha256').update(png).digest('hex')}`);
  const registrar = createTrustedCandidateRegistrar({ stage });
  const untagged = await sharp(Buffer.from([119, 255, 0, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  await expect(registrar.stage({ flowKey: key, generationIntentId: 'intent-1',
    plantJobId: 'job-1', candidate: candidateMeta, bytes: untagged })).rejects.toThrow(/untagged/i);
  expect(stage).not.toHaveBeenCalled();
  const tagged = await sharp(Buffer.from([119, 255, 0, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  }).withIccProfile('srgb').png().toBuffer();
  const assetId = await registrar.stage({ flowKey: key, generationIntentId: 'intent-1',
    plantJobId: 'job-1', candidate: candidateMeta, bytes: tagged });
  expect(assetId).toMatch(/^sprite\/[a-f0-9]{64}$/);
  expect(stage.mock.calls[0]![0]).toMatchObject({ plantJobId: 'job-1', candidateId: 'candidate-1' });
  expect(() => assertSupportedRecipe({ ...catalogManifest, spriteAssetId: assetId })).toThrow(/unsupported catalog composition/i);
});
