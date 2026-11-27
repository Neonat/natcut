import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qr from 'qrcode-terminal';
import { createServer } from 'vite';
import { buildDevConfig } from './dev-config.mjs';

async function requireResponse(url, options = {}) {
  const reply = await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
  if (!reply.ok) {
    await reply.body?.cancel();
    throw new Error(`Development service at ${url} responded with ${reply.status}.`);
  }
  return reply;
}

async function serve() {
  const lan = process.argv[2] === '--lan';
  const config = buildDevConfig({ lan });
  Object.assign(process.env, config.visitorEnv);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), 'natcut-dev-'));
  const runtime = fork(new URL('./dev-runtime.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      ...config.runtimeEnv,
      NATCUT_SQLITE_PATH: path.join(stateDirectory, 'worker.sqlite'),
    },
  });

  const runtimeExit = once(runtime, 'exit');
  const stop = () => { runtime.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let vite;
  try {
    const [message] = await Promise.race([
      once(runtime, 'message', { signal: AbortSignal.timeout(60_000) }),
      runtimeExit.then(([code, signal]) => { throw new Error(`Simulated runtime exited during startup (${signal ?? code}).`); }),
    ]);
    if (message !== 'natcut-runtime-ready') throw new Error('Unexpected simulated runtime readiness message.');

    const api = config.visitorEnv.VITE_NATCUT_SUBMISSION_API_URL;
    const auth = config.visitorEnv.VITE_NATCUT_FIREBASE_AUTH_EMULATOR_URL;
    const [submissionHealth, authConfig] = await Promise.all([
      requireResponse(`${api}/health`, { headers: { origin: config.visitorOrigin } }),
      requireResponse(`${auth}/emulator/v1/projects/demo-natcut/config`),
    ]);
    if (submissionHealth.headers.get('access-control-allow-origin') !== config.visitorOrigin ||
        (await submissionHealth.json()).ok !== true) {
      throw new Error('Submission API health or visitor origin did not match the development stack.');
    }
    await authConfig.body?.cancel();

    const [visitor] = config.listeners;
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const visitorRoot = path.join(repoRoot, 'apps/visitor');
    vite = await createServer({
      root: visitorRoot,
      server: {
        ...visitor,
        strictPort: true,
        fs: {
          strict: true,
          allow: [
            visitorRoot,
            path.join(repoRoot, 'packages/domain'),
            path.join(repoRoot, 'packages/render'),
            path.join(repoRoot, 'packages/cut-geometry'),
            path.join(repoRoot, 'vendor/pixcut-trace'),
            path.join(repoRoot, 'node_modules'),
          ],
          deny: [
            '**/.env*',
            '**/.git/**',
            '**/.npmrc',
            '**/.yarnrc.yml',
            '**/*.{crt,pem,key,p12,pfx,cer,der}',
            '**/*-debug.log',
            '**/firebase-debug.log',
          ],
        },
      },
    });
    await vite.listen();
    const visitorPage = await requireResponse(config.visitorOrigin);
    if (!(await visitorPage.text()).includes('/src/main.tsx')) {
      throw new Error('Visitor listener did not serve the NatCut application.');
    }
    if (runtime.exitCode !== null || runtime.signalCode !== null) {
      throw new Error('Simulated runtime exited before the visitor was ready.');
    }

    console.log(`NatCut visitor (simulation): ${config.visitorOrigin}`);
    if (lan) qr.generate(config.visitorOrigin, { small: true });
    console.log(`Submission API: ${api}`);
    console.log('Simulated worker control: http://127.0.0.1:8090');

    const [code, signal] = await runtimeExit;
    if (code || signal) throw new Error(`Simulated runtime exited (${signal ?? code}).`);
  } finally {
    stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await vite?.close();
    await runtimeExit.catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

serve().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
});
