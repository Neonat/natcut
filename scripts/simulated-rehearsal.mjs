import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let child;
let stoppingSignal;

function stopChild(signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (cause.code !== 'ESRCH') throw cause;
  }
}

function forward(signal) {
  if (stoppingSignal) return;
  stoppingSignal = signal;
  stopChild(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => forward(signal));
}

async function run(args) {
  if (stoppingSignal) return;
  child = spawn(npm, args, { stdio: 'inherit', shell: false, detached: process.platform !== 'win32' });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child = undefined;
  if (result.signal) throw new Error(`Rehearsal command stopped by ${result.signal}`);
  if (result.code !== 0) throw new Error(`Rehearsal command failed with exit code ${result.code ?? 1}`);
}

try {
  await run(['run', 'test:e2e', '--', 'e2e/operator-pickup.spec.ts']);
  await run(['run', 'emulators:test', '--', '--only', 'worker']);
} catch (cause) {
  if (!stoppingSignal) console.error(cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
}

if (stoppingSignal) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeAllListeners(signal);
  process.kill(process.pid, stoppingSignal);
}
