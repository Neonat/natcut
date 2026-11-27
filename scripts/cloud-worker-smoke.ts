import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createGcsArtifactReader } from '@natcut/artifacts';
import {
  JobStore,
  SimulatedPrinter,
  createFirestoreCloudQueue,
  readCloudWorkerConfig,
  recoverInterruptedJobs,
  runWorkerOnce,
} from '../apps/worker/src/index.ts';

const expectedSubmissionId = process.env.NATCUT_SMOKE_SUBMISSION_ID?.trim();
if (!expectedSubmissionId || !/^[A-Za-z0-9_-]{8,128}$/.test(expectedSubmissionId)) {
  throw new Error('NATCUT_SMOKE_SUBMISSION_ID must identify the one accepted smoke ticket.');
}

const config = readCloudWorkerConfig(process.env);
await mkdir(path.dirname(config.sqlitePath), { recursive: true });
const admin = getApps().find((candidate) => candidate.name === 'natcut-cloud-worker-smoke')
  ?? initializeApp({ projectId: config.projectId }, 'natcut-cloud-worker-smoke');
const firestore = getFirestore(admin, config.databaseId);
const cloud = createFirestoreCloudQueue(firestore);
const artifactReader = createGcsArtifactReader(getStorage(admin).bucket(config.artifactBucket));
const store = new JobStore(config.sqlitePath);
const executor = new SimulatedPrinter({ delayMs: config.simulationPhaseDelayMs });
const deadline = AbortSignal.timeout(120_000);

try {
  const recovered = recoverInterruptedJobs(store, new Date().toISOString());
  if (recovered.length > 0) throw new Error(`Smoke journal needs reconciliation: ${recovered.join(', ')}`);
  for (;;) {
    deadline.throwIfAborted();
    const result = await runWorkerOnce({
      workerId: config.workerId,
      expectedSubmissionId,
      cloud,
      store,
      executor,
      artifactReader,
      signal: deadline,
    });
    console.log(JSON.stringify({ event: 'worker_smoke_result', expectedSubmissionId, ...result }));
    if (result.kind === 'completed' && result.submissionId === expectedSubmissionId) break;
    if (result.kind === 'failed' || result.kind === 'needs_reconciliation') {
      throw new Error(`Smoke worker stopped with ${result.kind} for ${result.submissionId}.`);
    }
    if (result.kind === 'idle') throw new Error('Expected smoke ticket is not the queue head or recoverable slot.');
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
} finally {
  store.close();
  await deleteApp(admin);
}
