import { expect, it, vi } from 'vitest';
import { NATIVE_SRGB_EVIDENCE } from '@natcut/domain';
import { createSproutPlantJobClient, SproutHttpError } from '../src/sprout-client.ts';
import { PLANT_JOB_CONTRACT_VERSION, sourcePhotoDigest, type PlantJobCreateRequest } from '../src/plant-job-contract.ts';

const bytes = Buffer.from('tagged-png');
const createdAt = '2026-11-28T00:00:00.000Z';
const request: PlantJobCreateRequest = {
  contractVersion: PLANT_JOB_CONTRACT_VERSION, generationIntentId: 'intent-1', eventId: 'devfest-sg',
  visitorSessionId: 'visitor-1', captureId: 'capture-1', sanitizedImageBase64: bytes.toString('base64'),
  sanitizedImageSha256: sourcePhotoDigest(bytes), sourcePhotoReceipt: {
    mediaType: 'image/png', width: 1, height: 1, colorEvidence: NATIVE_SRGB_EVIDENCE,
  }, identificationThresholdBps: 7000, liveDeadlineAt: '2026-11-28T00:00:15.000Z', policyVersion: 'policy-v1',
};

it('uses the Cloud Run audience, bearer token, and exact idempotency intent', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const tokenForAudience = vi.fn(async () => 'oidc-token');
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app', tokenForAudience,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ plantJobId: 'job-1', generationIntentId: 'intent-1', state: 'received',
        createdAt, liveDeadlineMs: 15_000 });
    } });
  await client.create(request);
  expect(tokenForAudience).toHaveBeenCalledWith('https://sprout.example.run.app');
  expect(calls[0]!.url).toBe('https://sprout.example.run.app/v1/plant-jobs');
  expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer oidc-token', 'Idempotency-Key': 'intent-1' });
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual(request);
});

it('rejects changed create identity and status with private or mismatched fields', async () => {
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token',
    fetch: async (url) => Response.json(String(url).endsWith('/plant-jobs')
      ? { plantJobId: 'job-1', generationIntentId: 'different', state: 'received', createdAt, liveDeadlineMs: 15_000 }
      : { plantJobId: 'job-1', generationIntentId: 'intent-1', state: 'generating', createdAt,
        liveDeadlineMs: 15_000, identificationThresholdBps: 7000, lateResultStored: false, providerPayload: 'secret' }) });
  await expect(client.create(request)).rejects.toThrow(/different generation intent/);
  await expect(client.status('job-1')).rejects.toThrow();
});

it('verifies candidate media type, exact length, and digest before passing bytes to ingestion', async () => {
  let tamper = false;
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token',
    fetch: async () => new Response(tamper ? Buffer.from('bad') : bytes, { headers: { 'content-type': 'image/png' } }) });
  const candidate = { candidateId: 'candidate-1', mediaType: 'image/png' as const,
    byteLength: bytes.length, sha256: sourcePhotoDigest(bytes), objectGeneration: '42' };
  expect(await client.candidate('job-1', candidate)).toEqual(bytes);
  tamper = true;
  await expect(client.candidate('job-1', candidate)).rejects.toThrow(/digest or length/);
});

it('does not accept a different outcome after a lost acknowledgement', async () => {
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token',
    fetch: async () => Response.json({ decisionId: 'decision-1', decidedAt: createdAt,
      outcome: 'catalog_fallback_accepted', catalogAssetId: 'sprite/other', reason: 'deadline_elapsed' }) });
  await expect(client.outcome('job-1', { decisionId: 'decision-1', decidedAt: createdAt,
    outcome: 'catalog_fallback_accepted', catalogAssetId: 'sprite/approved', reason: 'deadline_elapsed' }))
    .rejects.toThrow(/different outcome/);
});

it('accepts an identical committed outcome regardless of JSON field order', async () => {
  const decision = { decisionId: 'decision-1', decidedAt: createdAt,
    outcome: 'catalog_fallback_accepted' as const, catalogAssetId: 'sprite/approved', reason: 'deadline_elapsed' as const };
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token',
    fetch: async () => Response.json({ reason: decision.reason, catalogAssetId: decision.catalogAssetId,
      outcome: decision.outcome, decidedAt: decision.decidedAt, decisionId: decision.decisionId }) });
  await expect(client.outcome('job-1', decision)).resolves.toEqual(decision);
});

it('treats a malformed successful outcome response as contradictory evidence', async () => {
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token', fetch: async () => new Response('{bad', { status: 200 }) });
  await expect(client.outcome('job-1', { decisionId: 'decision-1', decidedAt: createdAt,
    outcome: 'catalog_fallback_accepted', catalogAssetId: 'sprite/approved', reason: 'deadline_elapsed' }))
    .rejects.toThrow(/invalid Sprout JSON/i);
});

it('surfaces a Sprout conflict without automatic retry', async () => {
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token', fetch: async () => new Response(null, { status: 409 }) });
  await expect(client.create(request)).rejects.toBeInstanceOf(SproutHttpError);
});

it('stops a chunked JSON response when it exceeds the cap', async () => {
  let cancelled = false;
  const client = createSproutPlantJobClient({ serviceUrl: 'https://sprout.example.run.app',
    tokenForAudience: async () => 'token',
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
      cancel() { cancelled = true; },
    })) });
  await expect(client.status('job-1')).rejects.toThrow(/oversized/i);
  expect(cancelled).toBe(true);
});
