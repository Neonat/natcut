import { canonicalManifestJson, type CompositionManifest } from '@natcut/domain';

const STORAGE_KEY = 'natcut:submission-attempt:v1';
const RECORD_VERSION = 1;

export type SubmissionAttempt = {
  binding: string;
  idempotencyKey: string;
};

type PendingSubmissionAttempt = SubmissionAttempt & {
  version: typeof RECORD_VERSION;
  state: 'pending';
};

type AcceptedSubmissionAttempt = SubmissionAttempt & {
  version: typeof RECORD_VERSION;
  state: 'accepted';
  submissionId: string;
};

type StoredSubmissionAttempt = PendingSubmissionAttempt | AcceptedSubmissionAttempt;

function browserIdentity(): { apiIdentity: string; eventIdentity: string } {
  try {
    return {
      // Production only permits the same-origin /api endpoint, so the visitor
      // origin identifies the API deployment without persisting its URL.
      apiIdentity: window.location.origin,
      eventIdentity: window.location.pathname,
    };
  } catch {
    return { apiIdentity: 'visitor-local', eventIdentity: '/' };
  }
}

export function submissionAttemptBinding(
  manifest: CompositionManifest,
  requeuedFrom: string | undefined,
): string {
  const identity = browserIdentity();
  return JSON.stringify({
    apiIdentity: identity.apiIdentity,
    eventIdentity: identity.eventIdentity,
    manifest: canonicalManifestJson(manifest),
    requeuedFrom: requeuedFrom ?? null,
  });
}

function validRecord(value: unknown): value is StoredSubmissionAttempt {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const expectedKeys = record.state === 'accepted'
    ? 'binding,idempotencyKey,state,submissionId,version'
    : 'binding,idempotencyKey,state,version';
  return Object.keys(record).sort().join(',') === expectedKeys
    && record.version === RECORD_VERSION
    && (record.state === 'pending' || record.state === 'accepted')
    && typeof record.binding === 'string'
    && typeof record.idempotencyKey === 'string'
    && record.idempotencyKey.length > 0
    && record.idempotencyKey.length <= 200
    && (record.state !== 'accepted'
      || (typeof record.submissionId === 'string' && record.submissionId.length > 0));
}

function sessionStore(): Storage {
  try { return globalThis.sessionStorage; }
  catch { throw new Error('This ticket attempt could not be saved. Enable session storage and try again.'); }
}

function readRecord(storage: Storage): StoredSubmissionAttempt | null {
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    return validRecord(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function acceptedSubmissionAttempt(binding: string): AcceptedSubmissionAttempt | null {
  let storage: Storage;
  try { storage = sessionStore(); }
  catch { return null; }
  const saved = readRecord(storage);
  return saved?.state === 'accepted' && saved.binding === binding ? saved : null;
}

export function restoreOrCreateSubmissionAttempt(
  binding: string,
  createId: () => string,
): SubmissionAttempt {
  const storage = sessionStore();
  const saved = readRecord(storage);
  if (saved?.binding === binding) {
    return { binding, idempotencyKey: saved.idempotencyKey };
  }

  const attempt = { binding, idempotencyKey: createId() };
  try {
    const record: PendingSubmissionAttempt = { version: RECORD_VERSION, state: 'pending', ...attempt };
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    throw new Error('This ticket attempt could not be saved. Enable session storage and try again.');
  }
  return attempt;
}

export function markSubmissionAttemptAccepted(attempt: SubmissionAttempt, submissionId: string): void {
  const storage = sessionStore();
  const saved = readRecord(storage);
  if (!saved
    || saved.binding !== attempt.binding
    || saved.idempotencyKey !== attempt.idempotencyKey) return;
  try {
    const accepted: AcceptedSubmissionAttempt = {
      version: RECORD_VERSION,
      state: 'accepted',
      ...attempt,
      submissionId,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(accepted));
  } catch {
    throw new Error('This accepted ticket could not be saved for recovery. Try again.');
  }
}

export function clearAcceptedSubmissionAttempt(submissionId: string): void {
  let storage: Storage;
  try { storage = sessionStore(); }
  catch { return; }
  const saved = readRecord(storage);
  if (saved?.state !== 'accepted' || saved.submissionId !== submissionId) return;
  try { storage.removeItem(STORAGE_KEY); }
  catch { /* Keeping the accepted fence is safer than risking a duplicate. */ }
}
