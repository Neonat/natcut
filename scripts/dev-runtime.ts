import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirebaseBearerVerifier, buildSubmissionServer, createSubmissionRepository, createTrustedManifestValidator } from '../apps/submission/src/index.ts';
import { createFirestoreCloudQueue, JobStore, runLocalJob, SimulatedPrinter } from '../apps/worker/src/index.ts';
import { loadRgbaAsset, type AssetCatalog } from '../packages/render/src/index.ts';

const projectId = process.env.NATCUT_PROJECT_ID;
if (projectId !== 'demo-natcut') throw new Error('Local runtime requires NATCUT_PROJECT_ID=demo-natcut');
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080') throw new Error('Firestore emulator must use 127.0.0.1:8080');
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
      const claim = await cloud.claimNextSubmission('dev-mac');
      if (!claim) return send(response, 404, { error: 'QUEUE_EMPTY' });
      store.insertClaimed(claim);
      currentSubmissionId = claim.submission.id;
      return send(response, 200, { submissionId: currentSubmissionId, publicStatus: 'next' });
    }
    if (request.method === 'POST' && request.url === '/start') {
      if (!currentSubmissionId) return send(response, 409, { error: 'NO_CLAIMED_JOB' });
      if (execution) return send(response, 409, { error: 'SIMULATOR_BUSY' });
      const job = store.getBySubmissionId(currentSubmissionId);
      if (!job) return send(response, 404, { error: 'LOCAL_JOB_MISSING' });
      execution = runLocalJob(
        { workerId: 'dev-mac', cloud, store, executor: new SimulatedPrinter({ delayMs: 260 }) },
        job,
      ).finally(() => { execution = null; });
      return send(response, 202, { submissionId: currentSubmissionId, started: true });
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
