import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ArtifactReceiptSchema,
  SubmissionSchema,
  decodeLogicalSourceBundle,
  manifestHash,
  type ArtifactReceipt,
  type CompositionManifest,
  type Submission,
} from '@natcut/domain';
import { catalogManifest } from '@natcut/render';

const project = 'sprout-dev-66f08';
const database = 'natcut';
const eventId = 'devfest-sg';
const bucket = 'sprout-dev-66f08-natcut-artifacts';
const api = 'https://natcut.web.app/api';
const workerIdentity = `natcut-worker@${project}.iam.gserviceaccount.com`;
const webAppId = '1:485412794128:web:ef3ea0d8607992e27b7f95';

type RuntimeEnvironment = Record<string, string | undefined>;

type SmokeAttempt = {
  version: 1;
  state: 'prepared' | 'authenticated' | 'accepted' | 'verified';
  idempotencyKey: string;
  createdAt: string;
  ownerUid?: string;
  submissionId?: string;
  queueNumber?: number;
  publicStatus?: 'queued';
};

type AttemptStore = {
  load(): Promise<SmokeAttempt | null>;
  save(attempt: SmokeAttempt): Promise<void>;
};

type AcceptedAttempt = { submissionId: string; queueNumber: number; publicStatus: 'queued' };

type SmokeDependencies = {
  apiKey: string;
  manifest: CompositionManifest;
  request?: typeof fetch;
  uuid?: () => string;
  verifyApiKey: (apiKey: string) => Promise<void>;
  attemptStore: AttemptStore;
  recoverAcceptedAttempt: (attempt: SmokeAttempt & { ownerUid: string }) => Promise<AcceptedAttempt | null>;
  inspectSubmission: (id: string) => Promise<unknown>;
  readArtifact: (receipt: ArtifactReceipt) => Promise<Uint8Array>;
};

export function validateSubmissionSmokeArguments(args: string[], environment: RuntimeEnvironment) {
  if (args.length !== 0) throw new Error('NatCut submission smoke does not accept arguments or target overrides.');
  const apiKey = environment.NATCUT_FIREBASE_API_KEY;
  if (!apiKey?.trim()) throw new Error('NATCUT_FIREBASE_API_KEY is required.');
  return { apiKey };
}

async function responseJson(response: Response, operation: string) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${operation} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function runSubmissionSmoke(deps: SmokeDependencies) {
  const request = deps.request ?? fetch;
  let attempt = await deps.attemptStore.load();
  if (!attempt) {
    attempt = {
      version: 1,
      state: 'prepared',
      idempotencyKey: `cloud-smoke-${(deps.uuid ?? randomUUID)()}`,
      createdAt: new Date().toISOString(),
    };
    await deps.attemptStore.save(attempt);
  }

  let accepted: AcceptedAttempt;
  let ownerUid = attempt.ownerUid;
  if (attempt.state === 'prepared') {
    await deps.verifyApiKey(deps.apiKey);
    const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(deps.apiKey)}`;
    const auth = await responseJson(await request(authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    }), 'anonymous authentication') as { idToken?: unknown; localId?: unknown };
    if (typeof auth.idToken !== 'string' || typeof auth.localId !== 'string') {
      throw new Error('Anonymous authentication returned incomplete identity evidence.');
    }
    ownerUid = auth.localId;
    attempt = { ...attempt, state: 'authenticated', ownerUid };
    await deps.attemptStore.save(attempt);
    const response = await responseJson(await request(`${api}/v1/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: deps.manifest, idempotencyKey: attempt.idempotencyKey }),
    }), 'submission') as Record<string, unknown>;
    if (typeof response.submissionId !== 'string' || !Number.isInteger(response.queueNumber) ||
      response.publicStatus !== 'queued' || typeof response.statusToken !== 'string') {
      throw new Error('Submission API returned incomplete acceptance evidence.');
    }
    accepted = {
      submissionId: response.submissionId,
      queueNumber: response.queueNumber as number,
      publicStatus: response.publicStatus,
    };
    attempt = { ...attempt, state: 'accepted', ...accepted };
    await deps.attemptStore.save(attempt);
  } else if (attempt.state === 'authenticated') {
    if (!ownerUid) throw new Error('Durable smoke attempt is missing its authenticated owner identity.');
    const recovered = await deps.recoverAcceptedAttempt(attempt as SmokeAttempt & { ownerUid: string });
    if (!recovered) {
      throw new Error('Durable smoke attempt has an ambiguous submission outcome; refusing to create another ticket.');
    }
    accepted = recovered;
    attempt = { ...attempt, state: 'accepted', ...accepted };
    await deps.attemptStore.save(attempt);
  } else {
    if (!attempt.submissionId || !Number.isInteger(attempt.queueNumber) || attempt.publicStatus !== 'queued') {
      throw new Error('Durable smoke attempt has incomplete accepted-ticket evidence.');
    }
    accepted = {
      submissionId: attempt.submissionId,
      queueNumber: attempt.queueNumber!,
      publicStatus: attempt.publicStatus,
    };
  }
  if (!ownerUid) throw new Error('Durable smoke attempt is missing its owner identity.');

  const submission = SubmissionSchema.parse(await deps.inspectSubmission(accepted.submissionId));
  const requestedManifestHash = await manifestHash(deps.manifest);
  const storedManifestHash = await manifestHash(submission.manifest);
  if (requestedManifestHash !== storedManifestHash || submission.manifestHash !== requestedManifestHash) {
    throw new Error('Stored submission manifest does not match the canonical requested design.');
  }
  if (submission.id !== accepted.submissionId || submission.ownerUid !== ownerUid ||
    submission.eventId !== eventId || submission.idempotencyKey !== attempt.idempotencyKey ||
    submission.queueNumber !== accepted.queueNumber || submission.publicStatus !== accepted.publicStatus ||
    submission.recordVersion !== 2 || !submission.artifact) {
    throw new Error('Stored submission identity or V2 artifact evidence differs from the accepted ticket.');
  }
  const receipt = ArtifactReceiptSchema.parse(submission.artifact);
  const bytes = await deps.readArtifact(receipt);
  await decodeLogicalSourceBundle(bytes, receipt.descriptor);
  attempt = { ...attempt, state: 'verified', ...accepted };
  await deps.attemptStore.save(attempt);

  return {
    submissionId: submission.id,
    queueNumber: submission.queueNumber,
    publicStatus: submission.publicStatus,
    idempotencyKey: attempt.idempotencyKey,
    ownerUid: submission.ownerUid,
    eventId: submission.eventId,
    objectName: `logical/v1/${receipt.descriptor.bundleSha256}`,
    generation: receipt.generation,
    bundleSha256: receipt.descriptor.bundleSha256,
    profileId: receipt.descriptor.profile.id,
    profileVersion: receipt.descriptor.profile.version,
  };
}

function gcloudAccessToken(args: string[] = []) {
  return execFileSync('gcloud', ['auth', 'print-access-token', `--project=${project}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

async function verifyLiveApiKey(apiKey: string) {
  const output = execFileSync('firebase', [
    'apps:sdkconfig', 'WEB', webAppId,
    '--project', project,
    '--json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const configured = JSON.parse(output)?.result?.sdkConfig?.apiKey;
  if (configured !== apiKey) throw new Error('Firebase API key does not belong to the NatCut web app.');
}

function localAttemptStore(filename: string): AttemptStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filename, 'utf8')) as SmokeAttempt;
        if (parsed?.version !== 1 || !['prepared', 'authenticated', 'accepted', 'verified'].includes(parsed.state) ||
          typeof parsed.idempotencyKey !== 'string' || typeof parsed.createdAt !== 'string') {
          throw new Error('Durable smoke attempt is malformed.');
        }
        return parsed;
      } catch (error: any) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async save(attempt) {
      await mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
    },
  };
}

function decodeFirestoreValue(value: any): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeFirestoreValue);
  if ('mapValue' in value) return decodeFirestoreFields(value.mapValue.fields ?? {});
  throw new Error('Unsupported Firestore value in smoke evidence.');
}

function decodeFirestoreFields(fields: Record<string, any>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

async function inspectLiveSubmission(id: string): Promise<Submission> {
  const token = gcloudAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/submissions/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': project },
  });
  const body = await responseJson(response, 'Firestore receipt inspection') as { fields?: Record<string, any> };
  if (!body.fields) throw new Error('Firestore receipt inspection returned no fields.');
  return SubmissionSchema.parse(decodeFirestoreFields(body.fields));
}

async function recoverLiveAttempt(attempt: SmokeAttempt & { ownerUid: string }): Promise<AcceptedAttempt | null> {
  const token = gcloudAccessToken();
  const bindingId = createHash('sha256')
    .update(`${attempt.ownerUid}\0${eventId}\0${attempt.idempotencyKey}`)
    .digest('hex');
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents`;
  const response = await fetch(`${base}/submissionIdempotency/${bindingId}`, {
    headers: { authorization: `Bearer ${token}`, 'x-goog-user-project': project },
  });
  if (response.status === 404) return null;
  const body = await responseJson(response, 'idempotency recovery') as { fields?: Record<string, any> };
  if (!body.fields) throw new Error('Idempotency recovery returned no fields.');
  const binding = decodeFirestoreFields(body.fields) as { submissionId?: unknown };
  if (typeof binding.submissionId !== 'string') throw new Error('Idempotency recovery returned no submission ID.');
  const submission = await inspectLiveSubmission(binding.submissionId);
  if (submission.ownerUid !== attempt.ownerUid || submission.eventId !== eventId ||
    submission.idempotencyKey !== attempt.idempotencyKey || submission.publicStatus !== 'queued') {
    throw new Error('Recovered submission does not match the durable smoke attempt.');
  }
  return {
    submissionId: submission.id,
    queueNumber: submission.queueNumber,
    publicStatus: submission.publicStatus,
  };
}

async function readLiveArtifact(receipt: ArtifactReceipt) {
  const token = gcloudAccessToken([`--impersonate-service-account=${workerIdentity}`]);
  const objectName = `logical/v1/${receipt.descriptor.bundleSha256}`;
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('generation', receipt.generation);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Worker exact-generation read failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function main(args = process.argv.slice(2), environment: RuntimeEnvironment = process.env) {
  const config = validateSubmissionSmokeArguments(args, environment);
  const attemptPath = path.resolve('.local/natcut-cloud-submission-smoke.json');
  const evidence = await runSubmissionSmoke({
    apiKey: config.apiKey,
    manifest: catalogManifest,
    verifyApiKey: verifyLiveApiKey,
    attemptStore: localAttemptStore(attemptPath),
    recoverAcceptedAttempt: recoverLiveAttempt,
    inspectSubmission: inspectLiveSubmission,
    readArtifact: readLiveArtifact,
  });
  console.log(JSON.stringify(evidence, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
