import { generateKeyPairSync } from 'node:crypto';
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
  JobStore,
  resolveWorkerFirestoreSelection,
} from '../apps/worker/src/index.ts';
import { readSubmissionListener } from './dev-config.mjs';
import { startSimulatorDesk } from '../apps/worker/src/simulator-desk.ts';
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

const { host: submissionHost, corsOrigin } = readSubmissionListener(process.env);
const allowedOrigin = new RegExp(`^${RegExp.escape(corsOrigin)}$`);

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
  corsOrigin: allowedOrigin,
});
await submission.listen({ host: submissionHost, port: 8088 });

const store = new JobStore(process.env.NATCUT_SQLITE_PATH ?? ':memory:');
const control = await startSimulatorDesk({ firestore, store, eventId: 'devfest-sg' });
process.send?.('natcut-runtime-ready');

async function shutdown() {
  control.close();
  store.close();
  await submission.close();
}
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
