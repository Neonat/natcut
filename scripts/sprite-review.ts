import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import { DEVFEST_SG_V1 } from '../packages/domain/src/print-profile.ts';

const plantName = z.string().max(128).trim().min(1).normalize();
const imagePath = z.string().min(1);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  plants: z.array(z.strictObject({
    name: plantName,
    scientificName: plantName.optional(),
    reference: imagePath,
    candidates: z.array(imagePath).min(1),
  })).min(1),
});

type ManifestPlant = z.infer<typeof manifestSchema>['plants'][number];
type ReviewPlant = Omit<ManifestPlant, 'reference' | 'candidates'> & {
  reference: string;
  candidates: string[];
};
type ReviewPacket = { version: 1; key: string; plants: ReviewPlant[] };

const exec = promisify(execFile);
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const maxImageBytes = 32 * 1024 * 1024;
const imageOptions = { limitInputPixels: 40_000_000, failOn: 'warning' } as const;
const referenceFormats = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif'];

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function localImage(root: string, filename: string) {
  const candidate = path.resolve(root, filename);
  if (path.isAbsolute(filename) || path.win32.isAbsolute(filename) || !isWithin(root, candidate)) {
    throw new Error('Use a relative path inside the manifest directory.');
  }
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved)) throw new Error('Image resolves outside the manifest directory.');
  if (!(await lstat(resolved)).isFile()) throw new Error('Expected a regular image file.');
  const file = await open(resolved, 'r');
  try {
    const { size } = await file.stat();
    if (size === 0 || size > maxImageBytes) throw new Error('Expected a nonempty image of at most 32 MiB.');
    const bytes = await file.readFile();
    if (bytes.length !== size) throw new Error('The image changed while reading it.');
    return bytes;
  } finally {
    await file.close();
  }
}

function hasPngAnimation(bytes: Buffer) {
  // libpng can decode the default still frame without exposing APNG animation metadata.
  for (let offset = 8; offset + 12 <= bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
    const chunk = bytes.toString('ascii', offset + 4, offset + 8);
    if (chunk === 'acTL' || chunk === 'fcTL' || chunk === 'fdAT') return true;
    if (chunk === 'IEND') break;
  }
  return false;
}

async function normalizeImage(root: string, filename: string, name: string, role: 'reference' | 'candidate') {
  try {
    const bytes = await localImage(root, filename);
    const image = sharp(bytes, imageOptions);
    const { width, height, format, pages } = await image.metadata();
    const animated = (pages ?? 1) !== 1 || (format === 'png' && hasPngAnimation(bytes));
    if (role === 'reference') {
      if (animated || !referenceFormats.includes(format ?? '')) throw new Error('Expected a still raster image.');
      return await image.rotate().toColourspace('srgb').resize(760, 760, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#fffdf4' }).jpeg({ quality: 88 }).toBuffer();
    }
    if (format !== 'png' || animated || !/\.png$/i.test(filename)) throw new Error('Expected a still PNG.');

    // Match the catalog importer so it accepts the same alpha and artwork seen in review.
    const side = Math.min(760, Math.max(width, height));
    const { data, info } = await image.rotate().toColourspace('srgb').ensureAlpha()
      .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw().toBuffer({ resolveWithObject: true });
    if (!data.some((value, offset) => offset % 4 === 3 && value >= DEVFEST_SG_V1.alphaThreshold)) {
      throw new Error('No pixels meet the print alpha threshold.');
    }
    return await sharp(data, { raw: info }).png().toBuffer();
  } catch (error) {
    throw new Error(`${name}: ${role} image ${JSON.stringify(filename)}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertNewDestination(out: string) {
  try {
    await lstat(out);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${out}`);
}

async function publishDirectory(stage: string, out: string) {
  // Node exposes plain rename, which can replace an empty target directory.
  const script = `ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']]);
    function run(argv) { const RENAME_EXCL = 4; return $.renamex_np(argv[0], argv[1], RENAME_EXCL); }`;
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, stage, out]);
  if (stdout.trim() === '0') return;
  await assertNewDestination(out);
  throw new Error(`Could not publish packet at ${out}.`);
}

function renderPage(packet: ReviewPacket) {
  const data = JSON.stringify(packet).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sprite quality review</title>
<h1>Sprite quality review</h1>
<script type="application/json" id="review-packet">${data}</script>
</html>
`;
}

async function buildPacket(input: string, out: string) {
  if (process.platform !== 'darwin') throw new Error('Building an offline review packet requires macOS.');
  await assertNewDestination(out);
  const source = await readFile(input, 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(source));
  const root = await realpath(path.dirname(input));
  const plants: ReviewPlant[] = [];
  const names = new Set<string>();
  const files = new Set<string>();

  await mkdir(path.dirname(out), { recursive: true });
  const stage = await mkdtemp(path.join(path.dirname(out), '.sprite-review-'));
  try {
    for (const plant of manifest.plants) {
      const { name, scientificName } = plant;
      const nameKey = name.toLowerCase();
      if (names.has(nameKey)) throw new Error(`Duplicate plant name: ${name}.`);
      names.add(nameKey);

      const photo = await normalizeImage(root, plant.reference, name, 'reference');
      const reference = `${sha256(photo)}.jpg`;
      if (!files.has(reference)) await writeFile(path.join(stage, reference), photo);
      files.add(reference);

      const candidates: string[] = [];
      for (const filename of plant.candidates) {
        const sprite = await normalizeImage(root, filename, name, 'candidate');
        const candidate = `${sha256(sprite)}.png`;
        if (files.has(candidate)) throw new Error(`${name}: duplicate candidate artwork in ${JSON.stringify(filename)}.`);
        await writeFile(path.join(stage, candidate), sprite);
        files.add(candidate);
        candidates.push(candidate);
      }
      plants.push({ name, ...(scientificName ? { scientificName } : {}), reference, candidates });
    }

    const key = sha256(JSON.stringify([source, plants]));
    await writeFile(path.join(stage, 'index.html'), renderPage({ version: 1, key, plants }));
    await publishDirectory(stage, out);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

try {
  const { values: { input, out } } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' } } });
  if (!input || !out) throw new Error('Usage: npm run sprites:review -- --input <manifest.json> --out <new-directory>');
  await buildPacket(path.resolve(input), path.resolve(out));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
