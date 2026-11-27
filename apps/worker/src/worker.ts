import { randomUUID } from 'node:crypto';
import { ArtifactIntegrityError, type ArtifactReader } from '@natcut/artifacts';
import { verifyClaim, verifyJournalArtifact } from './artifact-verification.ts';
import { InvalidClaimError, type CloudQueue } from './cloud-queue.ts';
import { safelyExecutableStates, type JobStore, type LocalJobState, type LocalPrintJob } from './job-store.ts';
import type { PhysicalExecutor } from './simulated-printer.ts';

export type WorkerResult =
  | { kind: 'idle' }
  | { kind: 'completed'; submissionId: string }
  | { kind: 'busy'; submissionId: string }
  | { kind: 'waiting_for_cloud'; submissionId: string }
  | { kind: 'needs_reconciliation'; submissionId: string }
  | { kind: 'failed'; submissionId: string; error: string };

export type WorkerDependencies = {
  workerId: string;
  cloud: CloudQueue;
  store: JobStore;
  executor: PhysicalExecutor;
  artifactReader: ArtifactReader;
  signal?: AbortSignal;
  now?: () => string;
};

export type PreparedJob = Pick<LocalPrintJob, 'submissionId' | 'queueNumber' | 'manifestHash' | 'geometryReportJson' | 'artifactReceiptJson'>;

class ExecutionFenceError extends Error {
  constructor(readonly outcome: 'waiting_for_cloud' | 'needs_reconciliation') {
    super(outcome === 'waiting_for_cloud'
      ? 'Cloud execution fence could not be reached.'
      : 'Cloud execution fence no longer matches the verified job.');
  }
}

function pendingConflict(store: JobStore, allowedReadyFor?: string): WorkerResult | null {
  const conflict = store.listPendingPublicStatuses().find(intent =>
    intent.submissionId !== allowedReadyFor || intent.status !== 'ready');
  return conflict ? { kind: 'needs_reconciliation', submissionId: conflict.submissionId } : null;
}

// Called only after this execution acquired the printing fence, or recovery
// verified the current worker's printing claim, local token, receipt and bytes.
async function publishVerifiedReady(store: JobStore, cloud: CloudQueue, submissionId: string): Promise<WorkerResult | null> {
  const conflict = pendingConflict(store, submissionId);
  if (conflict) return conflict;
  const pending = store.listPendingPublicStatuses().find(intent => intent.submissionId === submissionId && intent.status === 'ready');
  if (!pending) return null;
  try {
    await cloud.updatePublicStatus(submissionId, 'ready', pending.updatedAt);
    store.clearPendingPublicStatus(pending);
    return null;
  } catch {
    return { kind: 'waiting_for_cloud', submissionId };
  }
}

function publicStatusFor(state: LocalJobState): 'next' | 'printing' | 'ready' {
  if (state === 'ready') return 'ready';
  if (['declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting'].includes(state)) return 'printing';
  return 'next';
}

export async function runWorkerOnce(deps: WorkerDependencies): Promise<WorkerResult> {
  const prepared = await prepareNextWorkerJob(deps);
  if (prepared.kind !== 'prepared') return prepared;
  return runLocalJob(deps, prepared.job);
}

export async function prepareNextWorkerJob(
  deps: Omit<WorkerDependencies, 'executor'>,
): Promise<{ kind: 'prepared'; job: PreparedJob } | WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    // A ready write may commit and release the slot before its response reaches the worker.
    // A terminal cloud observation permits clearing only that local delivery intent.
    for (const pending of deps.store.listPendingPublicStatuses()) {
      if (pending.status !== 'ready') continue;
      let acknowledged;
      try {
        acknowledged = await deps.cloud.isReadyAcknowledged(pending.submissionId);
      } catch {
        return { kind: 'waiting_for_cloud', submissionId: pending.submissionId };
      }
      if (acknowledged) deps.store.clearPendingPublicStatus(pending);
    }
    for (const method of ['recoverClaim', 'claimNextSubmission'] as const) {
      if (method === 'claimNextSubmission') {
        const conflict = pendingConflict(deps.store);
        if (conflict) return conflict;
      }
      const claim = await deps.cloud[method](deps.workerId);
      if (!claim) continue;
      const submissionId = claim.submission.id;
      if (deps.store.hasLiveExecutionGuard()) return { kind: 'busy', submissionId };
      if (claim.workerId !== deps.workerId) return { kind: 'needs_reconciliation', submissionId };
      if (deps.store.hasArtifactHold(submissionId)) return { kind: 'needs_reconciliation', submissionId };
      const conflict = pendingConflict(deps.store, method === 'recoverClaim' ? submissionId : undefined);
      if (conflict) return conflict;
      const deadline = AbortSignal.timeout(30_000);
      const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
      let verified;
      try {
        verified = await verifyClaim(claim, deps.artifactReader, signal, now);
      } catch (error) {
        if (error instanceof ArtifactIntegrityError) {
          return { kind: deps.store.holdArtifact(submissionId, now(), error.message), submissionId };
        }
        return { kind: 'waiting_for_cloud', submissionId };
      }
      const availability = deps.store.ensureClaimed(verified);
      if (availability !== 'available') return { kind: availability, submissionId };
      const job = deps.store.getBySubmissionId(submissionId)!;
      if (safelyExecutableStates.has(job.state)) {
        const pending = pendingConflict(deps.store);
        if (pending) return pending;
        const { queueNumber, manifestHash, geometryReportJson, artifactReceiptJson } = job;
        return { kind: 'prepared', job: { submissionId, queueNumber, manifestHash, geometryReportJson, artifactReceiptJson } };
      }
      if (method !== 'recoverClaim' || job.state !== 'ready') return { kind: 'needs_reconciliation', submissionId };
      if (claim.submission.publicStatus !== 'printing') return { kind: 'needs_reconciliation', submissionId };
      deps.store.stagePublicStatus(submissionId, 'ready', job.stateChangedAt);
      const unpublished = await publishVerifiedReady(deps.store, deps.cloud, submissionId);
      if (unpublished) return unpublished;
    }
    return { kind: 'idle' };
  } catch (error) {
    if (!(error instanceof InvalidClaimError)) throw error;
    return { kind: deps.store.holdArtifact(error.submissionId, now(), error.message), submissionId: error.submissionId };
  }
}

export async function runLocalJob(
  deps: WorkerDependencies,
  job: PreparedJob,
): Promise<WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const executionToken = randomUUID();
  if (!deps.store.tryAcquireExecutionGuard(executionToken, process.pid)) {
    return { kind: 'busy', submissionId: job.submissionId };
  }

  try {
    const authoritativeJob = deps.store.getBySubmissionId(job.submissionId);
    if (!authoritativeJob) {
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    if (authoritativeJob.state === 'ready') {
      return { kind: 'completed', submissionId: job.submissionId };
    }
    if (!safelyExecutableStates.has(authoritativeJob.state)) {
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    const pending = pendingConflict(deps.store);
    if (pending) return pending;
    let evidence;
    try {
      if (job.manifestHash !== authoritativeJob.manifestHash || job.queueNumber !== authoritativeJob.queueNumber ||
          job.geometryReportJson !== authoritativeJob.geometryReportJson) throw new ArtifactIntegrityError('Prepared journal changed.');
      evidence = await verifyJournalArtifact(authoritativeJob, job.artifactReceiptJson);
    } catch {
      deps.store.transition(job.submissionId, 'needs_reconciliation', now(), 'Stored artifact failed verification before execution.');
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    if (deps.signal?.aborted) return { kind: 'waiting_for_cloud', submissionId: job.submissionId };
    let staged = publicStatusFor(authoritativeJob.state);
    try {
      await deps.executor.execute(authoritativeJob, async (state, changedAt) => {
        const nextPublic = publicStatusFor(state);
        if (staged === 'next' && nextPublic === 'printing') {
          const journalExecutionToken = deps.store.getOrCreateExecutionToken(job.submissionId);
          let executionFence: 'acquired' | 'fenced';
          try {
            executionFence = await deps.cloud.beginExecution(
              job.submissionId,
              deps.workerId,
              journalExecutionToken,
              changedAt,
              evidence,
            );
          } catch {
            throw new ExecutionFenceError('waiting_for_cloud');
          }
          if (executionFence === 'fenced') {
            throw new ExecutionFenceError('needs_reconciliation');
          }
          staged = 'printing';
          deps.store.transition(job.submissionId, state, changedAt);
          return;
        }
        if (nextPublic === 'ready' && staged !== 'ready') {
          if (staged !== 'printing') throw new ExecutionFenceError('needs_reconciliation');
          deps.store.transitionAndStagePublicStatus(job.submissionId, state, changedAt, 'ready');
          staged = 'ready';
          await publishVerifiedReady(deps.store, deps.cloud, job.submissionId);
        } else {
          deps.store.transition(job.submissionId, state, changedAt);
        }
      });
      return { kind: 'completed', submissionId: job.submissionId };
    } catch (cause) {
      if (cause instanceof ExecutionFenceError) {
        if (cause.outcome === 'needs_reconciliation') {
          deps.store.transition(
            job.submissionId,
            'needs_reconciliation',
            now(),
            cause.message,
          );
        }
        return { kind: cause.outcome, submissionId: job.submissionId };
      }
      const error = cause instanceof Error ? cause.message : String(cause);
      deps.store.transition(job.submissionId, 'failed', now(), error);
      return { kind: 'failed', submissionId: job.submissionId, error };
    }
  } finally {
    deps.store.releaseExecutionGuard(executionToken);
  }
}

const uncertainStates = new Set<LocalJobState>([
  'declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting',
]);

export function recoverInterruptedJobs(
  store: JobStore,
  changedAt: string,
  _executor?: PhysicalExecutor,
): string[] {
  const recoveryToken = randomUUID();
  if (!store.tryAcquireExecutionGuard(recoveryToken, process.pid)) return [];
  const recovered: string[] = [];
  try {
    for (const job of store.listStates()) {
      if (!uncertainStates.has(job.state)) continue;
      const changed = store.transitionIfCurrentState(
        job.submissionId,
        job.state,
        'needs_reconciliation',
        changedAt,
        'Worker restarted during physical execution.',
      );
      if (changed) recovered.push(job.submissionId);
    }
  } finally {
    store.releaseExecutionGuard(recoveryToken);
  }
  return recovered;
}
