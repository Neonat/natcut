import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import { SrgbColorEvidenceSchema } from '@natcut/domain';
import { catalogSpriteId, normalizeSpritePng } from '../packages/render/src/assets.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const defaultCatalog = fileURLToPath(new URL('../packages/render/catalog/', import.meta.url));
const sortEntries = (entries) => entries.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('Expected a plant name (1–128 characters).');
  return value.trim().normalize('NFC');
}

const reviewedSourceSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  colorEvidence: SrgbColorEvidenceSchema,
});

async function normalizeSprite(row, directory) {
  const name = label(row.name);
  const scientificName = row.scientificName === undefined ? undefined : label(row.scientificName);
  if (typeof row.file !== 'string' || row.file !== path.basename(row.file) || !/\.png$/i.test(row.file)) {
    throw new Error(`Expected a PNG filename for ${name}.`);
  }
  const input = await readFile(path.join(directory, row.file));
  const reviewed = row.reviewedSource === undefined ? null : reviewedSourceSchema.parse(row.reviewedSource);
  const source = reviewed ? await readFile(path.join(directory, 'sources', reviewed.sha256 + '.png')) : input;
  if (reviewed && (hash(source) !== reviewed.sha256 || row.file !== hash(input) + '.png')) {
    throw new Error(`Reviewed artwork digest mismatch for ${name}.`);
  }
  const { format, pages } = await sharp(source).metadata();
  if (format !== 'png' || (pages ?? 1) !== 1) throw new Error(`Expected a still PNG for ${name}.`);
  const { png, side, colorEvidence } = await normalizeSpritePng(source, name);
  if (reviewed && (!png.equals(input) || !isDeepStrictEqual(colorEvidence, reviewed.colorEvidence))) {
    throw new Error(`Original artwork does not reproduce the approved pixels and profile evidence for ${name}.`);
  }
  const pngSha256 = hash(png);
  const entry = { name, ...(scientificName ? { scientificName } : {}), pngSha256, colorEvidence, width: side, height: side };
  return { entry: { id: catalogSpriteId(entry), ...entry }, png };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockParticipant(root) {
  const id = `${process.pid}-${randomUUID()}`;
  return { root, id, choosing: path.join(root, `choosing-${id}`), ticket: path.join(root, `ticket-${id}`) };
}

async function releaseParticipant(participant) {
  await Promise.all([rm(participant.choosing, { force: true }), rm(participant.ticket, { force: true })]);
}

async function lockFiles(root) {
  return (await readdir(root)).filter((file) => /^(choosing|ticket)-\d+-[0-9a-f-]+$/.test(file));
}

async function removeDeadParticipants(root, files) {
  const dead = new Set(files.map((file) => Number(file.split('-')[1])).filter((pid) => !processIsAlive(pid)));
  await Promise.all(files.filter((file) => dead.has(Number(file.split('-')[1])))
    .map((file) => rm(path.join(root, file), { force: true })));
}

async function readTickets(participant) {
  const files = await lockFiles(participant.root);
  await removeDeadParticipants(participant.root, files);
  const current = await lockFiles(participant.root);
  const tickets = [];
  for (const file of current.filter((name) => name.startsWith('ticket-'))) {
    try {
      tickets.push({ id: file.slice('ticket-'.length), number: Number(await readFile(path.join(participant.root, file), 'utf8')) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { files: current, tickets };
}

async function acquireLock(participant) {
  await mkdir(participant.root, { recursive: true });
  await writeFile(participant.choosing, '', { flag: 'wx' });
  const existing = await readTickets(participant);
  const number = Math.max(0, ...existing.tickets.map((ticket) => ticket.number)) + 1;
  await writeFile(participant.ticket, String(number), { flag: 'wx' });
  await rm(participant.choosing);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { files, tickets } = await readTickets(participant);
    const anotherChoosing = files.some((file) => file.startsWith('choosing-') && file.slice('choosing-'.length) !== participant.id);
    const ahead = tickets.some((ticket) => ticket.id !== participant.id
      && (ticket.number < number || (ticket.number === number && ticket.id < participant.id)));
    if (!anotherChoosing && !ahead) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for another sprite import to finish.');
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
  const participant = lockParticipant(out + '.import-lock-v2');
  const stop = (code) => { void releaseParticipant(participant).finally(() => process.exit(code)); };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const created = [];
  let stage;
  try {
    await acquireLock(participant);
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
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (stage) await rm(stage, { recursive: true, force: true });
    await releaseParticipant(participant);
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
