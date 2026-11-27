import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = 'sprout-dev-66f08';
const bucket = 'sprout-dev-66f08-natcut-artifacts';
const identities = [
  ['natcut-submission', `natcut-submission@${project}.iam.gserviceaccount.com`],
  ['natcut-worker', `natcut-worker@${project}.iam.gserviceaccount.com`],
];

export function validateStorageSmokeArguments(args) {
  if (args.length !== 0) throw new Error('NatCut storage smoke does not accept arguments or target overrides.');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function jsonResponse(response, operation) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${operation} failed (${response.status}).`);
  return body;
}

export async function runStorageSmoke({ bytes, objectName, fetch: request = fetch, accessToken }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('Storage smoke bytes must be non-empty.');
  const sha256 = digest(bytes);
  if (objectName !== `smoke/v1/${sha256}`) throw new Error('Storage smoke object name must match the byte digest.');

  const tokenByName = new Map();
  for (const [name, email] of identities) {
    const token = await accessToken(email);
    if (typeof token !== 'string' || token.length === 0) throw new Error(`Missing access token for ${name}.`);
    tokenByName.set(name, token);
  }

  const upload = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`);
  upload.searchParams.set('uploadType', 'media');
  upload.searchParams.set('name', objectName);
  upload.searchParams.set('ifGenerationMatch', '0');
  const uploadHeaders = {
    authorization: `Bearer ${tokenByName.get('natcut-submission')}`,
    'content-type': 'application/octet-stream',
  };
  const created = await jsonResponse(await request(upload, { method: 'POST', headers: uploadHeaders, body: bytes }), 'create');
  if (created?.bucket !== bucket || created?.name !== objectName) throw new Error('Upload response identified the wrong bucket or object.');
  if (typeof created?.generation !== 'string' || !/^[1-9][0-9]*$/.test(created.generation)) {
    throw new Error('Upload response must contain a positive decimal generation.');
  }
  if (created?.size !== String(bytes.byteLength)) throw new Error('Upload response size did not match the smoke bytes.');

  const duplicate = await request(upload, { method: 'POST', headers: uploadHeaders, body: bytes });
  if (duplicate.ok) throw new Error('Storage smoke duplicate create unexpectedly succeeded.');
  if (duplicate.status !== 412) throw new Error(`Storage smoke duplicate create failed with ${duplicate.status}, not precondition 412.`);

  const media = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`);
  media.searchParams.set('alt', 'media');
  media.searchParams.set('generation', created.generation);
  for (const [name] of identities) {
    const response = await request(media, {
      headers: { authorization: `Bearer ${tokenByName.get(name)}` },
    });
    if (!response.ok) throw new Error(`${name} exact-generation read failed (${response.status}).`);
    const returned = new Uint8Array(await response.arrayBuffer());
    if (digest(returned) !== sha256 || returned.byteLength !== bytes.byteLength) {
      throw new Error(`${name} read returned different bytes.`);
    }
  }

  return {
    bucket,
    objectName,
    generation: created.generation,
    size: bytes.byteLength,
    sha256,
    readers: identities.map(([name]) => name),
  };
}

function impersonatedAccessToken(identity) {
  return execFileSync('gcloud', [
    'auth', 'print-access-token',
    `--impersonate-service-account=${identity}`,
    `--project=${project}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

export async function main(args = process.argv.slice(2)) {
  validateStorageSmokeArguments(args);
  const bytes = new TextEncoder().encode(JSON.stringify({
    purpose: 'natcut-pinned-generation-smoke',
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  }) + '\n');
  const sha256 = digest(bytes);
  const result = await runStorageSmoke({
    bytes,
    objectName: `smoke/v1/${sha256}`,
    accessToken: impersonatedAccessToken,
  });
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
