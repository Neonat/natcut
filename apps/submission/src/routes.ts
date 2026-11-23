import { createHash, createHmac } from 'node:crypto';
import {
  CompositionManifestSchema,
  DEVFEST_SG_V1,
  canVisitorLeave,
  geometryIssuesHash,
  manifestHash,
} from '@natcut/domain';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { bearerTokenFromHeader, type VerifyBearerToken } from './auth.ts';
import {
  IdempotencyConflictError,
  RequeueForbiddenError,
  type SubmissionRepository,
} from './repository.ts';
import type { ValidateManifest } from './validation.ts';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const CreateBodySchema = z
  .object({
    manifest: CompositionManifestSchema,
    idempotencyKey: z.string().trim().min(1).max(128),
    warningAcknowledgement: z
      .object({
        geometryVersion: z.string().trim().min(1),
        rasterHash: sha256,
        manifestHash: sha256,
        issuesHash: sha256,
      })
      .strict()
      .optional(),
    requeuedFrom: z.string().trim().min(1).max(256).nullable().optional(),
  })
  .strict();

export type SubmissionServerDependencies = {
  eventId: string;
  statusTokenSecret: string;
  repository: SubmissionRepository;
  verifyBearerToken: VerifyBearerToken;
  validateManifest: ValidateManifest;
  now?: () => string;
  corsOrigin?: boolean | string | RegExp;
  routePrefix?: '' | `/${string}`;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function statusToken(secret: string, ownerUid: string, eventId: string, idempotencyKey: string): string {
  return createHmac('sha256', secret)
    .update(`${ownerUid}\0${eventId}\0${idempotencyKey}`)
    .digest('base64url');
}

export function buildSubmissionServer(deps: SubmissionServerDependencies) {
  if (Buffer.byteLength(deps.statusTokenSecret) < 32) throw new Error('statusTokenSecret must be at least 32 bytes');
  const app = Fastify({ logger: false });
  if (deps.corsOrigin !== undefined) void app.register(cors, { origin: deps.corsOrigin });
  const now = deps.now ?? (() => new Date().toISOString());
  const routePrefix = deps.routePrefix?.replace(/\/$/, '') ?? '';
  const route = (path: string) => `${routePrefix}${path}`;

  app.get('/health', async () => ({ ok: true }));
  if (routePrefix) app.get(route('/health'), async () => ({ ok: true }));

  app.post(route('/v1/submissions'), async (request, reply) => {
    const token = bearerTokenFromHeader(request.headers.authorization);
    if (!token) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    let visitor: Awaited<ReturnType<VerifyBearerToken>>;
    try {
      visitor = await deps.verifyBearerToken(token);
    } catch {
      return reply.code(401).send({ error: 'INVALID_AUTH' });
    }

    const parsed = CreateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_SUBMISSION', details: parsed.error.issues });

    let validation;
    try {
      validation = await deps.validateManifest(parsed.data.manifest);
    } catch {
      return reply.code(422).send({ error: 'UNTRACEABLE_ARTWORK' });
    }
    if (!validation.valid || validation.severity === 'error') {
      return reply.code(422).send({ error: 'INVALID_GEOMETRY', validation });
    }

    const acceptedAt = now();
    const canonicalHash = await manifestHash(parsed.data.manifest);
    const trustedIssuesHash = await geometryIssuesHash(validation.issues);
    if (validation.severity === 'warning') {
      const acknowledgement = parsed.data.warningAcknowledgement;
      if (
        !acknowledgement ||
        acknowledgement.geometryVersion !== validation.geometryVersion ||
        acknowledgement.rasterHash !== validation.rasterHash ||
        acknowledgement.manifestHash !== canonicalHash ||
        acknowledgement.issuesHash !== trustedIssuesHash
      ) {
        return reply.code(409).send({ error: 'WARNING_ACKNOWLEDGEMENT_REQUIRED', validation });
      }
      validation = { ...validation, acknowledgedByVisitor: true, acknowledgedAt: acceptedAt };
    }

    const publicStatusToken = statusToken(
      deps.statusTokenSecret,
      visitor.uid,
      deps.eventId,
      parsed.data.idempotencyKey,
    );
    try {
      const result = await deps.repository.create({
        ownerUid: visitor.uid,
        eventId: deps.eventId,
        idempotencyKey: parsed.data.idempotencyKey,
        manifest: parsed.data.manifest,
        manifestHash: canonicalHash,
        printSpec: {
          profileId: DEVFEST_SG_V1.id,
          profileVersion: DEVFEST_SG_V1.version,
          cutMarginMm: parsed.data.manifest.cutMarginMm,
        },
        validation,
        publicStatusTokenHash: hashToken(publicStatusToken),
        acceptedAt,
        requeuedFrom: parsed.data.requeuedFrom ?? null,
      });
      const { submission } = result;
      return reply.code(result.created ? 201 : 200).send({
        submissionId: submission.id,
        queueNumber: submission.queueNumber,
        jobsAhead: submission.jobsAhead,
        publicStatus: submission.publicStatus,
        statusToken: publicStatusToken,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      if (error instanceof RequeueForbiddenError) return reply.code(403).send({ error: 'REQUEUE_FORBIDDEN' });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>(route('/v1/submissions/:id/status'), async (request, reply) => {
    const token = request.headers['x-natcut-status-token'];
    if (typeof token !== 'string' || token.length === 0) return reply.code(401).send({ error: 'STATUS_TOKEN_REQUIRED' });
    const submission = await deps.repository.getPublicStatus(request.params.id, hashToken(token));
    if (!submission) return reply.code(404).send({ error: 'SUBMISSION_NOT_FOUND' });
    return {
      submissionId: submission.id,
      publicStatus: submission.publicStatus,
      queueNumber: submission.queueNumber,
      jobsAhead: submission.jobsAhead,
      canLeaveQueue: canVisitorLeave(submission.publicStatus),
      updatedAt: submission.updatedAt,
    };
  });

  app.post<{ Params: { id: string } }>(route('/v1/submissions/:id/leave'), async (request, reply) => {
    const token = request.headers['x-natcut-status-token'];
    if (typeof token !== 'string' || token.length === 0) return reply.code(401).send({ error: 'STATUS_TOKEN_REQUIRED' });
    const result = await deps.repository.leave(request.params.id, hashToken(token), now());
    if (result === 'not-found') return reply.code(404).send({ error: 'SUBMISSION_NOT_FOUND' });
    if (result === 'locked') return reply.code(409).send({ error: 'QUEUE_LEAVE_LOCKED' });
    return { submissionId: request.params.id, publicStatus: 'cancelled' };
  });

  return app;
}
