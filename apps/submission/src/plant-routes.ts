import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bearerTokenFromHeader, type VerifyBearerToken } from './auth.ts';
import { type PlantCaptureSource, verifyResolvedPlantCapture } from './plant-capture.ts';
import { type createPlantFlowCoordinator, type PlantFlowResult } from './plant-flow.ts';
import type { PlantFlowKey } from './plant-flow-repository.ts';
import { PlantFlowConflictError } from './plant-flow-repository.ts';
import { SproutHttpError } from './sprout-client.ts';
import { sprites } from '@natcut/render';

const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const StartBodySchema = z.object({ captureId: identifier, fallbackAssetId: z.string().min(1).max(256) }).strict();
const CandidateBodySchema = z.object({ candidateId: identifier }).strict();
const CaptureParamsSchema = z.object({ captureId: identifier }).strict();

export type PlantRouteDependencies = {
  eventId: string;
  policyVersion: string;
  referenceSetId?: string;
  captureSource: PlantCaptureSource;
  coordinator: ReturnType<typeof createPlantFlowCoordinator>;
  verifyBearerToken: VerifyBearerToken;
  submitRuntime: (ownerUid: string, flowKey: PlantFlowKey, body: unknown) => Promise<{ statusCode: number; payload: unknown }>;
  readAcceptedSprite?: (flowKey: PlantFlowKey, assetId: string) => Promise<Buffer>;
};

function publicResult(result: PlantFlowResult) {
  if (result.state === 'candidate_available') return { state: result.state,
    generationIntentId: result.generationIntentId, candidateId: result.candidate.candidateId,
    remainingMs: result.remainingMs };
  return result;
}

export function registerPlantRoutes(app: FastifyInstance, prefix: string, deps: PlantRouteDependencies) {
  const route = (path: string) => `${prefix}${path}`;
  const authenticate = async (authorization: string | undefined) => {
    const token = bearerTokenFromHeader(authorization);
    if (!token) return null;
    try { return await deps.verifyBearerToken(token); } catch { return null; }
  };
  const ownedKey = async (ownerUid: string, captureId: string): Promise<PlantFlowKey | null> => {
    const capture = await deps.captureSource.findOwned(ownerUid, deps.eventId, captureId);
    return capture && capture.captureId === captureId && identifier.safeParse(capture.visitorSessionId).success
      ? { eventId: deps.eventId, visitorSessionId: capture.visitorSessionId, captureId } : null;
  };

  app.post(route('/v1/plant-jobs'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const visitor = await authenticate(request.headers.authorization);
    if (!visitor) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const parsed = StartBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_PLANT_START' });
    if (!sprites.some(sprite => sprite.id === parsed.data.fallbackAssetId)) {
      return reply.code(400).send({ error: 'INVALID_FALLBACK_ASSET' });
    }
    const capture = await deps.captureSource.resolveConfirmed(visitor.uid, deps.eventId, parsed.data.captureId);
    if (!capture) return reply.code(404).send({ error: 'CAPTURE_NOT_FOUND' });
    let verified;
    try { verified = await verifyResolvedPlantCapture(capture, parsed.data.captureId); }
    catch { return reply.code(409).send({ error: 'CAPTURE_RECONCILIATION_REQUIRED' }); }
    try {
      const result = await deps.coordinator.begin({ eventId: deps.eventId,
        visitorSessionId: verified.visitorSessionId, captureId: verified.captureId,
        sanitizedImage: verified.sanitizedImage, sourcePhotoReceipt: verified.sourcePhotoReceipt,
        fallbackAssetId: parsed.data.fallbackAssetId, policyVersion: deps.policyVersion,
        ...(deps.referenceSetId ? { referenceSetId: deps.referenceSetId } : {}) });
      return publicResult(result);
    } catch (error) {
      if (error instanceof PlantFlowConflictError) return reply.code(409).send({ error: 'PLANT_INTENT_CONFLICT' });
      if (error instanceof SproutHttpError && error.status >= 500) return reply.code(503).send({ error: 'SPROUT_UNAVAILABLE' });
      throw error;
    }
  });

  const withOwned = async (request: FastifyRequest, reply: FastifyReply,
    action: (key: PlantFlowKey, ownerUid: string) => Promise<unknown>) => {
    const visitor = await authenticate(request.headers.authorization);
    if (!visitor) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    const params = CaptureParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_CAPTURE_ID' });
    const key = await ownedKey(visitor.uid, params.data.captureId);
    if (!key) return reply.code(404).send({ error: 'CAPTURE_NOT_FOUND' });
    try { return await action(key, visitor.uid); }
    catch (error) {
      if (error instanceof PlantFlowConflictError) return reply.code(409).send({ error: 'PLANT_OUTCOME_CONFLICT' });
      if (error instanceof Error && /Unknown plant intent|No accepted plant outcome/.test(error.message)) {
        return reply.code(404).send({ error: 'PLANT_JOB_NOT_FOUND' });
      }
      throw error;
    }
  };

  app.get(route('/v1/plant-jobs/:captureId'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return withOwned(request, reply, async key => publicResult(await deps.coordinator.advance(key)));
  });
  app.post(route('/v1/plant-jobs/:captureId/accept-generated'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const parsed = CandidateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_CANDIDATE' });
    return withOwned(request, reply, async key => publicResult(await deps.coordinator.acceptGenerated(key, parsed.data.candidateId)));
  });
  app.post(route('/v1/plant-jobs/:captureId/accept-fallback'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (request.body && Object.keys(request.body as object).length) return reply.code(400).send({ error: 'INVALID_FALLBACK' });
    return withOwned(request, reply, async key => publicResult(await deps.coordinator.acceptFallback(key, 'identification_below_threshold')));
  });
  app.post(route('/v1/plant-jobs/:captureId/sync-outcome'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return withOwned(request, reply, async key => publicResult(await deps.coordinator.syncOutcome(key)));
  });
  app.post(route('/v1/plant-jobs/:captureId/submissions'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return withOwned(request, reply, async (key, ownerUid) => {
      const result = await deps.submitRuntime(ownerUid, key, request.body);
      return reply.code(result.statusCode).send(result.payload);
    });
  });
  if (deps.readAcceptedSprite) app.get(route('/v1/plant-jobs/:captureId/accepted-sprite'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return withOwned(request, reply, async key => {
      const state = await deps.coordinator.advance(key);
      if (state.state !== 'accepted' || state.decision.outcome !== 'generated_accepted' || state.sproutAck !== 'confirmed') {
        return reply.code(409).send({ error: 'SPRITE_NOT_ACCEPTED' });
      }
      try {
        const bytes = await deps.readAcceptedSprite!(key, state.decision.natcutAssetId);
        return reply.type('image/png').send(bytes);
      } catch {
        return reply.code(409).send({ error: 'SPRITE_UNAVAILABLE' });
      }
    });
  });
}
