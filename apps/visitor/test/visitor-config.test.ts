import { describe, expect, it } from 'vitest';
import { readVisitorConfig } from '../src/visitor-config.ts';

describe('visitor runtime configuration', () => {
  it('uses only local emulator defaults for the demo project', () => {
    expect(readVisitorConfig({})).toEqual({
      firebase: {
        apiKey: 'demo-key',
        authDomain: 'demo-natcut.firebaseapp.com',
        projectId: 'demo-natcut',
      },
      submissionApiUrl: 'http://127.0.0.1:8088',
      authEmulatorUrl: 'http://127.0.0.1:9099',
    });
  });

  it('uses the public NatCut web-app config and same-origin API in production', () => {
    expect(readVisitorConfig({
      VITE_NATCUT_FIREBASE_PROJECT_ID: 'sprout-dev-66f08',
      VITE_NATCUT_FIREBASE_API_KEY: 'public-web-api-key',
      VITE_NATCUT_FIREBASE_AUTH_DOMAIN: 'sprout-dev-66f08.firebaseapp.com',
      VITE_NATCUT_FIREBASE_APP_ID: '1:485412794128:web:natcut',
    })).toEqual({
      firebase: {
        apiKey: 'public-web-api-key',
        authDomain: 'sprout-dev-66f08.firebaseapp.com',
        projectId: 'sprout-dev-66f08',
        appId: '1:485412794128:web:natcut',
      },
      submissionApiUrl: '/api',
      authEmulatorUrl: undefined,
    });
  });

  it('rejects incomplete production config, emulator URLs, and a cross-origin API', () => {
    const production = {
      VITE_NATCUT_FIREBASE_PROJECT_ID: 'sprout-dev-66f08',
      VITE_NATCUT_FIREBASE_API_KEY: 'public-web-api-key',
      VITE_NATCUT_FIREBASE_AUTH_DOMAIN: 'sprout-dev-66f08.firebaseapp.com',
      VITE_NATCUT_FIREBASE_APP_ID: '1:485412794128:web:natcut',
    };
    expect(() => readVisitorConfig({ VITE_NATCUT_FIREBASE_PROJECT_ID: 'sprout-dev-66f08' })).toThrow(
      'Firebase web configuration',
    );
    expect(() => readVisitorConfig({
      ...production,
      VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099',
    })).toThrow('must not use the Auth emulator');
    expect(() => readVisitorConfig({
      ...production,
      VITE_NATCUT_SUBMISSION_API_URL: 'https://example.com',
    })).toThrow('same-origin /api');
  });

  it('rejects any project other than the emulator or owned Sprout project', () => {
    expect(() => readVisitorConfig({ VITE_NATCUT_FIREBASE_PROJECT_ID: 'someone-else' })).toThrow(
      'demo-natcut or sprout-dev-66f08',
    );
  });
});
