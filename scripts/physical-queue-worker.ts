import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findByIds } from 'usb';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createGcsArtifactReader } from '@natcut/artifacts';
import { createFirestoreCloudQueue } from '../apps/worker/src/cloud-queue.ts';
import { readCloudWorkerConfig } from '../apps/worker/src/cloud-worker-runtime.ts';
import { JobStore } from '../apps/worker/src/job-store.ts';
import { prepareNextWorkerJob, runLocalJob } from '../apps/worker/src/worker.ts';
import { ReadOnlyPixCut } from '../src/protocol.mjs';
import { openUsbSession } from '../src/usb-session.mjs';
import { assertFreshPhysicalSendJournal, completeObservedPhysicalJob, PhysicalQueueExecutor, printerIsIdle } from './physical-queue-bridge.ts';
import type { TransportAttemptResult } from '../packages/printer/src/transport-attempt.ts';

const hash = /^[a-f0-9]{64}$/;
const { values } = parseArgs({
  args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: {
    action: { type: 'string' }, submission: { type: 'string' }, bundle: { type: 'string' },
    jpeg: { type: 'string' }, plt: { type: 'string' }, confirm: { type: 'string' },
  },
});
if (values.action !== 'send' && values.action !== 'complete') throw new Error('Expected --action send or --action complete.');
if (!values.submission || !/^[A-Za-z0-9_-]{10,128}$/.test(values.submission) ||
    !hash.test(values.bundle ?? '') || !hash.test(values.jpeg ?? '') || !hash.test(values.plt ?? '')) {
  throw new Error('Exact --submission, --bundle, --jpeg, and --plt values are required.');
}
if (values.confirm !== (values.action === 'send' ? 'SEND ONE SHEET' : 'PASS COLOR CUT PEEL')) {
  throw new Error('Exact operator confirmation is required for this action.');
}
const config = readCloudWorkerConfig(process.env);
const journalDirectory = process.env.NATCUT_PHYSICAL_JOURNAL_DIR;
if (!journalDirectory || !path.isAbsolute(journalDirectory)) {
  throw new Error('NATCUT_PHYSICAL_JOURNAL_DIR must be a durable absolute directory.');
}
const expected = {
  submissionId: values.submission, bundleSha256: values.bundle!,
  jpegSha256: values.jpeg!, pltSha256: values.plt!,
};

await mkdir(path.dirname(config.sqlitePath), { recursive: true });
await mkdir(journalDirectory, { recursive: true });
const admin = getApps().find(candidate => candidate.name === 'natcut-physical-queue')
  ?? initializeApp({ projectId: config.projectId }, 'natcut-physical-queue');
const cloud = createFirestoreCloudQueue(getFirestore(admin, config.databaseId));
const artifactReader = createGcsArtifactReader(getStorage(admin).bucket(config.artifactBucket));
const store = new JobStore(config.sqlitePath);
const openSession = () => (openUsbSession as unknown as (options: {
  usbModule: { findByIds: typeof findByIds };
}) => ReturnType<typeof openUsbSession>)({ usbModule: { findByIds } });

try {
  if (values.action === 'send') {
    assertFreshPhysicalSendJournal(store);
    // Refuse to claim a cloud slot if this Mac cannot currently see an idle printer.
    const session = await openSession();
    try {
      const snapshot = await new ReadOnlyPixCut(session.io).physicalIdleProof();
      if (!printerIsIdle(snapshot)) {
        throw new Error('Printer is not idle and clear of alerts and active jobs.');
      }
      console.log(JSON.stringify({ event: 'printer_preflight', status: snapshot.status, activeJobs: snapshot.activeJobs }));
    } finally {
      await session.close();
    }
    const prepared = await prepareNextWorkerJob({
      workerId: config.workerId, expectedSubmissionId: expected.submissionId,
      cloud, store, artifactReader,
    });
    if (prepared.kind !== 'prepared') {
      console.log(JSON.stringify({ event: 'queue_preparation', ...prepared }));
      process.exitCode = 1;
    } else {
      let transferResult: TransportAttemptResult | undefined;
      const executor = new PhysicalQueueExecutor({
        store, workerId: config.workerId, journalDirectory, expected, openSession,
        onTransferResult: result => { transferResult = result; },
      });
      const result = await runLocalJob({ workerId: config.workerId, expectedSubmissionId: expected.submissionId,
        cloud, store, executor, artifactReader }, prepared.job);
      console.log(JSON.stringify({ event: 'physical_queue_send', ...result, transferResult }));
      if (result.kind !== 'needs_reconciliation' || transferResult?.reason !== 'physical_observation_required') {
        process.exitCode = 1;
      }
    }
  } else {
    const result = await completeObservedPhysicalJob({ store, cloud, workerId: config.workerId,
      journalDirectory, expected });
    console.log(JSON.stringify({ event: 'physical_queue_completion', ...result }));
    if (result.kind !== 'completed') process.exitCode = 1;
  }
} finally {
  store.close();
  await deleteApp(admin);
}
