import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const workspaces = [
  ['apps/submission', '@natcut/submission'],
  ['apps/visitor', '@natcut/visitor'],
  ['apps/worker', '@natcut/worker'],
  ['packages/artifacts', '@natcut/artifacts'],
  ['packages/domain', '@natcut/domain'],
  ['packages/pipeline', '@natcut/pipeline'],
  ['packages/printer', '@natcut/printer'],
  ['packages/render', '@natcut/render'],
  ['packages/cut-geometry', '@natcut/cut-geometry'],
];

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

test('declares the application and package workspaces', async () => {
  const manifest = await readJson('package.json');

  assert.deepEqual(manifest.workspaces, ['apps/*', 'packages/*']);
  assert.match(manifest.scripts.test, /test:legacy/);
  assert.match(manifest.scripts.test, /test:unit/);
});

for (const [directory, name] of workspaces) {
  test(`${name} is a private ESM workspace with a typed entry point`, async () => {
    const manifest = await readJson(path.join(directory, 'package.json'));

    assert.equal(manifest.name, name);
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.exports['.'], './src/index.ts');
    await access(path.join(root, directory, 'src/index.ts'));
    await access(path.join(root, directory, 'tsconfig.json'));
  });
}
