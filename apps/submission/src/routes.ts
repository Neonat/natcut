import { createHash, createHmac } from 'node:crypto';
import {
  CompositionManifestSchema,
  canVisitorLeave,
  geometryIssuesHash,
  manifestHash,
  type CompositionManifest,
  type LogicalSourceBundle,
  type Submission,
} from '@natcut/domain';
import type { ArtifactPublisher } from '@natcut/artifacts';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { bearerTokenFromHeader, type VerifyBearerToken } from './auth.ts';
import {
  IdempotencyConflictError,
  RequeueForbiddenError,
  type SubmissionRepository,
} from './repository.ts';
import { SurveyUnavailableError, type SurveyRepository } from './survey-repository.ts';
import type { PreparedTrustedArtifact } from './validation.ts';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const CuteRatingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const FirestoreDocumentIdSchema = z.string().trim().min(1).max(256).regex(/^[^/]+$/);
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
    requeuedFrom: FirestoreDocumentIdSchema.nullable().optional(),
  })
  .strict();

const SurveyBodySchema = z.discriminatedUnion('marketingOptIn', [
  z.object({
    stickerSubmissionId: FirestoreDocumentIdSchema,
    cuteRating: CuteRatingSchema,
    marketingOptIn: z.literal(false),
  }).strict(),
  z.object({
    stickerSubmissionId: FirestoreDocumentIdSchema,
    cuteRating: CuteRatingSchema,
    marketingOptIn: z.literal(true),
    email: z.string().trim().email().max(254),
  }).strict(),
]);

export type SubmissionServerDependencies = {
  eventId: string;
  statusTokenSecret: string;
  repository: SubmissionRepository;
  surveyRepository: SurveyRepository;
  verifyBearerToken: VerifyBearerToken;
  prepareArtifact: (manifest: CompositionManifest) => Promise<Pick<PreparedTrustedArtifact, 'report' | 'bundle'>>;
  publisher: ArtifactPublisher;
  now?: () => string;
  corsOrigin?: boolean | string | RegExp;
  routePrefix?: '' | `/${string}`;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const storageDeadlineMs = 30_000;
async function publishWithDeadline(publisher: ArtifactPublisher, bundle: LogicalSourceBundle) {
  const deadline = Promise.withResolvers<never>();
  const controller = new AbortController();
  const expiresAt = performance.now() + storageDeadlineMs;
  const timeoutError = new Error('Artifact publication deadline exceeded');
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
    deadline.reject(timeoutError);
  }, storageDeadlineMs);
  try {
    const receipt = await Promise.race([publisher.publish(bundle, { signal: controller.signal }), deadline.promise]);
    if (performance.now() >= expiresAt) throw timeoutError;
    return receipt;
  } finally {
    clearTimeout(timer);
  }
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

    const { manifest, idempotencyKey, warningAcknowledgement } = parsed.data;
    const lookup = {
      ownerUid: visitor.uid, eventId: deps.eventId, idempotencyKey,
      manifestHash: await manifestHash(manifest), requeuedFrom: parsed.data.requeuedFrom ?? null,
    };
    const publicStatusToken = statusToken(deps.statusTokenSecret, visitor.uid, deps.eventId, idempotencyKey);
    const sendAccepted = (submission: Submission, created: boolean) => reply.code(created ? 201 : 200).send({
      submissionId: submission.id, queueNumber: submission.queueNumber, jobsAhead: submission.jobsAhead,
      publicStatus: submission.publicStatus, statusToken: publicStatusToken,
    });
    try {
      const existing = await deps.repository.findAccepted(lookup);
      if (existing) return sendAccepted(existing, false);

      let prepared;
      try {
        prepared = await deps.prepareArtifact(manifest);
      } catch {
        return reply.code(422).send({ error: 'UNTRACEABLE_ARTWORK' });
      }
      let validation = prepared.report;
      if (!validation.valid || validation.severity === 'error') {
        return reply.code(422).send({ error: 'INVALID_GEOMETRY', validation });
      }
      const acceptedAt = now();
      if (validation.severity === 'warning') {
        if (!warningAcknowledgement ||
          warningAcknowledgement.geometryVersion !== validation.geometryVersion ||
          warningAcknowledgement.rasterHash !== validation.rasterHash ||
          warningAcknowledgement.manifestHash !== lookup.manifestHash ||
          warningAcknowledgement.issuesHash !== await geometryIssuesHash(validation.issues)) {
          return reply.code(409).send({ error: 'WARNING_ACKNOWLEDGEMENT_REQUIRED', validation });
        }
        validation = { ...validation, acknowledgedByVisitor: true, acknowledgedAt: acceptedAt };
      }
      let artifact;
      try {
        artifact = await publishWithDeadline(deps.publisher, prepared.bundle);
      } catch {
        return reply.code(503).send({ error: 'ARTIFACT_STORAGE_UNAVAILABLE' });
      }
      const profile = prepared.bundle.descriptor.profile;
      const result = await deps.repository.create({
        ...lookup, manifest, artifact,
        printSpec: {
          profileId: profile.id,
          profileVersion: profile.version,
          cutMarginMm: manifest.cutMarginMm,
        },
        validation,
        publicStatusTokenHash: hashToken(publicStatusToken),
        acceptedAt,
      });
      return sendAccepted(result.submission, result.created);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: 'IDEMPOTENCY_CONFLICT' });
      if (error instanceof RequeueForbiddenError) return reply.code(403).send({ error: 'REQUEUE_FORBIDDEN' });
      throw error;
    }
  });

  app.post(route('/v1/surveys'), async (request, reply) => {
    const token = bearerTokenFromHeader(request.headers.authorization);
    if (!token) return reply.code(401).send({ error: 'AUTH_REQUIRED' });

    let visitor: Awaited<ReturnType<VerifyBearerToken>>;
    try {
      visitor = await deps.verifyBearerToken(token);
    } catch {
      return reply.code(401).send({ error: 'INVALID_AUTH' });
    }

    const parsed = SurveyBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_SURVEY', details: parsed.error.issues });
    try {
      const result = await deps.surveyRepository.submit({
        ownerUid: visitor.uid,
        eventId: deps.eventId,
        stickerSubmissionId: parsed.data.stickerSubmissionId,
        cuteRating: parsed.data.cuteRating,
        marketingEmail: parsed.data.marketingOptIn ? parsed.data.email : null,
        submittedAt: now(),
      });
      return reply.code(result.created ? 201 : 200).send({ surveyId: result.surveyId, created: result.created });
    } catch (error) {
      if (error instanceof SurveyUnavailableError) return reply.code(409).send({ error: 'SURVEY_NOT_AVAILABLE' });
      throw error;
    }
  });

  app.get(route('/v1/surveys/status'), async (request, reply) => {
    const token = bearerTokenFromHeader(request.headers.authorization);
    if (!token) return reply.code(401).send({ error: 'AUTH_REQUIRED' });
    let visitor: Awaited<ReturnType<VerifyBearerToken>>;
    try {
      visitor = await deps.verifyBearerToken(token);
    } catch {
      return reply.code(401).send({ error: 'INVALID_AUTH' });
    }
    const parsed = z.object({ stickerSubmissionId: FirestoreDocumentIdSchema }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_SURVEY_STATUS' });
    return deps.surveyRepository.status({
      ownerUid: visitor.uid,
      eventId: deps.eventId,
      stickerSubmissionId: parsed.data.stickerSubmissionId,
    });
  });

  app.get<{ Params: { id: string } }>(route('/v1/submissions/:id/status'), async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
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
