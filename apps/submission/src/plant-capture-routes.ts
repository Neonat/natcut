import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerTokenFromHeader, type VerifyBearerToken } from './auth.ts';
import { PlantCaptureConflictError } from './plant-capture-store.ts';

const bodySchema = z.object({
  captureId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  imageBase64: z.string().min(1).max(10_666_668).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

export function registerPlantCaptureRoute(app: FastifyInstance, prefix: string, deps: {
  eventId: string;
  verifyBearerToken: VerifyBearerToken;
  confirm(ownerUid: string, eventId: string, captureId: string, raw: Buffer): Promise<{ captureId: string; status: 'confirmed' }>;
}) {
  app.post(`${prefix}/v1/plant-captures`, { bodyLimit: 11_000_000 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const bearer = bearerTokenFromHeader(request.headers.authorization);
    if (!bearer) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    let visitor;
    try { visitor = await deps.verifyBearerToken(bearer); }
    catch { return reply.code(401).send({ error: 'AUTH_REQUIRED' }); }
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_PLANT_PHOTO' });
    const raw = Buffer.from(parsed.data.imageBase64, 'base64');
    if (raw.length > 8_000_000 || raw.toString('base64') !== parsed.data.imageBase64) {
      return reply.code(400).send({ error: 'INVALID_PLANT_PHOTO' });
    }
    try {
      return reply.code(201).send(await deps.confirm(visitor.uid, deps.eventId, parsed.data.captureId, raw));
    } catch (error) {
      if (error instanceof PlantCaptureConflictError) return reply.code(409).send({ error: 'PLANT_CAPTURE_CONFLICT' });
      if (error instanceof Error && /Plant photo|Unsupported plant photo|Invalid plant capture identity/.test(error.message)) {
        return reply.code(400).send({ error: 'INVALID_PLANT_PHOTO' });
      }
      throw error;
    }
  });
}
