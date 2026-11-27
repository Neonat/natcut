import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import nodeTest from 'node:test';
import sharp from 'sharp';
import { JSDOM } from 'jsdom';

const script = fileURLToPath(new URL('../scripts/sprite-review.ts', import.meta.url));
const exec = promisify(execFile);
const test = process.platform === 'darwin' ? nodeTest : nodeTest.skip;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function image(name, alpha = 1) {
  return sharp({ create: { width: 12, height: 20, channels: 4, background: { ...name, alpha } } });
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'natcut-sprite-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = path.join(root, 'source');
  await mkdir(src);
  await Promise.all([
    image({ r: 40, g: 60, b: 30 }).jpeg().toFile(path.join(src, 'reference.jpg')),
    image({ r: 14, g: 151, b: 67 }).withIccProfile('p3').png().toFile(path.join(src, 'one.png')),
    image({ r: 10, g: 125, b: 91 }).withIccProfile('srgb').png().toFile(path.join(src, 'two.png')),
  ]);
  const manifest = {
    version: 1,
    plants: [
      { name: 'Monstera', scientificName: 'Monstera deliciosa', reference: 'reference.jpg', candidates: ['one.png'] },
      { name: 'Prickly pear', reference: 'reference.jpg', candidates: ['two.png'] },
    ],
  };
  const input = path.join(src, 'manifest.json');
  const out = path.join(root, 'review packet 🌿');
  const args = (dest = out) => [script, '--input', input, '--out', dest];
  const save = () => writeFile(input, JSON.stringify(manifest));
  const run = async (dest) => {
    await save();
    return spawnSync(process.execPath, args(dest), { encoding: 'utf8' });
  };
  return { root, src, input, out, manifest, args, save, run };
}

test('publishes a deterministic offline packet with importer-compatible candidate PNGs', async (t) => {
  const { root, src, out, run } = await fixture(t);
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(out);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  const packet = JSON.parse(html.match(/<script type="application\/json" id="review-packet">(.*?)<\/script>/s)[1]);
  const first = packet.plants[0];
  const source = first.candidateSources[first.candidates[0]];
  assert.equal(source.sha256, sha256(await readFile(path.join(src, 'one.png'))));
  assert.equal(source.colorEvidence.sources[0].sourceSpace, 'display-p3');
  assert.equal(source.colorEvidence.sources[0].action, 'converted');
  assert.match(html, /Monstera deliciosa/);
  assert.match(html, /Prickly pear/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.deepEqual(files.map((file) => path.extname(file)).sort(), ['', '.html', '.jpg', '.png', '.png']);
  for (const file of files.filter((file) => file !== 'index.html' && file !== 'sources')) {
    const bytes = await readFile(path.join(out, file));
    assert.equal(path.parse(file).name, sha256(bytes));
    assert.ok(html.includes(file));
  }
  const again = path.join(root, 'another-packet');
  const second = await run(again);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await readdir(again), files);
  assert.equal(await readFile(path.join(again, 'index.html'), 'utf8'), html);

  const roster = path.join(out, 'roster.json');
  const catalog = path.join(root, 'private-catalog');
  let download;
  const dom = new JSDOM(html, { url: 'https://review.invalid/', runScripts: 'dangerously',
    beforeParse(window) {
      window.Blob = Blob;
      window.URL.createObjectURL = blob => { download = blob; return 'blob:roster'; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = () => {};
    },
  });
  try {
    const { document } = dom.window;
    for (const radio of document.querySelectorAll('input[data-plant], input[data-metric][value="5"]')) radio.click();
    document.querySelector('#export').click();
    await writeFile(roster, await download.text());
  } finally { dom.window.close(); }
  const rows = JSON.parse(await readFile(roster, 'utf8'));
  assert.deepEqual(rows.map(row => row.reviewedSource), packet.plants.map(plant => plant.candidateSources[plant.candidates[0]]));
  const importRoster = () => exec(process.execPath, [fileURLToPath(new URL('../scripts/import-sprites.mjs', import.meta.url)),
    '--input', roster, '--out', catalog]);
  await importRoster();
  const { sprites } = JSON.parse(await readFile(path.join(catalog, 'index.json'), 'utf8'));

  // Stand in for packaging this imported index with the submission service.
  const catalogHook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === '../catalog/index.json' && context.parentURL?.endsWith('/render/src/catalog.ts')) {
      return nextResolve(pathToFileURL(path.join(catalog, 'index.json')).href, context);
    }
    return nextResolve(specifier, context);
  } });
  try {
    const { assetPngFilename, catalogManifest, loadPackagedAssets } = await import('@natcut/render');
    const { ArtifactReceiptSchema, NATIVE_SRGB_EVIDENCE } = await import('@natcut/domain');
    const { createTrustedArtifactPreparer } = await import('../apps/submission/src/validation.ts');
    const artwork = path.join(catalog, 'artwork');
    const logo = assetPngFilename('branding/logo');
    await copyFile(fileURLToPath(new URL('../packages/render/catalog/artwork/' + logo, import.meta.url)), path.join(artwork, logo));
    const prepare = createTrustedArtifactPreparer(plan => loadPackagedAssets(plan, artwork));
    for (const entry of sprites) {
      const approved = rows.find(row => row.name === entry.name);
      assert.equal(entry.pngSha256 + '.png', approved.file);
      assert.deepEqual(entry.colorEvidence, approved.reviewedSource.colorEvidence);
      const { bundle } = await prepare({ ...catalogManifest, spriteAssetId: entry.id });
      const { descriptor } = ArtifactReceiptSchema.parse({ descriptor: bundle.descriptor, generation: '1' });
      const [source] = entry.colorEvidence.sources;
      const [native] = NATIVE_SRGB_EVIDENCE.sources;
      const expected = source.sourceSpace === 'display-p3' ? [source, native] : [native, source];
      assert.deepEqual(descriptor.colorEvidence, { ...NATIVE_SRGB_EVIDENCE, sources: expected });
    }
  } finally { catalogHook.deregister(); }

  const forged = structuredClone(rows);
  forged[0].reviewedSource.colorEvidence = rows[1].reviewedSource.colorEvidence;
  await writeFile(roster, JSON.stringify(forged));
  await assert.rejects(importRoster(), /profile evidence/);
  forged[0].reviewedSource = rows[1].reviewedSource;
  await writeFile(roster, JSON.stringify(forged));
  await assert.rejects(importRoster(), /approved pixels/);
});

const invalid = [
  ['unsupported manifest version', /version/i, ({ manifest }) => { manifest.version = 2; }],
  ['unexpected manifest fields', /unexpected|unrecognized/i, ({ manifest }) => { manifest.extra = true; }],
  ['an escaping path', /Monstera.*relative|Monstera.*outside/i, ({ manifest }) => {
    manifest.plants[0].reference = '../reference.jpg';
  }],
  ['an escaping symlink', /Monstera.*outside/i, async ({ root, src, manifest }) => {
    await writeFile(path.join(root, 'outside.png'), await readFile(path.join(src, 'one.png')));
    await symlink('../outside.png', path.join(src, 'link.png'));
    manifest.plants[0].candidates = ['link.png'];
  }],
  ['a missing image', /Monstera.*missing.png/i, ({ manifest }) => { manifest.plants[0].candidates = ['missing.png']; }],
  ['a non-PNG candidate', /Monstera.*PNG/, async ({ src }) => {
    await writeFile(path.join(src, 'one.png'), await readFile(path.join(src, 'reference.jpg')));
  }],
  ['an animated PNG', /Monstera.*(?:animated|still)/i, async ({ src }) => {
    const file = path.join(src, 'one.png');
    const png = await readFile(file);
    const frames = Buffer.alloc(8);
    frames.writeUInt32BE(2);
    await writeFile(file, Buffer.concat([png.subarray(0, 33), pngChunk('acTL', frames), png.subarray(33)]));
  }],
  ['untagged printable candidates', /Monstera.*profile/i, ({ src }) =>
    image({ r: 14, g: 151, b: 67 }).png().toFile(path.join(src, 'one.png'))],
  ['an empty candidate', /Monstera.*(?:image|PNG)/, ({ src }) => writeFile(path.join(src, 'one.png'), '')],
  ['a corrupt PNG', /Monstera.*(?:image|PNG)/, async ({ src }) => {
    const file = path.join(src, 'one.png');
    await writeFile(file, (await readFile(file)).subarray(0, 50));
  }],
  ['a candidate below printable alpha', /Monstera.*alpha/i, ({ src }) =>
    image({ r: 14, g: 151, b: 67 }, 0.4).withIccProfile('srgb').png().toFile(path.join(src, 'one.png'))],
  ['duplicate common names', /duplicate.*monstera/i, ({ manifest }) => { manifest.plants[1].name = ' monstera '; }],
  ['a common name that grows beyond 128 characters in NFC', /name[\s\S]*128/i, ({ manifest }) => {
    manifest.plants[0].name = '\u0344'.repeat(65);
  }],
  ['a scientific name that grows beyond 128 characters in NFC', /scientificName[\s\S]*128/i, ({ manifest }) => {
    manifest.plants[0].scientificName = '\u0344'.repeat(65);
  }],
  ['duplicate candidate bytes within a plant', /Monstera.*duplicate/i, async ({ src, manifest }) => {
    await writeFile(path.join(src, 'copy.png'), await readFile(path.join(src, 'one.png')));
    manifest.plants[0].candidates.push('copy.png');
  }],
  ['duplicate importer artwork across plants', /Prickly pear.*duplicate/i, ({ manifest }) => {
    manifest.plants[1].candidates = ['one.png'];
  }],
];

for (const [label, message, configure] of invalid) {
  test(`rejects ${label} before publishing`, async (t) => {
    const packet = await fixture(t);
    await configure(packet);
    const original = await readdir(packet.root);
    const result = await packet.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.deepEqual(await readdir(packet.root), original);
  });
}

test('rejects a parent symlink swapped in after resolving a candidate', async (t) => {
  const { root, src, manifest, save, args } = await fixture(t);
  const parent = path.join(await realpath(src), 'images');
  const outside = path.join(root, 'outside');
  const filename = 'one.png';
  await mkdir(parent);
  await mkdir(outside);
  await writeFile(path.join(parent, filename), await readFile(path.join(src, filename)));
  await image({ r: 24, g: 38, b: 117 }).png().toFile(path.join(outside, filename));
  manifest.plants[0].candidates = [path.join('images', filename)];
  await save();
  const before = await readdir(root);
  const preload = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.realpath;
    fs.realpath = async (file) => {
      const resolved = await original(file);
      if (resolved === ${JSON.stringify(path.join(parent, filename))}) {
        await fs.rename(${JSON.stringify(parent)}, ${JSON.stringify(parent + '-moved')});
        await fs.symlink(${JSON.stringify(outside)}, ${JSON.stringify(parent)});
      }
      return resolved;
    };
    syncBuiltinESMExports();
  `;
  const run = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, ...args()], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /Monstera.*outside/i);
  assert.deepEqual(await readdir(root), before);
});

test('leaves any existing destination untouched', async (t) => {
  const { root, out, run } = await fixture(t);
  await mkdir(out);
  const result = await run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /already exists/i);
  assert.deepEqual(await readdir(out), []);
  const existingFile = path.join(root, 'existing-file');
  await writeFile(existingFile, 'keep me');
  const fileResult = await run(existingFile);
  assert.equal(fileResult.status, 1, fileResult.stderr);
  assert.match(fileResult.stderr, /already exists/i);
  assert.equal(await readFile(existingFile, 'utf8'), 'keep me');
});

test('publishes only one complete packet when two builders race', async (t) => {
  const { root, out, save, args } = await fixture(t);
  await save();
  const results = await Promise.allSettled([exec(process.execPath, args()), exec(process.execPath, args())]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.match(failed.reason.stderr, /already exists/i);
  assert.deepEqual(await readdir(root), [path.basename(out), 'source']);
  assert.equal((await readdir(out)).length, 5);
});
