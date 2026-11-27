import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { createGcsArtifactPublisher, NATCUT_ARTIFACT_BUCKET } from '@natcut/artifacts';
import { loadPackagedAssets } from '@natcut/render';
import { createFirebaseBearerVerifier } from './auth.ts';
import { createSubmissionRepository, resolveSubmissionFirestoreSelection } from './repository.ts';
import { createSurveyRepository } from './survey-repository.ts';
import { buildSubmissionServer } from './routes.ts';
import { createTrustedArtifactPreparer } from './validation.ts';

type RuntimeEnvironment = Record<string, string | undefined>;
export { NATCUT_ARTIFACT_BUCKET };

export type CloudRunConfig = {
  projectId: 'sprout-dev-66f08';
  databaseId: 'natcut';
  artifactBucket: typeof NATCUT_ARTIFACT_BUCKET;
  statusTokenSecret: string;
  port: number;
  host: '0.0.0.0';
};

export function readCloudRunConfig(environment: RuntimeEnvironment): CloudRunConfig {
  if (environment.FIREBASE_AUTH_EMULATOR_HOST !== undefined) {
    throw new Error('Production must not use FIREBASE_AUTH_EMULATOR_HOST.');
  }
  const selection = resolveSubmissionFirestoreSelection(environment);
  if (selection.projectId !== 'sprout-dev-66f08' || selection.databaseId !== 'natcut') {
    throw new Error('Cloud Run requires the isolated NatCut production database.');
  }
  if (environment.NATCUT_ARTIFACT_BUCKET !== NATCUT_ARTIFACT_BUCKET) {
    throw new Error('Cloud Run requires NATCUT_ARTIFACT_BUCKET=' + NATCUT_ARTIFACT_BUCKET);
  }
  for (const name of ['STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
    if (environment[name] !== undefined) throw new Error('Production must not use ' + name);
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
    artifactBucket: NATCUT_ARTIFACT_BUCKET,
    statusTokenSecret,
    port,
    host: '0.0.0.0',
  };
}

export async function createCloudRunSubmissionServer(
  environment: RuntimeEnvironment = process.env,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
) {
  const config = readCloudRunConfig(environment);
  const admin = getApps().find((candidate) => candidate.name === 'natcut-submission')
    ?? initializeApp({ projectId: config.projectId }, 'natcut-submission');
  const firestore = getFirestore(admin, config.databaseId);
  const artwork = path.join(repoRoot, 'packages/render/catalog/artwork');
  return {
    config,
    server: buildSubmissionServer({
      eventId: 'devfest-sg',
      statusTokenSecret: config.statusTokenSecret,
      repository: createSubmissionRepository(firestore),
      surveyRepository: createSurveyRepository(firestore),
      verifyBearerToken: createFirebaseBearerVerifier(getAuth(admin)),
      prepareArtifact: createTrustedArtifactPreparer((plan) => loadPackagedAssets(plan, artwork)),
      publisher: createGcsArtifactPublisher(getStorage(admin).bucket(config.artifactBucket)),
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
