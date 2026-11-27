import path from 'node:path';
import { NATCUT_ARTIFACT_BUCKET } from '@natcut/artifacts';
import { resolveWorkerFirestoreSelection } from './cloud-queue.ts';
import type { WorkerResult } from './worker.ts';

type RuntimeEnvironment = Record<string, string | undefined>;

export type CloudWorkerConfig = {
  projectId: 'sprout-dev-66f08';
  databaseId: 'natcut';
  artifactBucket: typeof NATCUT_ARTIFACT_BUCKET;
  sqlitePath: string;
  workerId: string;
  pollIntervalMs: number;
  simulationPhaseDelayMs: number;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

export function readCloudWorkerConfig(environment: RuntimeEnvironment): CloudWorkerConfig {
  const selection = resolveWorkerFirestoreSelection(environment);
  if (selection.projectId !== 'sprout-dev-66f08' || selection.databaseId !== 'natcut') {
    throw new Error('Production requires NATCUT_PROJECT_ID=sprout-dev-66f08 and NATCUT_DATABASE_ID=natcut.');
  }
  if (environment.NATCUT_ARTIFACT_BUCKET !== NATCUT_ARTIFACT_BUCKET) {
    throw new Error('Worker requires NATCUT_ARTIFACT_BUCKET=' + NATCUT_ARTIFACT_BUCKET);
  }
  for (const name of ['STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
    if (environment[name] !== undefined) throw new Error('Production must not use ' + name);
  }
  const sqlitePath = environment.NATCUT_SQLITE_PATH;
  if (!sqlitePath || !path.isAbsolute(sqlitePath) || sqlitePath === ':memory:' || sqlitePath.includes('::memory:')) {
    throw new Error('NATCUT_SQLITE_PATH must be a durable absolute path, not an in-memory or relative database.');
  }
  const workerId = environment.NATCUT_WORKER_ID?.trim();
  if (!workerId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(workerId)) {
    throw new Error('NATCUT_WORKER_ID must be 3-64 letters, numbers, underscores, or hyphens.');
  }
  return {
    projectId: selection.projectId,
    databaseId: selection.databaseId,
    artifactBucket: NATCUT_ARTIFACT_BUCKET,
    sqlitePath,
    workerId,
    pollIntervalMs: boundedInteger(environment.NATCUT_POLL_INTERVAL_MS, 2_000, 500, 30_000, 'NATCUT_POLL_INTERVAL_MS'),
    simulationPhaseDelayMs: boundedInteger(
      environment.NATCUT_SIMULATION_PHASE_DELAY_MS,
      260,
      0,
      10_000,
      'NATCUT_SIMULATION_PHASE_DELAY_MS',
    ),
  };
}

type PollingOptions = {
  signal: AbortSignal;
  intervalMs: number;
  runOnce: () => Promise<WorkerResult>;
  onResult?: (result: WorkerResult) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function runWorkerPollingLoop(options: PollingOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  while (!options.signal.aborted) {
    const result = await options.runOnce();
    options.onResult?.(result);
    if (options.signal.aborted) return;
    await sleep(options.intervalMs, options.signal);
  }
}
