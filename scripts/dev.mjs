import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const projectId = process.env.NATCUT_PROJECT_ID ?? 'demo-natcut';
if (projectId !== 'demo-natcut') {
  console.error('NatCut local development is locked to Firebase project demo-natcut.');
  process.exit(2);
}

const javaHome = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
const stateDirectory = mkdtempSync(path.join(tmpdir(), 'natcut-dev-'));
const children = new Set();
let stopping = false;

function launch(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    detached: true,
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${command} exited unexpectedly (${signal ?? code ?? 'unknown'}).`);
      stop(code ?? 1);
    }
  });
  return child;
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Timed out waiting for port ${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
  setTimeout(() => process.exit(code), 1_500);
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

async function start() {
  launch('npx', ['firebase', 'emulators:start', '--project', projectId, '--only', 'auth,firestore'], {
    JAVA_HOME: javaHome,
    PATH: `${javaHome}/bin:${process.env.PATH ?? ''}`,
  });
  await Promise.all([waitForPort(8080), waitForPort(9099)]);

  const sharedEnv = {
    NATCUT_PROJECT_ID: projectId,
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    NATCUT_SQLITE_PATH: path.join(stateDirectory, 'worker.sqlite'),
  };
  launch('npx', ['tsx', 'scripts/dev-runtime.ts'], sharedEnv);
  await Promise.all([waitForPort(8088), waitForPort(8090)]);

  launch('npm', ['run', 'dev', '--workspace', '@natcut/visitor', '--', '--host', '127.0.0.1', '--port', '4174'], {
    ...sharedEnv,
    VITE_SUBMISSION_API_URL: 'http://127.0.0.1:8088',
    VITE_FIREBASE_PROJECT_ID: projectId,
    VITE_FIREBASE_API_KEY: 'demo-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'demo-natcut.firebaseapp.com',
    VITE_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099',
  });
  await waitForPort(4174);
  console.log('NatCut visitor: http://127.0.0.1:4174');
  console.log('Submission API: http://127.0.0.1:8088');
  console.log('Simulated worker control: http://127.0.0.1:8090');
  setInterval(() => undefined, 60_000);
}

start().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  stop(1);
});
