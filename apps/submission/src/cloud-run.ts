import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { loadRgbaAsset, type AssetCatalog } from '@natcut/render';
import { createFirebaseBearerVerifier } from './auth.ts';
import { createSubmissionRepository, resolveSubmissionFirestoreSelection } from './repository.ts';
import { buildSubmissionServer } from './routes.ts';
import { createTrustedManifestValidator } from './validation.ts';

type RuntimeEnvironment = Record<string, string | undefined>;

export type CloudRunConfig = {
  projectId: 'sprout-dev-66f08';
  databaseId: 'natcut';
  statusTokenSecret: string;
  port: number;
  host: '0.0.0.0';
};

export function readCloudRunConfig(environment: RuntimeEnvironment): CloudRunConfig {
  const selection = resolveSubmissionFirestoreSelection(environment);
  if (selection.projectId !== 'sprout-dev-66f08' || selection.databaseId !== 'natcut') {
    throw new Error('Cloud Run requires the isolated NatCut production database.');
  }
  const statusTokenSecret = environment.NATCUT_STATUS_TOKEN_SECRET;
  if (!statusTokenSecret || Buffer.byteLength(statusTokenSecret) < 32) {
    throw new Error('NATCUT_STATUS_TOKEN_SECRET must contain at least 32 bytes.');
  }
  const port = Number(environment.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }
  return {
    projectId: selection.projectId,
    databaseId: selection.databaseId,
    statusTokenSecret,
    port,
    host: '0.0.0.0',
  };
}

async function loadTrustedAssets(repoRoot: string): Promise<AssetCatalog> {
  const fixture = (filename: string) => path.join(repoRoot, 'fixtures/assets', filename);
  const assets = await Promise.all([
    loadRgbaAsset(fixture('sprite-fixture.png'), 'sprite/monstera-v1'),
    loadRgbaAsset(fixture('sprite-fixture.png'), 'trainer/friend-v1'),
    loadRgbaAsset(fixture('sprout-wordmark.png'), 'branding/logo'),
    loadRgbaAsset(fixture('sprout-wordmark.png'), 'branding/logo-and-sprites'),
    loadRgbaAsset(fixture('sprout-wordmark.png'), 'branding/logo-and-species'),
  ]);
  return new Map(assets.map((asset) => [asset.id, asset]));
}

export async function createCloudRunSubmissionServer(
  environment: RuntimeEnvironment = process.env,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
) {
  const config = readCloudRunConfig(environment);
  const admin = getApps().find((candidate) => candidate.name === 'natcut-submission')
    ?? initializeApp({ projectId: config.projectId }, 'natcut-submission');
  const firestore = getFirestore(admin, config.databaseId);
  const assets = await loadTrustedAssets(repoRoot);
  return {
    config,
    server: buildSubmissionServer({
      eventId: 'devfest-sg',
      statusTokenSecret: config.statusTokenSecret,
      repository: createSubmissionRepository(firestore),
      verifyBearerToken: createFirebaseBearerVerifier(getAuth(admin)),
      validateManifest: createTrustedManifestValidator(assets),
      routePrefix: '/api',
    }),
  };
}

export async function startCloudRunSubmissionService(environment: RuntimeEnvironment = process.env) {
  const { config, server } = await createCloudRunSubmissionServer(environment);
  await server.listen({ host: config.host, port: config.port });
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await startCloudRunSubmissionService();
}
