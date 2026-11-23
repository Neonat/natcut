import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')),
);

test('production Firebase config cannot target Firestore or an implicit project', async () => {
  const production = JSON.parse(await readFile(path.join(repoRoot, 'firebase.json'), 'utf8'));
  const emulators = JSON.parse(await readFile(path.join(repoRoot, 'firebase.emulators.json'), 'utf8'));
  assert.equal(production.firestore, undefined);
  assert.ok(emulators.firestore);
  await assert.rejects(
    execFileAsync('firebase', ['use', '--json'], { cwd: repoRoot }),
    (error) => {
      const selection = JSON.parse(String(error.stdout));
      assert.equal(selection.status, 'error');
      assert.match(selection.error, /active project|project.*required|No project/i);
      return true;
    },
  );
});

test('Hosting deploy wrapper rejects every additional argument', async () => {
  const { validateDeployArguments } = await import('../scripts/deploy-hosting.mjs');
  assert.throws(() => validateDeployArguments(['--only', 'firestore']), /does not accept arguments/);
  assert.doesNotThrow(() => validateDeployArguments([]));
});

test('production Hosting build fails without config and excludes unrelated Vite variables', async () => {
  await assert.rejects(
    execFileAsync('npm', ['run', 'build:hosting', '--silent'], {
      cwd: repoRoot,
      env: cleanEnvironment,
    }),
    (error) => {
      assert.match(`${error.stdout}\n${error.stderr}`, /Firebase web configuration|VITE_NATCUT_FIREBASE/);
      return true;
    },
  );

  await execFileAsync('npm', ['run', 'build:hosting', '--silent'], {
    cwd: repoRoot,
    env: {
      ...cleanEnvironment,
      VITE_NATCUT_FIREBASE_PROJECT_ID: 'sprout-dev-66f08',
      VITE_NATCUT_FIREBASE_API_KEY: 'public-test-key',
      VITE_NATCUT_FIREBASE_AUTH_DOMAIN: 'sprout-dev-66f08.firebaseapp.com',
      VITE_NATCUT_FIREBASE_APP_ID: '1:485412794128:web:natcut-test',
      VITE_UNRELATED_CANARY: 'must-not-ship-in-natcut',
    },
  });
  const assets = await readdir(path.join(repoRoot, 'apps/visitor/dist/assets'));
  const javascript = await Promise.all(
    assets.filter((name) => name.endsWith('.js')).map((name) => readFile(path.join(repoRoot, 'apps/visitor/dist/assets', name), 'utf8')),
  );
  assert.ok(javascript.some((contents) => contents.includes('sprout-dev-66f08')));
  assert.ok(javascript.every((contents) => !contents.includes('must-not-ship-in-natcut')));
});

test('local runtime rejects production selection before opening a database', async () => {
  await assert.rejects(
    execFileAsync('npx', ['tsx', 'scripts/dev-runtime.ts'], {
      cwd: repoRoot,
      timeout: 3_000,
      env: {
        ...process.env,
        NATCUT_PROJECT_ID: 'sprout-dev-66f08',
        NATCUT_DATABASE_ID: 'natcut',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      },
    }),
    (error) => {
      assert.match(String(error.stderr), /Local runtime requires NATCUT_PROJECT_ID=demo-natcut/);
      return true;
    },
  );
});

test('Cloud Build upload excludes credential-shaped local files', async () => {
  const canaries = [
    path.join(repoRoot, '.env.production'),
    path.join(repoRoot, 'application_default_credentials.json'),
  ];
  try {
    await Promise.all(canaries.map((file) => writeFile(file, '{"synthetic":"credential-canary"}\n')));
    const { stdout } = await execFileAsync('gcloud', ['meta', 'list-files-for-upload'], { cwd: repoRoot });
    assert.match(stdout, /cloudbuild\.submission\.yaml/);
    assert.doesNotMatch(stdout, /\.env\.production/);
    assert.doesNotMatch(stdout, /application_default_credentials\.json/);
  } finally {
    await Promise.all(canaries.map((file) => rm(file, { force: true })));
  }
});
