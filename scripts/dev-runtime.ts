import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import {
  createFirebaseBearerVerifier,
  buildSubmissionServer,
  createSubmissionRepository,
  createTrustedManifestValidator,
  resolveSubmissionFirestoreSelection,
} from '../apps/submission/src/index.ts';
import {
  createFirestoreCloudQueue,
  flushPublicStatusOutbox,
  JobStore,
  prepareNextWorkerJob,
  recoverInterruptedJobs,
  runLocalJob,
  resolveWorkerFirestoreSelection,
  SimulatedPrinter,
} from '../apps/worker/src/index.ts';
import { loadRgbaAsset, type AssetCatalog } from '../packages/render/src/index.ts';

if (process.env.NATCUT_PROJECT_ID !== 'demo-natcut') {
  throw new Error('Local runtime requires NATCUT_PROJECT_ID=demo-natcut.');
}
if (process.env.NATCUT_DATABASE_ID !== undefined) {
  throw new Error('Local runtime must not set NATCUT_DATABASE_ID.');
}
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080') {
  throw new Error('Local runtime requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8080.');
}
const submissionSelection = resolveSubmissionFirestoreSelection(process.env);
const workerSelection = resolveWorkerFirestoreSelection(process.env);
if (submissionSelection.projectId !== workerSelection.projectId || submissionSelection.databaseId !== workerSelection.databaseId) {
  throw new Error('Submission and worker Firestore selections must match.');
}
const projectId = submissionSelection.projectId;
if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') throw new Error('Auth emulator must use 127.0.0.1:9099');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateKey = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
const admin = initializeApp({
  projectId,
  credential: cert({ projectId, clientEmail: 'emulator@demo-natcut.iam.gserviceaccount.com', privateKey }),
});
const firestore = getFirestore(admin);
const assetsList = await Promise.all([
  loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprite-fixture.png'), 'sprite/monstera-v1'),
  loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprite-fixture.png'), 'trainer/friend-v1'),
  loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprout-wordmark.png'), 'branding/logo'),
  loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprout-wordmark.png'), 'branding/logo-and-sprites'),
  loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprout-wordmark.png'), 'branding/logo-and-species'),
]);
const assets: AssetCatalog = new Map(assetsList.map((asset) => [asset.id, asset]));

const submission = buildSubmissionServer({
  eventId: 'devfest-sg',
  statusTokenSecret: 'local-demo-status-token-secret-32-bytes-minimum',
  repository: createSubmissionRepository(firestore),
  verifyBearerToken: createFirebaseBearerVerifier(getAuth(admin)),
  validateManifest: createTrustedManifestValidator(assets),
  corsOrigin: 'http://127.0.0.1:4174',
});
await submission.listen({ host: '127.0.0.1', port: 8088 });

const cloud = createFirestoreCloudQueue(firestore);
const store = new JobStore(process.env.NATCUT_SQLITE_PATH ?? ':memory:');
recoverInterruptedJobs(store, new Date().toISOString());
await flushPublicStatusOutbox(store, cloud);
let currentSubmissionId: string | null = null;
let execution: Promise<unknown> | null = null;

function send(response: import('node:http').ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const control = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true });
    if (request.method === 'POST' && request.url === '/claim') {
      if (execution) return send(response, 409, { error: 'SIMULATOR_BUSY' });
      if (currentSubmissionId) return send(response, 409, { error: 'JOB_ALREADY_CLAIMED' });
      const prepared = await prepareNextWorkerJob({ workerId: 'dev-mac', cloud, store });
      if (prepared.kind === 'idle') return send(response, 404, { error: 'QUEUE_EMPTY' });
      if (prepared.kind === 'waiting_for_cloud') return send(response, 503, { error: 'STATUS_SYNC_PENDING' });
      if (prepared.kind !== 'prepared') {
        return send(response, 409, { error: 'JOB_NEEDS_RECONCILIATION', submissionId: prepared.submissionId });
      }
      currentSubmissionId = prepared.job.submissionId;
      return send(response, 200, { submissionId: currentSubmissionId, publicStatus: 'next' });
    }
    if (request.method === 'POST' && request.url === '/start') {
      if (!currentSubmissionId) return send(response, 409, { error: 'NO_CLAIMED_JOB' });
      if (execution) return send(response, 409, { error: 'SIMULATOR_BUSY' });
      const job = store.getBySubmissionId(currentSubmissionId);
      if (!job) return send(response, 404, { error: 'LOCAL_JOB_MISSING' });
      if (!['claimed', 'rendering', 'validating', 'ready_to_declare'].includes(job.state)) {
        return send(response, 409, { error: 'JOB_NOT_SAFE_TO_START', state: job.state });
      }
      const startedSubmissionId = currentSubmissionId;
      execution = runLocalJob(
        { workerId: 'dev-mac', cloud, store, executor: new SimulatedPrinter({ delayMs: 260 }) },
        job,
      ).finally(() => {
        execution = null;
        currentSubmissionId = null;
      });
      return send(response, 202, { submissionId: startedSubmissionId, started: true });
    }
    return send(response, 404, { error: 'NOT_FOUND' });
  } catch (cause) {
    return send(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
  }
});
await new Promise<void>((resolve) => control.listen(8090, '127.0.0.1', resolve));

async function shutdown() {
  control.close();
  store.close();
  await submission.close();
}
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
