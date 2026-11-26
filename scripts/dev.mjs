import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { assertPortAvailable, buildDevConfig } from './dev-config.mjs';

async function start() {
  const args = process.argv.slice(2);
  const lan = args.length === 1 && args[0] === '--lan';
  if (args.length && !lan) throw new Error('Usage: node scripts/dev.mjs [--lan]');

  const config = buildDevConfig({ lan });
  await Promise.all(config.listeners.map(assertPortAvailable));

  const javaHome = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  const firebase = fileURLToPath(import.meta.resolve('firebase-tools/lib/bin/firebase.js'));
  const serve = lan ? 'node scripts/dev-serve.mjs --lan' : 'node scripts/dev-serve.mjs';
  const childEnv = {
    PATH: `${javaHome}/bin:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    JAVA_HOME: javaHome,
    NODE_ENV: 'development',
    NO_UPDATE_NOTIFIER: '1',
    FIREBASE_CLI_DISABLE_TELEMETRY: '1',
    ...config.runtimeEnv,
    ...(lan ? { NATCUT_LAN_IP: config.address } : {}),
    ...(!lan && process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS === 'natcut-rehearsal.test'
      ? { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'natcut-rehearsal.test' }
      : {}),
  };
  const emulators = spawn(process.execPath, [
    firebase, 'emulators:exec',
    '--config', config.firebaseConfig,
    '--project', config.runtimeEnv.NATCUT_PROJECT_ID,
    '--only', 'auth,firestore',
    serve,
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: childEnv,
  });

  let stopped = false;
  let shutdownTimer;
  const signalGroup = (signal) => {
    if (process.platform === 'win32') return emulators.kill(signal);
    try {
      process.kill(-emulators.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    if (stopped || !emulators.pid) return;
    stopped = true;
    signalGroup('SIGTERM');
    shutdownTimer = setTimeout(() => signalGroup('SIGKILL'), 4_000);
    shutdownTimer.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const [code] = await once(emulators, 'exit');
    process.exitCode = stopped ? 0 : code || 1;
  } finally {
    clearTimeout(shutdownTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

start().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
});
