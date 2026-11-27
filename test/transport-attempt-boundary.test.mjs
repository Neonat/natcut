import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const transportModule = 'packages/printer/src/transport-attempt.ts';

function bundleGraph(entryPoints, external) {
  return build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints,
    external,
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: 'esbuild-boundary',
    write: false,
    metafile: true,
  }).then((result) => result.metafile);
}

test('transport attempt import graph contains only the approved offline dependencies', async () => {
  const { inputs } = await bundleGraph([transportModule], ['better-sqlite3', 'zod']);
  const allowedInputs = new Set([
    transportModule,
    'node_modules/@noble/hashes/_md.js',
    'node_modules/@noble/hashes/_u64.js',
    'node_modules/@noble/hashes/sha2.js',
    'node_modules/@noble/hashes/utils.js',
    'packages/printer/src/protocol-plan.ts',
    'packages/printer/src/prepared-evidence.ts',
    'packages/artifacts/src/reader.ts',
    'packages/domain/src/index.ts',
    'packages/domain/src/canonical-hash.ts',
    'packages/domain/src/geometry.ts',
    'packages/domain/src/manifest.ts',
    'packages/domain/src/print-artifact.ts',
    'packages/domain/src/print-profile.ts',
    'packages/domain/src/sha256.ts',
    'packages/domain/src/state-machine.ts',
    'packages/domain/src/submission.ts',
    'vendor/pixcut-trace/plt.ts',
    'vendor/pixcut-trace/units.ts',
  ]);
  const allowedExternals = new Set(['node:crypto', 'node:path', 'node:util', 'better-sqlite3', 'zod']);
  const externalPaths = Object.values(inputs).flatMap(({ imports }) =>
    imports.filter((entry) => entry.external).map((entry) => entry.path),
  );
  assert.deepEqual(Object.keys(inputs).filter((path) => !allowedInputs.has(path)), []);
  assert.deepEqual([...new Set(externalPaths)].filter((path) => !allowedExternals.has(path)), []);
});

test('the worker and non-physical printer entry points do not import the transport attempt', async () => {
  const { inputs } = await bundleGraph([
    'apps/worker/src/index.ts',
    'scripts/cloud-worker.ts',
    'scripts/cloud-worker-smoke.ts',
    'scripts/dev-runtime.ts',
    'scripts/dev.mjs',
    'scripts/physical-dry-run.ts',
    'scripts/proof-sheet.ts',
    'bin/status.mjs',
  ], ['@fastify/cors', 'better-sqlite3', 'fastify', 'firebase', 'firebase-admin', 'qrcode-terminal', 'sharp', 'usb', 'vite', 'zod']);

  assert.equal(Object.hasOwn(inputs, transportModule), false);
});

test('the local operator server reaches transport mutation only through the physical-proof runtime', async () => {
  const { inputs } = await bundleGraph([
    'src/server.mjs',
  ], ['better-sqlite3', 'sharp', 'usb', 'zod']);

  assert.equal(Object.hasOwn(inputs, transportModule), true);
  assert.equal(Object.hasOwn(inputs, 'src/physical-proof-runtime.mjs'), true);
  assert.equal(Object.hasOwn(inputs, 'src/printer-mutation-port.mjs'), true);
  assert.deepEqual(Object.keys(inputs).filter((path) =>
    path.startsWith('apps/worker/') || path.includes('cloud-worker') || path.includes('simulated-printer')
  ), []);
});
