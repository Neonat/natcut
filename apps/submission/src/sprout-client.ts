import { PlantJobCreateResponseSchema, PlantJobStatusSchema, PlantOutcomeSchema,
  sourcePhotoDigest, type PlantJobCreateRequest, type PlantJobCreateResponse,
  type PlantJobStatus, type PlantOutcome, type PlantCandidate } from './plant-job-contract.ts';
import { isDeepStrictEqual } from 'node:util';

export class SproutHttpError extends Error {
  constructor(readonly status: number) { super(`Sprout request failed with HTTP ${status}`); }
}
export class SproutEvidenceConflictError extends Error {
  constructor(message: string) { super(message); }
}

export interface SproutPlantJobClient {
  create(request: PlantJobCreateRequest, signal?: AbortSignal): Promise<PlantJobCreateResponse>;
  status(plantJobId: string, signal?: AbortSignal): Promise<PlantJobStatus>;
  candidate(plantJobId: string, candidate: PlantCandidate, signal?: AbortSignal): Promise<Buffer>;
  outcome(plantJobId: string, decision: PlantOutcome): Promise<PlantOutcome>;
}

export type SproutClientOptions = {
  serviceUrl: string;
  tokenForAudience: (audience: string) => Promise<string>;
  fetch?: typeof fetch;
};

export function createSproutPlantJobClient(options: SproutClientOptions): SproutPlantJobClient {
  const base = new URL(options.serviceUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new Error('Sprout service URL must use HTTPS.');
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Sprout service URL must be an origin.');
  }
  const audience = base.origin;
  const requestFetch = options.fetch ?? fetch;
  async function call(path: string, method: 'GET' | 'POST', body?: unknown, key?: string, signal?: AbortSignal): Promise<Response> {
    const token = await options.tokenForAudience(audience);
    if (!token || /\s/.test(token)) throw new Error('Invalid Sprout identity token.');
    const response = await requestFetch(new URL(path, base), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new SproutHttpError(response.status);
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    if (Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new SproutEvidenceConflictError('Oversized Sprout response.');
    if (!response.body) throw new SproutEvidenceConflictError('Sprout response body is missing.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 1_000_000) throw new SproutEvidenceConflictError('Oversized Sprout response.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
      throw new SproutEvidenceConflictError('Invalid Sprout JSON response.');
    }
  }
  const path = (plantJobId: string) => `/v1/plant-jobs/${encodeURIComponent(plantJobId)}`;
  return {
    async create(request, signal) {
      const parsed = PlantJobCreateResponseSchema.safeParse(await json(await call('/v1/plant-jobs', 'POST', request, request.generationIntentId, signal)));
      if (!parsed.success) throw new SproutEvidenceConflictError('Sprout returned malformed create evidence.');
      const response = parsed.data;
      if (response.generationIntentId !== request.generationIntentId) throw new SproutEvidenceConflictError('Sprout returned a different generation intent.');
      return response;
    },
    async status(plantJobId, signal) {
      const status = PlantJobStatusSchema.parse(await json(await call(path(plantJobId), 'GET', undefined, undefined, signal)));
      if (status.plantJobId !== plantJobId) throw new SproutEvidenceConflictError('Sprout returned a different plant job.');
      return status;
    },
    async candidate(plantJobId, candidate, signal) {
      const response = await call(`${path(plantJobId)}/candidates/${encodeURIComponent(candidate.candidateId)}`, 'GET', undefined, undefined, signal);
      if (response.headers.get('content-type')?.split(';')[0] !== candidate.mediaType) {
        throw new SproutEvidenceConflictError('Sprout candidate media type mismatch.');
      }
      if (candidate.byteLength > 20_000_000 || Number(response.headers.get('content-length') ?? 0) > candidate.byteLength) {
        throw new SproutEvidenceConflictError('Sprout candidate exceeds its declared length.');
      }
      if (!response.body) throw new Error('Sprout candidate body is missing.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > candidate.byteLength) throw new SproutEvidenceConflictError('Sprout candidate exceeds its declared length.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = Buffer.concat(chunks, total);
      if (bytes.length !== candidate.byteLength || sourcePhotoDigest(bytes) !== candidate.sha256) {
        throw new SproutEvidenceConflictError('Sprout candidate digest or length mismatch.');
      }
      return bytes;
    },
    async outcome(plantJobId, decision) {
      const parsed = PlantOutcomeSchema.safeParse(await json(await call(`${path(plantJobId)}/outcome`, 'POST', decision, decision.decisionId)));
      if (!parsed.success || !isDeepStrictEqual(parsed.data, decision)) {
        throw new SproutEvidenceConflictError('Sprout returned a different outcome.');
      }
      return parsed.data;
    },
  };
}
