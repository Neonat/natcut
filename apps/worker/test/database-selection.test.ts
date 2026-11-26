import { describe, expect, it } from 'vitest';
import { resolveWorkerFirestoreSelection } from '../src/cloud-queue.ts';

const production = {
  NATCUT_PROJECT_ID: 'sprout-dev-66f08',
  NATCUT_DATABASE_ID: 'natcut',
};

const emulator = {
  NATCUT_PROJECT_ID: 'demo-natcut',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};

describe('worker Firestore selection', () => {
  it('selects only the named NatCut database in production', () => {
    expect(resolveWorkerFirestoreSelection(production)).toEqual({
      projectId: 'sprout-dev-66f08',
      databaseId: 'natcut',
    });
    expect(() => resolveWorkerFirestoreSelection({ NATCUT_PROJECT_ID: 'sprout-dev-66f08' })).toThrow(
      'NATCUT_DATABASE_ID=natcut',
    );
    expect(() => resolveWorkerFirestoreSelection({ ...production, NATCUT_DATABASE_ID: '(default)' })).toThrow(
      'NATCUT_DATABASE_ID=natcut',
    );
  });

  it('selects only the emulator default database for local development', () => {
    expect(resolveWorkerFirestoreSelection(emulator)).toEqual({
      projectId: 'demo-natcut',
      databaseId: undefined,
    });
    expect(() => resolveWorkerFirestoreSelection({ ...emulator, NATCUT_DATABASE_ID: 'natcut' })).toThrow(
      'must not set NATCUT_DATABASE_ID',
    );
    expect(() => resolveWorkerFirestoreSelection({ NATCUT_PROJECT_ID: 'demo-natcut' })).toThrow(
      'FIRESTORE_EMULATOR_HOST',
    );
  });

  it('rejects production credentials pointed at an emulator', () => {
    expect(() => resolveWorkerFirestoreSelection({
      ...production,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    })).toThrow('must not use FIRESTORE_EMULATOR_HOST');
  });
});
