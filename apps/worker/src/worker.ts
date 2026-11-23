import type { CloudQueue } from './cloud-queue.ts';
import type { JobStore, LocalJobState, LocalPrintJob } from './job-store.ts';
import type { PhysicalExecutor } from './simulated-printer.ts';

export type WorkerResult =
  | { kind: 'idle' }
  | { kind: 'completed'; submissionId: string }
  | { kind: 'failed'; submissionId: string; error: string };

export type WorkerDependencies = {
  workerId: string;
  cloud: CloudQueue;
  store: JobStore;
  executor: PhysicalExecutor;
  now?: () => string;
};

function publicStatusFor(state: LocalJobState): 'next' | 'printing' | 'ready' {
  if (state === 'ready') return 'ready';
  if (['uploading_cut', 'uploading_image', 'printing', 'cutting'].includes(state)) return 'printing';
  return 'next';
}

export async function runWorkerOnce(deps: WorkerDependencies): Promise<WorkerResult> {
  const claim = await deps.cloud.claimNextSubmission(deps.workerId);
  if (!claim) return { kind: 'idle' };
  deps.store.insertClaimed(claim);
  const job = deps.store.getBySubmissionId(claim.submission.id)!;
  return runLocalJob(deps, job);
}

export async function runLocalJob(
  deps: WorkerDependencies,
  job: LocalPrintJob,
): Promise<WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  let published = publicStatusFor(job.state);

  try {
    await deps.executor.execute(job, async (state, changedAt) => {
      deps.store.transition(job.submissionId, state, changedAt);
      const nextPublic = publicStatusFor(state);
      if (nextPublic !== published) {
        await deps.cloud.updatePublicStatus(job.submissionId, nextPublic, changedAt);
        published = nextPublic;
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
