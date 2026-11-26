import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const defaultCatalog = fileURLToPath(new URL('../packages/render/catalog/', import.meta.url));
const sortEntries = (entries) => entries.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('Expected a plant name (1–128 characters).');
  return value.trim().normalize('NFC');
}

async function normalizeSprite(row, directory) {
  const name = label(row.name);
  const scientificName = row.scientificName === undefined ? undefined : label(row.scientificName);
  if (typeof row.file !== 'string' || row.file !== path.basename(row.file) || !/\.png$/i.test(row.file)) {
    throw new Error(`Expected a PNG filename for ${name}.`);
  }
  const source = sharp(await readFile(path.join(directory, row.file)));
  const { width, height, format, pages } = await source.metadata();
  if (format !== 'png' || (pages ?? 1) !== 1) throw new Error(`Expected a still PNG for ${name}.`);
  const side = Math.min(760, Math.max(width, height));
  const { data, info } = await source.toColourspace('srgb').ensureAlpha()
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().toBuffer({ resolveWithObject: true });
  if (!data.some((value, offset) => offset % 4 === 3 && value > 0)) throw new Error(`Empty artwork for ${name}.`);
  const png = await sharp(data, { raw: info }).png().toBuffer();
  const pngSha256 = hash(png);
  const id = 'sprite/' + hash(JSON.stringify([name, scientificName ?? null, pngSha256]));
  return { entry: { id, name, ...(scientificName ? { scientificName } : {}), pngSha256, width: side, height: side }, png };
}

async function publish(input, out) {
  const rows = JSON.parse(await readFile(input, 'utf8'));
  if (!Array.isArray(rows) || !rows.length) throw new Error('Expected a nonempty list of named PNG files.');
  const entries = [];
  const images = new Map();
  const names = new Set();
  for (const row of rows) {
    const { entry, png } = await normalizeSprite(row, path.dirname(input));
    const key = entry.name.toLowerCase();
    if (names.has(key) || images.has(entry.pngSha256)) throw new Error(`Duplicate plant name or artwork: ${entry.name}.`);
    names.add(key);
    images.set(entry.pngSha256, png);
    entries.push(entry);
  }

  const artwork = path.join(out, 'artwork');
  await mkdir(path.dirname(out), { recursive: true });
  const lock = out + '.import-lock';
  await mkdir(lock);
  const created = [];
  let stage;
  try {
    let previous = { version: 1, sprites: [], archived: [] };
    try {
      previous = JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (previous.version !== 1) throw new Error('Unsupported sprite index version.');
    const active = new Set(entries.map((entry) => entry.id));
    const archived = [...previous.sprites, ...previous.archived].filter((entry) => !active.has(entry.id));
    const index = { version: 1, sprites: sortEntries(entries), archived: sortEntries(archived) };

    stage = await mkdtemp(path.join(path.dirname(out), '.sprite-import-'));
    await writeFile(path.join(stage, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    await mkdir(artwork, { recursive: true });
    for (const [digest, png] of images) {
      const staged = path.join(stage, digest);
      const target = path.join(artwork, digest + '.png');
      await writeFile(staged, png);
      try {
        await link(staged, target);
        created.push(target);
      } catch (error) {
        if (error.code !== 'EEXIST' || hash(await readFile(target)) !== digest) throw error;
      }
    }
    await rename(path.join(stage, 'index.json'), path.join(out, 'index.json'));
  } catch (error) {
    await Promise.all(created.map((file) => rm(file)));
    throw error;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

try {
  const { values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' } } });
  if (!values.input) throw new Error('Usage: npm run sprites:import -- --input <roster.json> [--out <catalog-directory>]');
  await publish(path.resolve(values.input), path.resolve(values.out ?? defaultCatalog));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
