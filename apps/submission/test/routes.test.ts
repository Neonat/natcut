import { createHash } from 'node:crypto';
import { geometryIssuesHash, manifestHash, type CompositionManifest, type GeometryReport, type LogicalSourceBundle, type PublicStatus, type Submission } from '@natcut/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { artifact, bundle } from './fixtures/artifact.ts';
import { catalogManifest } from '@natcut/render';
import type { createPlantFlowCoordinator } from '../src/plant-flow.ts';
import {
  IdempotencyConflictError,
  RequeueForbiddenError,
  SurveyUnavailableError,
  buildSubmissionServer,
  createTrustedArtifactPreparer,
  type SubmissionLookup,
  type CreateSubmissionInput,
  type SubmissionRepository,
  type SubmitSurveyResult,
  type SurveyInput,
  type SurveyRepository,
} from '../src/index.ts';

const manifest = {
  schemaVersion: 1,
  spriteAssetId: 'sprite/monstera-v1',
  trainerAssetId: null,
  theme: 'default',
  brandingVariant: 'logo',
  cutGroups: [
    { id: 'main', members: ['sprite'] },
    { id: 'brand', members: ['branding'] },
  ],
  cutMarginMm: 1.5,
  renderVersion: 'fixture-v1',
} as const;

function report(severity: 'ok' | 'warning' | 'error' = 'ok'): GeometryReport {
  const isWarning = severity === 'warning';
  const isError = severity === 'error';
  return {
    valid: !isError,
    severity,
    issues: isWarning
      ? [{ code: 'CUT_GAP_TOO_SMALL', severity: 'warning', message: 'Close cut paths.' }]
      : isError
        ? [{ code: 'EMPTY_ARTWORK', severity: 'error', message: 'No artwork.' }]
        : [],
    contourCount: isError ? 0 : 2,
    pointCount: isError ? 0 : 16,
    cutLengthMm: isError ? 0 : 120,
    minimumContourGapMm: isWarning ? 0.8 : 4,
    edgeClearanceMm: 5,
    geometryVersion: 'natcut-geometry-v1',
    rasterHash: bundle.descriptor.maskSha256,
    acknowledgedByVisitor: false,
    acknowledgedAt: null,
  };
}

class MemoryRepository implements SubmissionRepository {
  readonly records = new Map<string, Submission>();
  readonly tokens = new Map<string, string>();
  readonly idempotency = new Map<string, string>();
  sequence = 0;

  private accepted(input: SubmissionLookup) {
    const key = JSON.stringify([input.ownerUid, input.eventId, input.idempotencyKey]);
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.records.get(existingId)!;
      if (existing.manifestHash !== input.manifestHash || existing.requeuedFrom !== input.requeuedFrom) throw new IdempotencyConflictError();
      return existing;
    }
    if (input.requeuedFrom) {
      const prior = this.records.get(input.requeuedFrom);
      if (!prior || prior.ownerUid !== input.ownerUid || prior.eventId !== input.eventId || prior.publicStatus !== 'cancelled') {
        throw new RequeueForbiddenError();
      }
    }
    return null;
  }

  async findAccepted(input: SubmissionLookup) {
    return this.accepted(input);
  }

  async create(input: CreateSubmissionInput) {
    const key = JSON.stringify([input.ownerUid, input.eventId, input.idempotencyKey]);
    const existing = this.accepted(input);
    if (existing) return { submission: existing, created: false };
    const queueNumber = ++this.sequence;
    const id = `submission-${queueNumber}`;
    const now = input.acceptedAt;
    const submission: Submission = {
      recordVersion: 2,
      artifact: input.artifact,
      id,
      ownerUid: input.ownerUid,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      manifest: input.manifest,
      manifestHash: input.manifestHash,
      printSpec: input.printSpec,
      validation: input.validation,
      publicStatus: 'queued',
      publicStatusTokenHash: input.publicStatusTokenHash,
      queueNumber,
      jobsAhead: this.jobsAhead(queueNumber),
      acceptedAt: now,
      cancelledAt: null,
      requeuedFrom: input.requeuedFrom,
      updatedAt: now,
    };
    this.records.set(id, submission);
    this.tokens.set(id, input.publicStatusTokenHash);
    this.idempotency.set(key, id);
    return { submission, created: true };
  }

  async getPublicStatus(id: string, tokenHash: string) {
    const record = this.records.get(id);
    if (!record || this.tokens.get(id) !== tokenHash) return null;
    return { ...record, jobsAhead: this.jobsAhead(record.queueNumber) };
  }

  async leave(id: string, tokenHash: string, now: string) {
    const record = this.records.get(id);
    if (!record || this.tokens.get(id) !== tokenHash) return 'not-found' as const;
    if (record.publicStatus !== 'joining' && record.publicStatus !== 'queued') return 'locked' as const;
    const updated = { ...record, publicStatus: 'cancelled' as const, cancelledAt: now, updatedAt: now };
    this.records.set(id, updated);
    return 'cancelled' as const;
  }

  setStatus(id: string, publicStatus: PublicStatus) {
    const record = this.records.get(id)!;
    this.records.set(id, { ...record, publicStatus });
  }

  private jobsAhead(queueNumber: number) {
    return [...this.records.values()].filter(
      (record) => record.queueNumber < queueNumber && !['cancelled', 'collected'].includes(record.publicStatus),
    ).length;
  }
}

class MemorySurveyRepository implements SurveyRepository {
  readonly records = new Map<string, SubmitSurveyResult>();
  constructor(private readonly submissions: MemoryRepository) {}

  async submit(input: SurveyInput): Promise<SubmitSurveyResult> {
    const key = `${input.eventId}:${input.ownerUid}`;
    const existing = this.records.get(key);
    if (existing) return { ...existing, created: false };
    const submission = this.submissions.records.get(input.stickerSubmissionId);
    if (!submission || submission.ownerUid !== input.ownerUid || submission.eventId !== input.eventId || submission.publicStatus !== 'collected') {
      throw new SurveyUnavailableError();
    }
    const surveyId = `survey-${this.records.size + 1}`;
    const result: SubmitSurveyResult = {
      surveyId,
      created: true,
      survey: {
        email: input.marketingEmail?.trim().toLowerCase() ?? null,
        eventId: input.eventId,
        stickerSubmissionId: input.stickerSubmissionId,
        cuteRating: input.cuteRating,
        selfieStoragePath: null,
        submittedAt: input.submittedAt,
      },
    };
    this.records.set(key, result);
    return result;
  }

  async status(input: Pick<SurveyInput, 'ownerUid' | 'eventId' | 'stickerSubmissionId'>) {
    const submission = this.submissions.records.get(input.stickerSubmissionId);
    const eligible = Boolean(submission && submission.ownerUid === input.ownerUid
      && submission.eventId === input.eventId && submission.publicStatus === 'collected');
    return { eligible, submitted: eligible && this.records.has(`${input.eventId}:${input.ownerUid}`) };
  }
}

describe('submission routes', () => {
  let repository: MemoryRepository;
  let surveyRepository: MemorySurveyRepository;
  let app: ReturnType<typeof buildSubmissionServer>;
  const prepareArtifact = vi.fn(async (candidate: CompositionManifest) => ({
    bundle: { ...bundle, descriptor: { ...bundle.descriptor, renderVersion: candidate.renderVersion } },
    report: report(candidate.renderVersion === 'invalid' ? 'error' : candidate.renderVersion === 'warning' ? 'warning' : 'ok'),
  }));
  const publish = vi.fn(async (input: LogicalSourceBundle, _options?: { signal?: AbortSignal }) => ({ ...artifact, descriptor: input.descriptor }));

  beforeEach(() => {
    prepareArtifact.mockClear();
    publish.mockClear();
    repository = new MemoryRepository();
    surveyRepository = new MemorySurveyRepository(repository);
    app = buildSubmissionServer({
      eventId: 'devfest-sg',
      statusTokenSecret: 'test-secret-at-least-32-bytes-long',
      repository,
      surveyRepository,
      verifyBearerToken: async (token) => {
        if (token === 'alice-token') return { uid: 'alice' };
        if (token === 'bob-token') return { uid: 'bob' };
        throw new Error('invalid token');
      },
      prepareArtifact, publisher: { publish },
      now: () => '2026-11-23T12:00:00.000Z',
    });
  });

  it.each(['catalog_fallback_accepted', 'generated_accepted'] as const)(
    'binds the first %s ticket to the capture across retries and changed layouts', async outcome => {
      const runtimeId = `sprite/runtime/${'a'.repeat(64)}`;
      const accepted = outcome === 'generated_accepted'
        ? { outcome, natcutAssetId: runtimeId }
        : { outcome, catalogAssetId: catalogManifest.spriteAssetId };
      const chosen = outcome === 'generated_accepted'
        ? { ...catalogManifest, renderVersion: 'runtime-catalog-v1', spriteAssetId: runtimeId }
        : catalogManifest;
      const server = buildSubmissionServer({
        eventId: 'devfest-sg', statusTokenSecret: 'test-secret-at-least-32-bytes-long', repository,
        surveyRepository, verifyBearerToken: async token => {
          if (token !== 'alice-token') throw new Error('auth');
          return { uid: 'alice' };
        },
        prepareArtifact, publisher: { publish },
        plant: {
          policyVersion: 'policy-v1',
          captureSource: {
            async findOwned(uid, _eventId, captureId) {
              return uid === 'alice' && captureId === 'capture' ? { captureId, visitorSessionId: 'session' } : null;
            },
            async resolveConfirmed() { return null; },
          },
          coordinator: { async advance() { return { state: 'accepted', generationIntentId: 'intent',
            decision: accepted, sproutAck: 'confirmed' }; } } as unknown as ReturnType<typeof createPlantFlowCoordinator>,
          verifyRuntimeAcceptance: async () => {},
          prepareRuntimeArtifact: async () => ({ report: report(), bundle }),
        },
      });
      const post = (idempotencyKey: string, recipe: object) => server.inject({ method: 'POST',
        url: '/v1/plant-jobs/capture/submissions', headers: { authorization: 'Bearer alice-token' },
        payload: { idempotencyKey, manifest: recipe } });
      try {
        const first = await post('phone-first', chosen);
        expect(first.statusCode).toBe(201);
        const recovered = await post('phone-reloaded', chosen);
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json().submissionId).toBe(first.json().submissionId);
        expect((await post('new-layout', { ...chosen, sheetVariant: 'duo' })).statusCode).toBe(409);
        expect(repository.records.size).toBe(1);
        expect(publish).toHaveBeenCalledOnce();
      } finally { await server.close(); }
    },
  );

  it('accepts packaged sprites and rejects unsupported versions, roles and catalog combinations before writing tickets', async () => {
    const index = (await import('../../../packages/render/catalog/index.json', { with: { type: 'json' } })).default;
    const selected = { ...manifest, renderVersion: 'catalog-v1', spriteAssetId: index.sprites[0]!.id };
    const server = buildSubmissionServer({
      eventId: 'devfest-sg', statusTokenSecret: 'test-secret-at-least-32-bytes-long', repository,
      surveyRepository,
      verifyBearerToken: async () => ({ uid: 'visitor' }),
      prepareArtifact: createTrustedArtifactPreparer(), publisher: { publish },
    });
    const post = (recipe: object) => server.inject({
      method: 'POST', url: '/v1/submissions', headers: { authorization: 'Bearer visitor' },
      payload: { idempotencyKey: 'submission-' + repository.sequence, manifest: recipe },
    });
    try {
      expect((await post(selected)).statusCode).toBe(201);
      for (const recipe of [
        { ...selected, renderVersion: 'unknown' },
        { ...selected, spriteAssetId: 'branding/logo' },
        { ...selected, spriteAssetId: 'sprite/unknown' },
        { ...selected, spriteAssetId: 'sprite/monstera-v1' },
        { ...selected, theme: 'hugging' },
        { ...selected, brandingVariant: 'logo-and-species' },
        { ...selected, cutGroups: [{ id: 'joined', members: ['sprite', 'branding'] }] },
        { ...manifest, spriteAssetId: 'branding/logo' },
        { ...manifest, trainerAssetId: 'sprite/monstera-v1', cutGroups: [{ id: 'all', members: ['sprite', 'branding', 'trainer'] }] },
      ]) {
        expect((await post(recipe)).statusCode).toBe(422);
      }
      expect(repository.sequence).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('reports service health without touching the repository', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(repository.records.size).toBe(0);
  });

  it('can mount the API below the Hosting rewrite prefix', async () => {
    const prefixed = buildSubmissionServer({
      eventId: 'devfest-sg',
      statusTokenSecret: 'test-secret-at-least-32-bytes-long',
      repository,
      surveyRepository,
      verifyBearerToken: async () => ({ uid: 'alice' }),
      prepareArtifact, publisher: { publish },
      routePrefix: '/api',
    });

    expect((await prefixed.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await prefixed.inject({ method: 'POST', url: '/api/v1/submissions' })).statusCode).toBe(401);
    expect((await prefixed.inject({ method: 'POST', url: '/v1/submissions' })).statusCode).toBe(404);
    await prefixed.close();
  });

  async function submit(
    body: Record<string, unknown> = { manifest, idempotencyKey: 'request-1' },
    token = 'alice-token',
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/submissions',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body,
    });
  }

  async function submitSurvey(body: Record<string, unknown>, token = 'alice-token') {
    return app.inject({
      method: 'POST',
      url: '/v1/surveys',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body,
    });
  }

  async function collectedSubmission() {
    const accepted = (await submit()).json();
    repository.setStatus(accepted.submissionId, 'collected');
    return accepted.submissionId as string;
  }

  it('requires valid authentication for surveys', async () => {
    const payload = { stickerSubmissionId: 'submission-1', cuteRating: 5, marketingOptIn: false };
    expect((await submitSurvey(payload, '')).statusCode).toBe(401);
    expect((await submitSurvey(payload, 'invalid')).statusCode).toBe(401);
  });

  it.each([
    { stickerSubmissionId: 'submission-1', cuteRating: 0, marketingOptIn: false },
    { stickerSubmissionId: 'submission-1', cuteRating: 6, marketingOptIn: false },
    { stickerSubmissionId: 'submission-1', cuteRating: 5, marketingOptIn: false, email: 'retained@example.com' },
    { stickerSubmissionId: 'submission-1', cuteRating: 5, marketingOptIn: true },
    { stickerSubmissionId: 'submission-1', cuteRating: 5, marketingOptIn: true, email: 'not-an-email' },
    { stickerSubmissionId: 'submission-1', cuteRating: 5, marketingOptIn: false, extra: true },
    { stickerSubmissionId: 'nested/ticket', cuteRating: 5, marketingOptIn: false },
  ])('rejects an invalid or contradictory survey: %j', async (payload) => {
    expect((await submitSurvey(payload)).statusCode).toBe(400);
  });

  it('does not reveal whether an uncollected or another visitor ticket exists', async () => {
    const queued = (await submit()).json().submissionId as string;
    expect((await submitSurvey({ stickerSubmissionId: queued, cuteRating: 5, marketingOptIn: false })).json()).toEqual({ error: 'SURVEY_NOT_AVAILABLE' });
    repository.setStatus(queued, 'collected');
    expect((await submitSurvey({ stickerSubmissionId: queued, cuteRating: 5, marketingOptIn: false }, 'bob-token')).json()).toEqual({ error: 'SURVEY_NOT_AVAILABLE' });
  });

  it('stores opt-out without email and normalizes an explicit opt-in', async () => {
    const first = await collectedSubmission();
    const optOut = await submitSurvey({ stickerSubmissionId: first, cuteRating: 4, marketingOptIn: false });
    expect(optOut.statusCode).toBe(201);
    expect([...surveyRepository.records.values()][0]!.survey.email).toBeNull();

    const second = (await submit({ manifest, idempotencyKey: 'request-2' }, 'bob-token')).json().submissionId as string;
    repository.setStatus(second, 'collected');
    const optIn = await submitSurvey({ stickerSubmissionId: second, cuteRating: 5, marketingOptIn: true, email: ' Person@Example.COM ' }, 'bob-token');
    expect(optIn.statusCode).toBe(201);
    expect([...surveyRepository.records.values()][1]!.survey.email).toBe('person@example.com');
  });

  it('returns the existing immutable survey when the client retries', async () => {
    const stickerSubmissionId = await collectedSubmission();
    const payload = { stickerSubmissionId, cuteRating: 3, marketingOptIn: false };
    const first = await submitSurvey(payload);
    const retry = await submitSurvey({ ...payload, cuteRating: 1 });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ surveyId: first.json().surveyId, created: false });
  });

  it('authenticates survey eligibility and restores the submitted receipt', async () => {
    const stickerSubmissionId = await collectedSubmission();
    const status = (token = 'alice-token', id = stickerSubmissionId) => app.inject({
      method: 'GET',
      url: `/v1/surveys/status?stickerSubmissionId=${encodeURIComponent(id)}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect((await status('')).statusCode).toBe(401);
    expect((await status('invalid')).statusCode).toBe(401);
    expect((await status('bob-token')).json()).toEqual({ eligible: false, submitted: false });
    expect((await status()).json()).toEqual({ eligible: true, submitted: false });
    await submitSurvey({ stickerSubmissionId, cuteRating: 5, marketingOptIn: false });
    expect((await status()).json()).toEqual({ eligible: true, submitted: true });
  });

  it('rejects missing and invalid authentication', async () => {
    expect((await submit({ manifest, idempotencyKey: 'one' }, '')).statusCode).toBe(401);
    expect((await submit({ manifest, idempotencyKey: 'two' }, 'invalid')).statusCode).toBe(401);
  });

  it('prevents Hosting from caching token-dependent status responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/submissions/missing/status',
      headers: { 'x-natcut-status-token': 'wrong-token' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects malformed manifests and structurally invalid geometry', async () => {
    expect((await submit({ manifest: { ...manifest, surprise: true }, idempotencyKey: 'one' })).statusCode).toBe(400);
    expect((await submit({ manifest: { ...manifest, renderVersion: 'invalid' }, idempotencyKey: 'two' })).statusCode).toBe(422);
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires an exact acknowledgement for warnings', async () => {
    const warningManifest = { ...manifest, renderVersion: 'warning' };
    const exactManifestHash = await manifestHash(warningManifest);
    const exactIssuesHash = await geometryIssuesHash(report('warning').issues);
    expect((await submit({ manifest: warningManifest, idempotencyKey: 'one' })).statusCode).toBe(409);
    expect((await submit({
      manifest: warningManifest,
      idempotencyKey: 'two',
      warningAcknowledgement: {
        geometryVersion: 'natcut-geometry-v1', rasterHash: 'b'.repeat(64),
        manifestHash: exactManifestHash, issuesHash: exactIssuesHash,
      },
    })).statusCode).toBe(409);

    expect((await submit({
      manifest: warningManifest,
      idempotencyKey: 'stale-manifest',
      warningAcknowledgement: {
        geometryVersion: 'natcut-geometry-v1', rasterHash: report().rasterHash,
        manifestHash: 'f'.repeat(64), issuesHash: exactIssuesHash,
      },
    })).statusCode).toBe(409);

    expect(publish).not.toHaveBeenCalled();
    const accepted = await submit({
      manifest: warningManifest,
      idempotencyKey: 'three',
      warningAcknowledgement: {
        geometryVersion: 'natcut-geometry-v1', rasterHash: report().rasterHash,
        manifestHash: exactManifestHash, issuesHash: exactIssuesHash,
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(repository.records.get('submission-1')?.validation.acknowledgedByVisitor).toBe(true);
  });

  it('creates once, returns an opaque status token, and rejects accepted-field mutation', async () => {
    const first = await submit();
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(repository.records.get('submission-1')).toMatchObject({ recordVersion: 2, artifact });
    expect(created).toMatchObject({ submissionId: 'submission-1', queueNumber: 1, publicStatus: 'queued' });
    expect(created.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.records.get('submission-1')?.publicStatusTokenHash).toBe(
      createHash('sha256').update(created.statusToken).digest('hex'),
    );

    const retry = await submit();
    expect(retry.statusCode).toBe(200);
    expect(retry.json().statusToken).toBe(created.statusToken);

    const mutation = await submit({ manifest: { ...manifest, theme: 'battling' }, idempotencyKey: 'request-1' });
    expect(mutation.statusCode).toBe(409);
    expect(repository.records.get('submission-1')?.manifest.theme).toBe('default');
    expect((await submit({ manifest, idempotencyKey: 'request-1', requeuedFrom: 'another' })).statusCode).toBe(409);
    expect(prepareArtifact).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('requires successful storage before calling create and permits retry', async () => {
    const create = vi.spyOn(repository, 'create');
    publish.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await submit()).statusCode).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(repository.records.size).toBe(0);
    expect((await submit()).statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('returns 503 at the storage deadline and cannot accept a late publication', async () => {
    await app.ready();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<typeof artifact>();
    publish.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const create = vi.spyOn(repository, 'create');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const request = submit();
      await started.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(publish.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      pending.resolve(artifact);
      expect((await request).statusCode).toBe(503);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(create).not.toHaveBeenCalled();
      expect((await submit()).statusCode).toBe(201);
    } finally {
      pending.resolve(artifact);
      vi.useRealTimers();
    }
  });

  it('recovers an accepted legacy ticket while both preparation and storage are unavailable', async () => {
    const original = await submit();
    const { submissionId } = original.json();
    const { recordVersion, artifact: receipt, ...legacy } = repository.records.get(submissionId)!;
    repository.records.set(submissionId, legacy);
    await prepareArtifact.withImplementation(async () => { throw new Error('renderer unavailable'); }, async () => {
      await publish.withImplementation(async () => { throw new Error('storage unavailable'); }, async () => {
        const retry = await submit();
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual(original.json());
      });
    });
    expect(prepareArtifact).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('returns one ticket when two requests publish before either creates its binding', async () => {
    const bothPublishing = Promise.withResolvers<void>();
    let publishers = 0;
    await publish.withImplementation(async (input) => {
      if (++publishers === 2) bothPublishing.resolve();
      await bothPublishing.promise;
      return { ...artifact, descriptor: input.descriptor };
    }, async () => {
      const [first, second] = await Promise.all([submit(), submit()]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
      expect(first.json()).toEqual(second.json());
      expect(repository.records.size).toBe(1);
    });
  });

  it('looks up status only through the opaque header and calculates jobs ahead', async () => {
    const first = (await submit()).json();
    const second = (await submit({ manifest, idempotencyKey: 'request-2' })).json();

    const missing = await app.inject({ method: 'GET', url: `/v1/submissions/${second.submissionId}/status` });
    const wrong = await app.inject({
      method: 'GET',
      url: `/v1/submissions/${second.submissionId}/status`,
      headers: { 'x-natcut-status-token': first.statusToken },
    });
    const status = await app.inject({
      method: 'GET',
      url: `/v1/submissions/${second.submissionId}/status`,
      headers: { 'x-natcut-status-token': second.statusToken },
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(404);
    expect(status.json()).toEqual({
      submissionId: 'submission-2',
      publicStatus: 'queued',
      queueNumber: 2,
      jobsAhead: 1,
      canLeaveQueue: true,
      updatedAt: '2026-11-23T12:00:00.000Z',
    });
  });

  it('allows leaving while queued but not once the visitor is next', async () => {
    const queued = (await submit()).json();
    const left = await app.inject({
      method: 'POST',
      url: `/v1/submissions/${queued.submissionId}/leave`,
      headers: { 'x-natcut-status-token': queued.statusToken },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json().publicStatus).toBe('cancelled');

    const next = (await submit({ manifest, idempotencyKey: 'request-2' })).json();
    repository.setStatus(next.submissionId, 'next');
    const locked = await app.inject({
      method: 'POST',
      url: `/v1/submissions/${next.submissionId}/leave`,
      headers: { 'x-natcut-status-token': next.statusToken },
    });
    expect(locked.statusCode).toBe(409);
  });

  it('permits requeue only from the same visitor cancelled submission', async () => {
    const original = (await submit()).json();
    await app.inject({
      method: 'POST',
      url: `/v1/submissions/${original.submissionId}/leave`,
      headers: { 'x-natcut-status-token': original.statusToken },
    });

    const own = await submit({ manifest, idempotencyKey: 'request-2', requeuedFrom: original.submissionId });
    expect(own.statusCode).toBe(201);
    expect(repository.records.get('submission-2')?.requeuedFrom).toBe('submission-1');

    const otherVisitor = await submit(
      { manifest, idempotencyKey: 'request-3', requeuedFrom: original.submissionId },
      'bob-token',
    );
    expect(otherVisitor.statusCode).toBe(403);
    const active = await submit({ manifest, idempotencyKey: 'active-prior', requeuedFrom: 'submission-2' });
    expect(active.statusCode).toBe(403);
    expect(prepareArtifact).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
