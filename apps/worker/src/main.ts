import type { WorkerDependencies } from './worker.ts';
import { recoverInterruptedJobs, runLocalJob, runWorkerOnce } from './worker.ts';

export async function startWorker(dependencies: WorkerDependencies) {
  recoverInterruptedJobs(dependencies.store, (dependencies.now ?? (() => new Date().toISOString()))());
  const resumable = dependencies.store.list().find((job) =>
    ['claimed', 'rendering', 'validating', 'ready_to_declare'].includes(job.state),
  );
  if (resumable) return runLocalJob(dependencies, resumable);
  return runWorkerOnce(dependencies);
}
