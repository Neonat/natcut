import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { CompositionManifestSchema, DEVFEST_SG_V1, canonicalManifestJson } from '../packages/domain/src/index.ts';
import { evaluateCutGeometry } from '../packages/cut-geometry/src/index.ts';
import { catalogManifest, loadPackagedAssets, planComposition, renderCutGroupMasks, renderServerRaster } from '../packages/render/src/index.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function runProof(out, ...args) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/proof-sheet.ts', '--out', out, ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

test('proof:sheet publishes one reviewable offline packet without printer settings', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'natcut-proof-test-'));
  const out = path.join(parent, 'proof');
  try {
    const result = runProof(out);
    assert.equal(result.status, 0, result.stderr);

    const jpeg = await readFile(path.join(out, 'sheet.jpg'));
    const overlay = await readFile(path.join(out, 'cut-overlay.svg'), 'utf8');
    const evidence = JSON.parse(await readFile(path.join(out, 'evidence.json'), 'utf8'));
    const metadata = await sharp(jpeg).metadata();
    const pixels = await sharp(jpeg).ensureAlpha().raw().toBuffer();

    assert.equal((await lstat(out)).isDirectory(), true);
    assert.equal((await lstat(out)).isSymbolicLink(), false);
    assert.equal((await readdir(out)).includes('.incomplete'), false);
    assert.deepEqual([metadata.width, metadata.height], [1216, 2128]);
    assert.ok(jpeg.byteLength <= 1_048_576);
    assert.match(overlay, /^<svg[^>]+width="1216"[^>]+height="2128"/);
    assert.match(overlay, /translate\(8 14\)/);
    assert.equal(evidence.label, 'offline preview; not print-ready');
    assert.deepEqual(evidence.paddingPx, { left: 8, right: 8, top: 14, bottom: 14 });
    assert.equal(evidence.profile.id, 'devfest-sg-v1');
    assert.equal(evidence.profile.version, 1);
    assert.equal(evidence.logicalRaster.width, 1200);
    assert.equal(evidence.logicalRaster.height, 2100);
    assert.equal(evidence.jpeg.width, 1216);
    assert.equal(evidence.jpeg.height, 2128);
    assert.equal(evidence.jpeg.bytes, jpeg.byteLength);
    assert.match(evidence.manifestHash, /^[a-f0-9]{64}$/);
    assert.match(evidence.logicalRaster.sha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.cutMask.sha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.jpeg.sha256, /^[a-f0-9]{64}$/);
    assert.equal(evidence.jpeg.sha256, createHash('sha256').update(jpeg).digest('hex'));
    assert.deepEqual([...pixels.subarray(0, 4)], [255, 255, 255, 255]);
    const embeddedJpeg = Buffer.from(overlay.match(/base64,([^\"]+)/)?.[1] ?? '', 'base64');
    assert.deepEqual(embeddedJpeg, jpeg);

    const manifest = CompositionManifestSchema.parse({
      schemaVersion: 1,
      spriteAssetId: 'sprite/monstera-v1',
      trainerAssetId: null,
      theme: 'default',
      brandingVariant: 'logo',
      cutGroups: [
        { id: 'main', members: ['sprite'] },
        { id: 'brand', members: ['branding'] },
      ],
      cutMarginMm: 1.5,
      renderVersion: 'fixture-v1',
    });
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const assets = await loadPackagedAssets(plan);
    const raster = await renderServerRaster(plan, assets);
    const geometry = await evaluateCutGeometry(renderCutGroupMasks(plan, assets), manifest.cutMarginMm, DEVFEST_SG_V1);
    const paths = geometry.contours.map((contour) => [contour.outer, ...contour.inners]
      .map((points) => points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ') + ' Z')
      .join(' '));
    const pathDigest = createHash('sha256').update(paths.join('\n')).digest('hex');
    assert.equal(evidence.manifestHash, createHash('sha256').update(canonicalManifestJson(manifest)).digest('hex'));
    assert.equal(evidence.logicalRaster.sha256, '895dcc90da435793a4ff483e4b9a26b0adaf739037cea0945a8af061c5d8f143');
    assert.equal(evidence.cutMask.sha256, '1465f6f4822228afd53188f8490373156e9005a673cf06a6f3da849ecf90e84d');
    assert.equal(evidence.logicalRaster.sha256, raster.sha256);
    assert.equal(evidence.cutMask.sha256, geometry.report.rasterHash);
    assert.equal(evidence.geometry.contourSha256, pathDigest);
    assert.deepEqual([...overlay.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1]), paths);
    assert.equal(new Set([
      evidence.manifestHash,
      evidence.logicalRaster.sha256,
      evidence.cutMask.sha256,
      evidence.jpeg.sha256,
      evidence.geometry.contourSha256,
    ]).size, 5);
    assert.ok(evidence.geometry.contourCount > 0);
    assert.equal(JSON.stringify(evidence).includes('knifePressure'), false);
    assert.equal(JSON.stringify(evidence).includes('plt'), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('proof:sheet leaves an existing destination untouched', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'natcut-proof-existing-'));
  const out = path.join(parent, 'proof');
  try {
    const first = runProof(out);
    assert.equal(first.status, 0, first.stderr);
    const original = await readFile(path.join(out, 'evidence.json'));

    const second = runProof(out);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/i);
    assert.deepEqual(await readFile(path.join(out, 'evidence.json')), original);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('proof:sheet lets only one concurrent builder own a destination', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'natcut-proof-race-'));
  const out = path.join(parent, 'proof');
  try {
    const makeChild = () => spawn(process.execPath, ['--import', 'tsx', 'scripts/proof-sheet.ts', '--out', out], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const children = [makeChild(), makeChild()];
    const statuses = await Promise.all(children.map((child) => new Promise((resolve) => child.once('close', resolve))));

    assert.deepEqual(statuses.sort(), [0, 1]);
    assert.deepEqual((await readdir(out)).sort(), ['cut-overlay.svg', 'evidence.json', 'sheet.jpg']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('proof:sheet rejects an unsupported manifest supplied on the command line', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'natcut-proof-invalid-'));
  try {
    const source = path.join(parent, 'manifest.json');
    await writeFile(source, JSON.stringify({ ...catalogManifest, renderVersion: 'future' }));
    const result = runProof(path.join(parent, 'proof'), '--manifest', source);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(parent), ['manifest.json']);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
