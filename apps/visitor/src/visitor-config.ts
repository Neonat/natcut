import type { FirebaseOptions } from 'firebase/app';

type VisitorEnvironment = Record<string, string | undefined>;

export type VisitorConfig = {
  firebase: FirebaseOptions;
  submissionApiUrl: string;
  authEmulatorUrl: string | undefined;
};

export function readEmulatorVisitorConfig(environment: VisitorEnvironment): VisitorConfig {
  const projectId = environment.VITE_NATCUT_FIREBASE_PROJECT_ID ?? 'demo-natcut';
  if (projectId !== 'demo-natcut') throw new Error('Local visitor configuration requires demo-natcut.');
  return {
    firebase: {
      apiKey: environment.VITE_NATCUT_FIREBASE_API_KEY ?? 'demo-key',
      authDomain: environment.VITE_NATCUT_FIREBASE_AUTH_DOMAIN ?? 'demo-natcut.firebaseapp.com',
      projectId,
    },
    submissionApiUrl: environment.VITE_NATCUT_SUBMISSION_API_URL ?? 'http://127.0.0.1:8088',
    authEmulatorUrl: environment.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL ?? 'http://127.0.0.1:9099',
  };
}

export function readProductionVisitorConfig(environment: VisitorEnvironment): VisitorConfig {
  const projectId = environment.VITE_NATCUT_FIREBASE_PROJECT_ID;
  if (projectId !== 'sprout-dev-66f08') {
    throw new Error('Production requires VITE_NATCUT_FIREBASE_PROJECT_ID=sprout-dev-66f08.');
  }
  const apiKey = environment.VITE_NATCUT_FIREBASE_API_KEY;
  const authDomain = environment.VITE_NATCUT_FIREBASE_AUTH_DOMAIN;
  const appId = environment.VITE_NATCUT_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !appId) {
    throw new Error('Production requires the complete public Firebase web configuration.');
  }
  if (environment.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL !== undefined) {
    throw new Error('Production must not use the Auth emulator.');
  }
  const submissionApiUrl = environment.VITE_NATCUT_SUBMISSION_API_URL ?? '/api';
  if (submissionApiUrl !== '/api') {
    throw new Error('Production must use the same-origin /api endpoint.');
  }
  return {
    firebase: { apiKey, authDomain, projectId, appId },
    submissionApiUrl,
    authEmulatorUrl: undefined,
  };
}

export function readVisitorConfig(environment: VisitorEnvironment): VisitorConfig {
  const projectId = environment.VITE_NATCUT_FIREBASE_PROJECT_ID ?? 'demo-natcut';
  if (projectId === 'demo-natcut') return readEmulatorVisitorConfig(environment);
  if (projectId === 'sprout-dev-66f08') return readProductionVisitorConfig(environment);
  throw new Error('VITE_NATCUT_FIREBASE_PROJECT_ID must be demo-natcut or sprout-dev-66f08.');
}
