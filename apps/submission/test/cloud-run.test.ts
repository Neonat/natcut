import { describe, expect, it } from 'vitest';
import { readCloudRunConfig } from '../src/cloud-run.ts';

const validEnvironment = {
  NATCUT_PROJECT_ID: 'sprout-dev-66f08',
  NATCUT_DATABASE_ID: 'natcut',
  NATCUT_ARTIFACT_BUCKET: 'sprout-dev-66f08-natcut-artifacts',
  NATCUT_STATUS_TOKEN_SECRET: 'a-status-token-secret-with-32-bytes',
  PORT: '8080',
};

describe('Cloud Run configuration', () => {
  it('accepts only the isolated NatCut production resources', () => {
    expect(readCloudRunConfig(validEnvironment)).toEqual({
      projectId: 'sprout-dev-66f08',
      databaseId: 'natcut',
      artifactBucket: 'sprout-dev-66f08-natcut-artifacts',
      statusTokenSecret: 'a-status-token-secret-with-32-bytes',
      port: 8080,
      host: '0.0.0.0',
    });
  });

  it('requires the dedicated bucket and rejects storage emulator redirection', () => {
    for (const bucket of [undefined, '', 'sprout-dev-66f08.appspot.com', 'gs://sprout-dev-66f08-natcut-artifacts']) {
      expect(() => readCloudRunConfig({ ...validEnvironment, NATCUT_ARTIFACT_BUCKET: bucket })).toThrow('NATCUT_ARTIFACT_BUCKET');
    }
    for (const name of ['FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST']) {
      expect(() => readCloudRunConfig({ ...validEnvironment, [name]: 'localhost:9199' })).toThrow(name);
    }
  });

  it('rejects a missing secret or invalid Cloud Run port', () => {
    expect(() => readCloudRunConfig({ ...validEnvironment, NATCUT_STATUS_TOKEN_SECRET: undefined })).toThrow(
      'NATCUT_STATUS_TOKEN_SECRET',
    );
    expect(() => readCloudRunConfig({ ...validEnvironment, PORT: '0' })).toThrow('PORT');
    expect(() => readCloudRunConfig({ ...validEnvironment, PORT: 'not-a-port' })).toThrow('PORT');
  });

  it('rejects the default Firestore database and emulator variables', () => {
    expect(() => readCloudRunConfig({ ...validEnvironment, NATCUT_DATABASE_ID: '(default)' })).toThrow(
      'NATCUT_DATABASE_ID=natcut',
    );
    expect(() => readCloudRunConfig({
      ...validEnvironment,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    })).toThrow('must not use FIRESTORE_EMULATOR_HOST');
    expect(() => readCloudRunConfig({
      ...validEnvironment,
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    })).toThrow('must not use FIREBASE_AUTH_EMULATOR_HOST');
  });
});
