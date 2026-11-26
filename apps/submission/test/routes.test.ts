import { createHash } from 'node:crypto';
import { geometryIssuesHash, manifestHash, type GeometryReport, type PublicStatus, type Submission } from '@natcut/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  RequeueForbiddenError,
  buildSubmissionServer,
  createTrustedManifestValidator,
  type CreateSubmissionInput,
  type SubmissionRepository,
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
    rasterHash: 'a'.repeat(64),
    acknowledgedByVisitor: false,
    acknowledgedAt: null,
  };
}

class MemoryRepository implements SubmissionRepository {
  readonly records = new Map<string, Submission>();
  readonly tokens = new Map<string, string>();
  readonly idempotency = new Map<string, string>();
  sequence = 0;

  async create(input: CreateSubmissionInput) {
    const key = `${input.ownerUid}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.records.get(existingId)!;
      if (existing.manifestHash !== input.manifestHash) throw new IdempotencyConflictError();
      return { submission: existing, created: false };
    }
    if (input.requeuedFrom) {
      const prior = this.records.get(input.requeuedFrom);
      if (!prior || prior.ownerUid !== input.ownerUid || prior.publicStatus !== 'cancelled') {
        throw new RequeueForbiddenError();
      }
    }
    const queueNumber = ++this.sequence;
    const id = `submission-${queueNumber}`;
    const now = input.acceptedAt;
    const submission: Submission = {
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

describe('submission routes', () => {
  let repository: MemoryRepository;
  let app: ReturnType<typeof buildSubmissionServer>;

  beforeEach(() => {
    repository = new MemoryRepository();
    app = buildSubmissionServer({
      eventId: 'devfest-sg',
      statusTokenSecret: 'test-secret-at-least-32-bytes-long',
      repository,
      verifyBearerToken: async (token) => {
        if (token === 'alice-token') return { uid: 'alice' };
        if (token === 'bob-token') return { uid: 'bob' };
        throw new Error('invalid token');
      },
      validateManifest: async (candidate) => {
        if (candidate.renderVersion === 'invalid') return report('error');
        if (candidate.renderVersion === 'warning') return report('warning');
        return report('ok');
      },
      now: () => '2026-11-23T12:00:00.000Z',
    });
  });

  it('accepts packaged sprites and rejects unsupported versions, roles and catalog combinations before writing tickets', async () => {
    const index = (await import('../../../packages/render/catalog/index.json', { with: { type: 'json' } })).default;
    const selected = { ...manifest, renderVersion: 'catalog-v1', spriteAssetId: index.sprites[1]!.id };
    const server = buildSubmissionServer({
      eventId: 'devfest-sg', statusTokenSecret: 'test-secret-at-least-32-bytes-long', repository,
      verifyBearerToken: async () => ({ uid: 'visitor' }),
      validateManifest: createTrustedManifestValidator(),
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
      verifyBearerToken: async () => ({ uid: 'alice' }),
      validateManifest: async () => report('ok'),
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
        geometryVersion: 'natcut-geometry-v1', rasterHash: 'a'.repeat(64),
        manifestHash: 'f'.repeat(64), issuesHash: exactIssuesHash,
      },
    })).statusCode).toBe(409);

    const accepted = await submit({
      manifest: warningManifest,
      idempotencyKey: 'three',
      warningAcknowledgement: {
        geometryVersion: 'natcut-geometry-v1', rasterHash: 'a'.repeat(64),
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
  });
});
