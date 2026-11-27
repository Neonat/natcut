import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readCloudWorkerConfig, runWorkerPollingLoop } from '../src/cloud-worker-runtime.ts';

const validEnvironment = {
  NATCUT_PROJECT_ID: 'sprout-dev-66f08',
  NATCUT_DATABASE_ID: 'natcut',
  NATCUT_ARTIFACT_BUCKET: 'sprout-dev-66f08-natcut-artifacts',
  NATCUT_SQLITE_PATH: path.join(path.sep, 'tmp', 'natcut-worker.sqlite'),
  NATCUT_WORKER_ID: 'devfest-macbook',
};

describe('cloud worker configuration', () => {
  it('accepts only the production project, named database, and durable journal', () => {
    expect(readCloudWorkerConfig(validEnvironment)).toEqual({
      projectId: 'sprout-dev-66f08',
      databaseId: 'natcut',
      artifactBucket: 'sprout-dev-66f08-natcut-artifacts',
      sqlitePath: path.join(path.sep, 'tmp', 'natcut-worker.sqlite'),
      workerId: 'devfest-macbook',
      pollIntervalMs: 2_000,
      simulationPhaseDelayMs: 260,
    });
  });

  it('rejects the emulator project and a missing named database', () => {
    expect(() => readCloudWorkerConfig({
      ...validEnvironment,
      NATCUT_PROJECT_ID: 'demo-natcut',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      NATCUT_DATABASE_ID: undefined,
    })).toThrow('Production requires NATCUT_PROJECT_ID=sprout-dev-66f08');
    expect(() => readCloudWorkerConfig({ ...validEnvironment, NATCUT_DATABASE_ID: undefined })).toThrow(
      'NATCUT_DATABASE_ID=natcut',
    );
  });

  it('rejects in-memory and relative SQLite paths', () => {
    expect(() => readCloudWorkerConfig({ ...validEnvironment, NATCUT_SQLITE_PATH: ':memory:' })).toThrow(
      'durable absolute path',
    );
    expect(() => readCloudWorkerConfig({ ...validEnvironment, NATCUT_SQLITE_PATH: 'natcut.sqlite' })).toThrow(
      'durable absolute path',
    );
  });

  it('requires the isolated bucket and rejects storage emulator overrides', () => {
    for (const NATCUT_ARTIFACT_BUCKET of [undefined, 'other-bucket', 'gs://sprout-dev-66f08-natcut-artifacts']) {
      expect(() => readCloudWorkerConfig({ ...validEnvironment, NATCUT_ARTIFACT_BUCKET })).toThrow('NATCUT_ARTIFACT_BUCKET');
    }
    for (const key of ['STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) {
      expect(() => readCloudWorkerConfig({ ...validEnvironment, [key]: 'localhost' })).toThrow(key);
    }
  });

  it('bounds polling and simulation delays', () => {
    expect(() => readCloudWorkerConfig({ ...validEnvironment, NATCUT_POLL_INTERVAL_MS: '100' })).toThrow(
      'NATCUT_POLL_INTERVAL_MS',
    );
    expect(() => readCloudWorkerConfig({ ...validEnvironment, NATCUT_SIMULATION_PHASE_DELAY_MS: '60000' })).toThrow(
      'NATCUT_SIMULATION_PHASE_DELAY_MS',
    );
  });
});

describe('cloud worker polling loop', () => {
  it('runs one queue attempt at a time until aborted', async () => {
    const controller = new AbortController();
    let active = 0;
    let maximumActive = 0;
    const runOnce = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      if (runOnce.mock.calls.length === 3) controller.abort();
      return { kind: 'idle' as const };
    });

    await runWorkerPollingLoop({
      signal: controller.signal,
      intervalMs: 500,
      runOnce,
      sleep: async () => undefined,
    });

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(1);
  });
});
