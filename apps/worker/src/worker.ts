import { randomUUID } from 'node:crypto';
import type { CloudQueue } from './cloud-queue.ts';
import type { JobStore, LocalJobState, LocalPrintJob } from './job-store.ts';
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
  now?: () => string;
};

const safelyExecutableStates = new Set<LocalJobState>([
  'claimed', 'rendering', 'validating', 'ready_to_declare',
]);

export async function flushPublicStatusOutbox(
  store: JobStore,
  cloud: CloudQueue,
): Promise<void> {
  for (const pending of store.listPendingPublicStatuses()) {
    try {
      await cloud.updatePublicStatus(pending.submissionId, pending.status, pending.updatedAt);
      store.clearPendingPublicStatus(pending.id);
    } catch {
      // Preserve ordering: `ready` must never overtake an unpublished `printing`.
      return;
    }
  }
}

function publicStatusFor(state: LocalJobState): 'next' | 'printing' | 'ready' {
  if (state === 'ready') return 'ready';
  if (['uploading_cut', 'uploading_image', 'printing', 'cutting'].includes(state)) return 'printing';
  return 'next';
}

export async function runWorkerOnce(deps: WorkerDependencies): Promise<WorkerResult> {
  const prepared = await prepareNextWorkerJob(deps);
  if (prepared.kind !== 'prepared') return prepared;
  return runLocalJob(deps, prepared.job);
}

export async function prepareNextWorkerJob(
  deps: Pick<WorkerDependencies, 'workerId' | 'cloud' | 'store'>,
): Promise<{ kind: 'prepared'; job: LocalPrintJob } | WorkerResult> {
  await flushPublicStatusOutbox(deps.store, deps.cloud);
  let claim = await deps.cloud.recoverClaim(deps.workerId);
  if (claim) {
    const safeToResume = deps.store.ensureClaimed(claim);
    const recovered = deps.store.getBySubmissionId(claim.submission.id)!;
    if (!safeToResume) {
      return { kind: 'needs_reconciliation', submissionId: recovered.submissionId };
    }
    if (recovered.state === 'ready') {
      if (claim.submission.publicStatus === 'next') {
        deps.store.stagePublicStatus(recovered.submissionId, 'printing', recovered.stateChangedAt);
      }
      deps.store.stagePublicStatus(recovered.submissionId, 'ready', recovered.stateChangedAt);
      await flushPublicStatusOutbox(deps.store, deps.cloud);
      const stillPending = deps.store.listPendingPublicStatuses()
        .some((pending) => pending.submissionId === recovered.submissionId);
      if (stillPending) return { kind: 'waiting_for_cloud', submissionId: recovered.submissionId };
      claim = null;
    } else if (!safelyExecutableStates.has(recovered.state)) {
      return { kind: 'needs_reconciliation', submissionId: recovered.submissionId };
    } else {
      return { kind: 'prepared', job: recovered };
    }
  }

  claim ??= await deps.cloud.claimNextSubmission(deps.workerId);
  if (!claim) return { kind: 'idle' };
  const safeToResume = deps.store.ensureClaimed(claim);
  const job = deps.store.getBySubmissionId(claim.submission.id)!;
  if (!safeToResume) {
    return { kind: 'needs_reconciliation', submissionId: job.submissionId };
  }
  if (!safelyExecutableStates.has(job.state)) {
    return { kind: 'needs_reconciliation', submissionId: job.submissionId };
  }
  return { kind: 'prepared', job };
}

export async function runLocalJob(
  deps: WorkerDependencies,
  job: LocalPrintJob,
): Promise<WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  let staged = publicStatusFor(job.state);
  const executionToken = randomUUID();
  if (!deps.store.tryAcquireExecutionGuard(executionToken, process.pid)) {
    return { kind: 'busy', submissionId: job.submissionId };
  }

  try {
    try {
      await deps.executor.execute(job, async (state, changedAt) => {
        const nextPublic = publicStatusFor(state);
        if (nextPublic !== staged && nextPublic !== 'next') {
          deps.store.transitionAndStagePublicStatus(job.submissionId, state, changedAt, nextPublic);
          staged = nextPublic;
          await flushPublicStatusOutbox(deps.store, deps.cloud);
        } else {
          deps.store.transition(job.submissionId, state, changedAt);
        }
      });
      return { kind: 'completed', submissionId: job.submissionId };
    } catch (cause) {
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
  const recovered: string[] = [];
  for (const job of store.list()) {
    if (!uncertainStates.has(job.state)) continue;
    store.transition(job.submissionId, 'needs_reconciliation', changedAt, 'Worker restarted during physical execution.');
    recovered.push(job.submissionId);
  }
  return recovered;
}
