import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '../packages/domain/src/index.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function run(...args) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/physical-dry-run.ts', ...args], {
    cwd: repoRoot, encoding: 'utf8',
  });
}

async function inputs(parent) {
  const profile = DEVFEST_SG_V1;
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
  for (let y = 200; y < 250; y++) for (let x = 200; x < 250; x++) {
    const pixel = y * profile.sheetWidthPx + x;
    rgba.set([100, 40, 220, 255], pixel * 4);
    mask[pixel] = 255;
  }
  const bundle = await encodeLogicalSourceBundle({
    colorEvidence: NATIVE_SRGB_EVIDENCE,
    width: profile.sheetWidthPx, height: profile.sheetHeightPx, profile,
    renderVersion: 'server-raster-v1', geometryVersion: 'geometry-v1', rgba, mask,
  });
  const receipt = path.join(parent, 'receipt.json');
  const bytes = path.join(parent, 'bundle.bin');
  await writeFile(receipt, `${JSON.stringify({ descriptor: bundle.descriptor, generation: '23' })}\n`);
  await writeFile(bytes, bundle.bytes);
  return { receipt, bytes };
}

test('physical:dry-run verifies file inputs and publishes one offline packet', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'natcut-physical-cli-'));
  try {
    const source = await inputs(parent);
    const out = path.join(parent, 'packet');
    const result = run('--receipt', source.receipt, '--bundle', source.bytes, '--out', out);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no printer command sent/i);
    assert.deepEqual((await readdir(out)).sort(), ['cut.plt', 'evidence.json', 'print.jpg']);

    const second = run('--receipt', source.receipt, '--bundle', source.bytes, '--out', out);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('physical:dry-run rejects malformed evidence and leaves no output', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'natcut-physical-cli-bad-'));
  try {
    const source = await inputs(parent);
    await writeFile(source.receipt, '{}');
    const out = path.join(parent, 'packet');
    const result = run('--receipt', source.receipt, '--bundle', source.bytes, '--out', out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid artifact receipt/i);
    assert.deepEqual((await readdir(parent)).sort(), ['bundle.bin', 'receipt.json']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('physical:dry-run rejects missing or additional arguments before reading inputs', () => {
  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage/i);
  const extra = run('--receipt', 'x', '--bundle', 'y', '--out', 'z', '--unknown', '1');
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /unknown|option/i);
});

test('physical:dry-run import graph excludes cloud publishers, Firebase, USB, and worker execution', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/physical-dry-run.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_DEBUG: 'esm' },
  });
  assert.notEqual(result.status, 0);
  const forbidden = result.stderr.match(/gcs-publisher\.ts|firebase-admin|node_modules\/usb|apps\/worker/g) ?? [];
  assert.deepEqual(forbidden, []);
});
