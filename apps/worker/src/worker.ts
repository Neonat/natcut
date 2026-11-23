import type { CloudQueue } from './cloud-queue.ts';
import type { JobStore, LocalJobState, LocalPrintJob } from './job-store.ts';
import type { PhysicalExecutor } from './simulated-printer.ts';

export type WorkerResult =
  | { kind: 'idle' }
  | { kind: 'completed'; submissionId: string }
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
  await flushPublicStatusOutbox(deps.store, deps.cloud);
  const claim = await deps.cloud.recoverClaim(deps.workerId)
    ?? await deps.cloud.claimNextSubmission(deps.workerId);
  if (!claim) return { kind: 'idle' };
  deps.store.ensureClaimed(claim);
  const job = deps.store.getBySubmissionId(claim.submission.id)!;
  if (job.state === 'ready') {
    deps.store.stagePublicStatus(job.submissionId, 'ready', job.stateChangedAt);
    await flushPublicStatusOutbox(deps.store, deps.cloud);
    return { kind: 'completed', submissionId: job.submissionId };
  }
  if (!safelyExecutableStates.has(job.state)) {
    return { kind: 'needs_reconciliation', submissionId: job.submissionId };
  }
  return runLocalJob(deps, job);
}

export async function runLocalJob(
  deps: WorkerDependencies,
  job: LocalPrintJob,
): Promise<WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  let staged = publicStatusFor(job.state);

  try {
    await deps.executor.execute(job, async (state, changedAt) => {
      deps.store.transition(job.submissionId, state, changedAt);
      const nextPublic = publicStatusFor(state);
      if (nextPublic !== staged) {
        staged = nextPublic;
        if (nextPublic !== 'next') {
          deps.store.stagePublicStatus(job.submissionId, nextPublic, changedAt);
          await flushPublicStatusOutbox(deps.store, deps.cloud);
        }
      }
    });
    return { kind: 'completed', submissionId: job.submissionId };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    deps.store.transition(job.submissionId, 'failed', now(), error);
    return { kind: 'failed', submissionId: job.submissionId, error };
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
