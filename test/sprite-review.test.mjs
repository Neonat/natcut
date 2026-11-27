import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import nodeTest from 'node:test';
import sharp from 'sharp';

const script = new URL('../scripts/sprite-review.ts', import.meta.url);
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
    image({ r: 14, g: 151, b: 67 }).png().toFile(path.join(src, 'one.png')),
    image({ r: 10, g: 125, b: 91 }).png().toFile(path.join(src, 'two.png')),
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
  const args = (dest = out) => [script.pathname, '--input', input, '--out', dest];
  const save = () => writeFile(input, JSON.stringify(manifest));
  const run = async (dest) => {
    await save();
    return spawnSync(process.execPath, args(dest), { encoding: 'utf8' });
  };
  return { root, src, input, out, manifest, args, save, run };
}

test('publishes a deterministic offline packet with importer-compatible candidate PNGs', async (t) => {
  const { root, out, run } = await fixture(t);
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  const files = await readdir(out);
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /Monstera deliciosa/);
  assert.match(html, /Prickly pear/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.deepEqual(files.map((file) => path.extname(file)).sort(), ['.html', '.jpg', '.png', '.png']);
  for (const file of files.filter((file) => file !== 'index.html')) {
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
  await writeFile(roster, JSON.stringify(files.filter((file) => file.endsWith('.png')).map((file, index) => ({
    name: `Plant ${index + 1}`, file,
  }))));
  await exec(process.execPath, [new URL('../scripts/import-sprites.mjs', import.meta.url).pathname,
    '--input', roster, '--out', catalog]);
  const { sprites } = JSON.parse(await readFile(path.join(catalog, 'index.json'), 'utf8'));
  assert.deepEqual(sprites.map(({ pngSha256 }) => pngSha256), files.filter((file) => file.endsWith('.png'))
    .map((file) => path.parse(file).name));
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
  ['an empty candidate', /Monstera.*(?:image|PNG)/, ({ src }) => writeFile(path.join(src, 'one.png'), '')],
  ['a corrupt PNG', /Monstera.*(?:image|PNG)/, async ({ src }) => {
    const file = path.join(src, 'one.png');
    await writeFile(file, (await readFile(file)).subarray(0, 50));
  }],
  ['a candidate below printable alpha', /Monstera.*alpha/i, ({ src }) =>
    image({ r: 14, g: 151, b: 67 }, 0.4).png().toFile(path.join(src, 'one.png'))],
  ['duplicate common names', /duplicate.*monstera/i, ({ manifest }) => { manifest.plants[1].name = ' monstera '; }],
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
  assert.equal((await readdir(out)).length, 4);
});
