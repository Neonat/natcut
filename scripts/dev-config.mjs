import { createServer, isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

const LOOPBACK = '127.0.0.1';
const ALL_IPV4 = '0.0.0.0';
const PROJECT = 'demo-natcut';
const PORTS = { visitor: 4174, submission: 8088, auth: 9099, firestore: 8080, control: 8090 };

function isPrivateIPv4(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function privateAddresses(interfaces) {
  return Object.values(interfaces).flatMap((entries) => (entries ?? [])
    .filter(({ address, family, internal }) => family === 'IPv4' && !internal && isPrivateIPv4(address))
    .map(({ address }) => address));
}

export function selectLanAddress(interfaces, override) {
  const addresses = privateAddresses(interfaces);
  if (override !== undefined) {
    if (!addresses.includes(override)) {
      throw new Error('NATCUT_LAN_IP must be a private IPv4 address assigned to a local network interface.');
    }
    return override;
  }
  addresses.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  if (addresses.length === 0) {
    throw new Error('No private IPv4 address is available. Connect to the rehearsal network and restart NatCut.');
  }
  return addresses[0];
}

export function buildDevConfig({ lan = false, env = process.env, interfaces = networkInterfaces() } = {}) {
  if ((env.NATCUT_PROJECT_ID ?? PROJECT) !== PROJECT) {
    throw new Error('NatCut local development is locked to Firebase project demo-natcut.');
  }
  if (env.NATCUT_DATABASE_ID !== undefined) {
    throw new Error('Local development must not set NATCUT_DATABASE_ID.');
  }
  const address = lan ? selectLanAddress(interfaces, env.NATCUT_LAN_IP) : LOOPBACK;
  const publicHost = lan ? ALL_IPV4 : LOOPBACK;
  const visitorOrigin = `http://${address}:${PORTS.visitor}`;
  return {
    address,
    visitorOrigin,
    firebaseConfig: lan ? 'firebase.lan.json' : 'firebase.emulators.json',
    listeners: [
      { host: publicHost, port: PORTS.visitor },
      { host: publicHost, port: PORTS.submission },
      { host: publicHost, port: PORTS.auth },
      { host: LOOPBACK, port: PORTS.firestore },
      { host: LOOPBACK, port: PORTS.control },
    ],
    runtimeEnv: {
      NATCUT_PROJECT_ID: PROJECT,
      NATCUT_SUBMISSION_HOST: publicHost,
      NATCUT_VISITOR_ORIGIN: visitorOrigin,
      FIRESTORE_EMULATOR_HOST: `${LOOPBACK}:${PORTS.firestore}`,
      FIREBASE_AUTH_EMULATOR_HOST: `${LOOPBACK}:${PORTS.auth}`,
    },
    visitorEnv: {
      VITE_NATCUT_SUBMISSION_API_URL: `http://${address}:${PORTS.submission}`,
      VITE_NATCUT_FIREBASE_PROJECT_ID: PROJECT,
      VITE_NATCUT_FIREBASE_API_KEY: 'demo-key',
      VITE_NATCUT_FIREBASE_AUTH_DOMAIN: 'demo-natcut.firebaseapp.com',
      VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL: `http://${address}:${PORTS.auth}`,
    },
  };
}

export function readSubmissionListener(env, interfaces = networkInterfaces()) {
  const host = env.NATCUT_SUBMISSION_HOST ?? LOOPBACK;
  if (host !== LOOPBACK && host !== ALL_IPV4) {
    throw new Error('NATCUT_SUBMISSION_HOST must be 127.0.0.1 or 0.0.0.0.');
  }
  const loopbackOrigin = `http://${LOOPBACK}:${PORTS.visitor}`;
  const corsOrigin = env.NATCUT_VISITOR_ORIGIN ?? loopbackOrigin;
  const allowedOrigins = host === LOOPBACK
    ? [loopbackOrigin]
    : privateAddresses(interfaces).map((address) => `http://${address}:${PORTS.visitor}`);
  if (!allowedOrigins.includes(corsOrigin)) {
    throw new Error('The visitor origin must match a local IPv4 address on port 4174 in the selected listener mode.');
  }
  return { host, corsOrigin };
}

export async function assertPortAvailable({ host, port }) {
  // On macOS, a wildcard socket can coexist with an address-specific listener.
  const hosts = host === ALL_IPV4
    ? [host, ...Object.values(networkInterfaces()).flatMap((entries) => (entries ?? [])
      .filter(({ family }) => family === 'IPv4')
      .map(({ address }) => address))]
    : [host];
  for (const address of new Set(hosts)) await probePort(address, port);
}

async function probePort(host, port) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use on ${host}. Stop the other listener and retry.`)
        : error);
    });
    server.listen({ host, port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
