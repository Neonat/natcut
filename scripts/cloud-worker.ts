import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createGcsArtifactReader } from '@natcut/artifacts';
import {
  createFirestoreCloudQueue,
  JobStore,
  readCloudWorkerConfig,
  recoverInterruptedJobs,
  runWorkerOnce,
  runWorkerPollingLoop,
  SimulatedPrinter,
} from '../apps/worker/src/index.ts';

const config = readCloudWorkerConfig(process.env);
await mkdir(path.dirname(config.sqlitePath), { recursive: true });

const admin = getApps().find((candidate) => candidate.name === 'natcut-cloud-worker')
  ?? initializeApp({ projectId: config.projectId }, 'natcut-cloud-worker');
const firestore = getFirestore(admin, config.databaseId);
const cloud = createFirestoreCloudQueue(firestore);
const artifactReader = createGcsArtifactReader(getStorage(admin).bucket(config.artifactBucket));
const store = new JobStore(config.sqlitePath);
const executor = new SimulatedPrinter({ delayMs: config.simulationPhaseDelayMs });
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => controller.abort());
}

const recovered = recoverInterruptedJobs(store, new Date().toISOString());
if (recovered.length > 0) {
  console.error(JSON.stringify({ event: 'worker_recovery_required', submissionIds: recovered }));
  controller.abort();
}

try {
  console.log(JSON.stringify({
    event: 'worker_started',
    workerId: config.workerId,
    databaseId: config.databaseId,
    mode: 'simulated',
  }));
  await runWorkerPollingLoop({
    signal: controller.signal,
    intervalMs: config.pollIntervalMs,
    runOnce: () => runWorkerOnce({ workerId: config.workerId, cloud, store, executor, artifactReader, signal: controller.signal }),
    onResult: (result) => {
      console.log(JSON.stringify({ event: 'worker_result', ...result }));
      if (result.kind === 'failed' || result.kind === 'needs_reconciliation') controller.abort();
    },
  });
} finally {
  store.close();
  await deleteApp(admin);
}
