import { describe, expect, it } from 'vitest';
import { resolveSubmissionFirestoreSelection } from '../src/repository.ts';

const production = {
  NATCUT_PROJECT_ID: 'sprout-dev-66f08',
  NATCUT_DATABASE_ID: 'natcut',
};

const emulator = {
  NATCUT_PROJECT_ID: 'demo-natcut',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};

describe('submission Firestore selection', () => {
  const resolveSelection = resolveSubmissionFirestoreSelection;
  it('selects only the named NatCut database in production', () => {
    expect(resolveSelection(production)).toEqual({
      projectId: 'sprout-dev-66f08',
      databaseId: 'natcut',
    });
    expect(() => resolveSelection({ NATCUT_PROJECT_ID: 'sprout-dev-66f08' })).toThrow(
      'NATCUT_DATABASE_ID=natcut',
    );
    expect(() => resolveSelection({ ...production, NATCUT_DATABASE_ID: '(default)' })).toThrow(
      'NATCUT_DATABASE_ID=natcut',
    );
  });

  it('selects only the emulator default database for local development', () => {
    expect(resolveSelection(emulator)).toEqual({
      projectId: 'demo-natcut',
      databaseId: undefined,
    });
    expect(() => resolveSelection({ ...emulator, NATCUT_DATABASE_ID: 'natcut' })).toThrow(
      'must not set NATCUT_DATABASE_ID',
    );
    expect(() => resolveSelection({ NATCUT_PROJECT_ID: 'demo-natcut' })).toThrow(
      'FIRESTORE_EMULATOR_HOST',
    );
  });

  it('rejects production credentials pointed at an emulator', () => {
    expect(() => resolveSelection({ ...production, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(
      'must not use FIRESTORE_EMULATOR_HOST',
    );
  });
});
