import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('cloud worker entrypoint reaches its production boundary before creating a journal', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'natcut-worker-entrypoint-'));
  const sqlitePath = path.join(temporaryDirectory, 'worker.sqlite');
  try {
    await assert.rejects(
      execFileAsync('npm', ['run', 'worker:cloud:sim', '--silent'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          NATCUT_PROJECT_ID: 'demo-natcut',
          FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
          NATCUT_SQLITE_PATH: sqlitePath,
          NATCUT_WORKER_ID: 'test-worker',
        },
      }),
      (error) => {
        assert.match(String(error.stderr), /Production requires NATCUT_PROJECT_ID=sprout-dev-66f08/);
        assert.doesNotMatch(String(error.stderr), /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
        return true;
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
