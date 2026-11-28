import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { sourcePhotoDigest } from '../src/plant-job-contract.ts';
import type { PlantCandidate } from '../src/plant-job-contract.ts';
import { createPlantCandidatePreview } from '../src/plant-candidate-preview.ts';
import { registerPlantRoutes } from '../src/plant-routes.ts';
import type { createPlantFlowCoordinator } from '../src/plant-flow.ts';
import type { PlantFlow, PlantFlowRepository } from '../src/plant-flow-repository.ts';
import type { SproutPlantJobClient } from '../src/sprout-client.ts';
import Fastify from 'fastify';

it('shows only the active matching candidate without staging or accepting it', async () => {
  const source = await sharp(Buffer.from([220, 50, 60, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  }).withIccProfile('srgb').png().toBuffer();
  const key = { eventId: 'event', visitorSessionId: 'visitor', captureId: 'capture' };
  const flow: PlantFlow & { heldCandidate?: { candidate: PlantCandidate; observedAt: string } | null } = { ...key, generationIntentId: 'intent', requestFingerprint: 'fingerprint',
    liveDeadlineAt: new Date(20_000).toISOString(), fallbackAssetId: 'sprite/monstera-v1',
    plantJobId: 'job', eligibility: 'eligible', identificationSuggestions: [], accepted: null, sproutAck: 'pending' };
  const get = vi.fn(async () => flow);
  const flows = { get } as unknown as PlantFlowRepository;
  const candidate = { candidateId: 'candidate', mediaType: 'image/png' as const,
    sha256: sourcePhotoDigest(source), byteLength: source.length, objectGeneration: '1' };
  const status = vi.fn(async () => ({ plantJobId: 'job', generationIntentId: 'intent',
    state: 'candidate_ready' as const, createdAt: new Date(1_000).toISOString(),
    liveDeadlineMs: 15_000 as const, identificationThresholdBps: 7000 as const,
    candidate, lateResultStored: false }));
  const fetchCandidate = vi.fn(async () => source);
  const sprout = { status, candidate: fetchCandidate } as unknown as SproutPlantJobClient;
  let currentMs = 10_000;
  const preview = createPlantCandidatePreview({ flows, sprout, nowMs: () => currentMs });
  const png = await preview(key, 'candidate');
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(status).toHaveBeenCalledOnce();
  expect(fetchCandidate).toHaveBeenCalledOnce();
  await expect(preview(key, 'other')).rejects.toThrow(/does not match/i);
  currentMs = 25_000;
  await expect(preview(key, 'candidate')).rejects.toThrow(/no longer available/i);
  flow.heldCandidate = { candidate, observedAt: new Date(15_000).toISOString() };
  await expect(preview(key, 'candidate')).resolves.toEqual(png);
  expect(status).toHaveBeenCalledTimes(2);
  flow.accepted = { decisionId: 'decision', decidedAt: new Date(10_000).toISOString(),
    outcome: 'catalog_fallback_accepted', catalogAssetId: 'sprite/monstera-v1', reason: 'operator_fallback' };
  await expect(preview(key, 'candidate')).rejects.toThrow(/no longer available/i);
  expect(fetchCandidate).toHaveBeenCalledTimes(2);
});

it('requires the capture owner before serving candidate PNG bytes', async () => {
  const app = Fastify();
  const png = Buffer.from('preview png');
  const previewCandidate = vi.fn(async () => png);
  registerPlantRoutes(app, '/api', { eventId: 'event', policyVersion: 'policy',
    captureSource: {
      async findOwned(uid, _eventId, captureId) {
        return uid === 'owner' ? { visitorSessionId: 'session', captureId } : null;
      },
      async resolveConfirmed() { return null; },
    },
    coordinator: {} as ReturnType<typeof createPlantFlowCoordinator>,
    verifyBearerToken: async token => { if (token !== 'owner' && token !== 'stranger') throw new Error('auth'); return { uid: token }; },
    submitRuntime: async () => ({ statusCode: 500, payload: {} }),
    previewCandidate,
  });
  const url = '/api/v1/plant-jobs/capture/candidates/candidate';
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer stranger' } })).statusCode).toBe(404);
  const response = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer owner' } });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('image/png');
  expect(response.rawPayload).toEqual(png);
  expect(previewCandidate).toHaveBeenCalledWith({ eventId: 'event', visitorSessionId: 'session', captureId: 'capture' }, 'candidate');
  await app.close();
});
