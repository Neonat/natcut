import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  assertPortAvailable,
  buildDevConfig,
  readSubmissionListener,
  selectLanAddress,
} from '../scripts/dev-config.mjs';

const interfaces = {
  en1: [{ address: '192.168.1.12', family: 'IPv4', internal: false }],
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [
    { address: 'fe80::1', family: 'IPv6', internal: false },
    { address: '169.254.5.2', family: 'IPv4', internal: false },
    { address: '10.4.5.20', family: 'IPv4', internal: false },
    { address: '10.4.5.3', family: 'IPv4', internal: false },
  ],
};

test('LAN selection is independent of interface order', () => {
  const reversed = Object.fromEntries(Object.entries(interfaces).reverse());
  assert.equal(selectLanAddress(interfaces), '10.4.5.3');
  assert.equal(selectLanAddress(reversed), '10.4.5.3');
});

test('LAN selection requires an external RFC 1918 IPv4 address', () => {
  assert.throws(() => selectLanAddress({
    lo0: interfaces.lo0,
    en0: [
      { address: '172.32.0.1', family: 'IPv4', internal: false },
      { address: '169.254.9.7', family: 'IPv4', internal: false },
      { address: '192.168.7.4', family: 'IPv4', internal: true },
      { address: 'fd00::2', family: 'IPv6', internal: false },
    ],
  }), /no private IPv4/i);
  assert.equal(selectLanAddress({
    en0: [{ address: '172.31.0.1', family: 'IPv4', internal: false }],
  }), '172.31.0.1');
});

test('LAN overrides select only an assigned eligible address', () => {
  assert.equal(selectLanAddress(interfaces, '192.168.1.12'), '192.168.1.12');
  for (const override of ['10.4.5.4', '127.0.0.1', '169.254.5.2', '0.0.0.0', '192.168.1.12:4174', '']) {
    assert.throws(() => selectLanAddress(interfaces, override), /NATCUT_LAN_IP/);
  }
});

test('development rejects project or database settings before startup', () => {
  assert.throws(() => buildDevConfig({ env: { NATCUT_PROJECT_ID: 'sprout-dev-66f08' } }), /demo-natcut/);
  assert.throws(() => buildDevConfig({ env: { NATCUT_DATABASE_ID: 'natcut' } }), /NATCUT_DATABASE_ID/);
});

test('loopback development has no LAN listeners', () => {
  const config = buildDevConfig({ env: { NATCUT_LAN_IP: '192.168.1.12' }, interfaces: {} });
  assert.equal(config.visitorOrigin, 'http://127.0.0.1:4174');
  assert.equal(config.visitorEnv.VITE_NATCUT_SUBMISSION_API_URL, 'http://127.0.0.1:8088');
  assert.equal(config.visitorEnv.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL, 'http://127.0.0.1:9099');
  assert.ok(config.listeners.every(({ host }) => host === '127.0.0.1'));
  assert.equal(config.firebaseConfig, 'firebase.emulators.json');
});

test('LAN endpoints share one address and preserve the private listeners', () => {
  const config = buildDevConfig({ lan: true, env: { NATCUT_LAN_IP: '192.168.1.12' }, interfaces });
  assert.equal(config.visitorOrigin, 'http://192.168.1.12:4174');
  assert.equal(config.visitorEnv.VITE_NATCUT_SUBMISSION_API_URL, 'http://192.168.1.12:8088');
  assert.equal(config.visitorEnv.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL, 'http://192.168.1.12:9099');
  assert.equal(config.visitorEnv.VITE_NATCUT_FIREBASE_PROJECT_ID, 'demo-natcut');
  assert.equal(config.runtimeEnv.NATCUT_VISITOR_ORIGIN, config.visitorOrigin);
  assert.equal(config.runtimeEnv.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
  assert.equal(config.runtimeEnv.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
  assert.equal(config.firebaseConfig, 'firebase.lan.json');
  assert.deepEqual(config.listeners.map(({ host, port }) => [host, port]), [
    ['0.0.0.0', 4174],
    ['0.0.0.0', 8088],
    ['0.0.0.0', 9099],
    ['127.0.0.1', 8080],
    ['127.0.0.1', 8090],
  ]);
});

test('runtime accepts only the configured local visitor origin for its listener', () => {
  assert.deepEqual(readSubmissionListener({}, interfaces), {
    host: '127.0.0.1',
    corsOrigin: 'http://127.0.0.1:4174',
  });
  const env = { NATCUT_SUBMISSION_HOST: '0.0.0.0', NATCUT_VISITOR_ORIGIN: 'http://192.168.1.12:4174' };
  assert.deepEqual(readSubmissionListener(env, interfaces), {
    host: '0.0.0.0',
    corsOrigin: 'http://192.168.1.12:4174',
  });
  for (const origin of ['*', 'http://192.168.1.13:4174', 'http://127.0.0.1:4174', 'http://192.168.1.12:4174/']) {
    assert.throws(() => readSubmissionListener({ ...env, NATCUT_VISITOR_ORIGIN: origin }, interfaces), /visitor origin/i);
  }
  assert.throws(() => readSubmissionListener({ ...env, NATCUT_SUBMISSION_HOST: '::' }, interfaces), /NATCUT_SUBMISSION_HOST/);
});

test('port preflight rejects another listener even when the service could answer', async (t) => {
  const existing = createServer();
  await new Promise((resolve) => existing.listen(0, '127.0.0.1', resolve));
  t.after(() => existing.close());
  const { port } = existing.address();
  await assert.rejects(assertPortAvailable({ host: '0.0.0.0', port }), new RegExp(`port ${port}.*already in use`, 'i'));
});
