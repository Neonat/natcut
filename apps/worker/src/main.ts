import type { WorkerDependencies } from './worker.ts';
import { recoverInterruptedJobs, runWorkerOnce } from './worker.ts';

export async function startWorker(dependencies: WorkerDependencies) {
  recoverInterruptedJobs(dependencies.store, (dependencies.now ?? (() => new Date().toISOString()))());
  return runWorkerOnce(dependencies);
}
