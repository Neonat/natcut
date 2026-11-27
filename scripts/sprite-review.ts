import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import sharp from 'sharp';
import { z } from 'zod';
import type { SrgbColorEvidence } from '@natcut/domain';
import { normalizeSpritePng } from '../packages/render/src/assets.ts';

const plantName = z.string().max(128).trim().min(1).normalize().max(128);
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
  candidateSources: Record<string, { sha256: string; colorEvidence: SrgbColorEvidence }>;
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

function openedImagePath(fd: number) {
  // macOS can resolve an inherited file descriptor with fcntl(F_GETPATH).
  const script = String.raw`
    open my $image, '<&=3' or die $!;
    my $path = "\0" x 1024;
    fcntl($image, 50, $path) or die $!;
    $path =~ s/\0.*\z//s;
    binmode STDOUT, ':raw';
    print $path;
  `;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('/usr/bin/perl', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore', fd] });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 && path.isAbsolute(output)) resolve(output);
      else reject(new Error('Could not verify the opened image path.'));
    });
  });
}

async function localImage(root: string, filename: string) {
  const candidate = path.resolve(root, filename);
  if (path.isAbsolute(filename) || path.win32.isAbsolute(filename) || !isWithin(root, candidate)) {
    throw new Error('Use a relative path inside the manifest directory.');
  }
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved)) throw new Error('Image resolves outside the manifest directory.');
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!isWithin(root, await openedImagePath(file.fd))) throw new Error('Opened image is outside the manifest directory.');
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('Expected a regular image file.');
    if (stats.size === 0 || stats.size > maxImageBytes) throw new Error('Expected a nonempty image of at most 32 MiB.');

    const bytes = Buffer.alloc(stats.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== stats.size) throw new Error('The image changed while reading it.');
    return bytes.subarray(0, length);
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
    const { format, pages } = await image.metadata();
    const animated = (pages ?? 1) !== 1 || (format === 'png' && hasPngAnimation(bytes));
    if (role === 'reference') {
      if (animated || !referenceFormats.includes(format ?? '')) throw new Error('Expected a still raster image.');
      const jpeg = await image.rotate().toColourspace('srgb').resize(760, 760, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#fffdf4' }).jpeg({ quality: 88 }).toBuffer();
      return { bytes: jpeg, source: null, original: null };
    }
    if (format !== 'png' || animated || !/\.png$/i.test(filename)) throw new Error('Expected a still PNG.');

    const { png, colorEvidence } = await normalizeSpritePng(bytes, name, imageOptions.limitInputPixels);
    return { bytes: png, source: { sha256: sha256(bytes), colorEvidence }, original: bytes };
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

const reviewStyles = `
  :root {
    color-scheme: light;
    --forest: #18392b;
    --cream: #f7f2df;
    --paper: #fffdf4;
    --leaf-light: #e8efce;
    --line: #b7c0a9;
    --muted: #526457;
    --focus: #a04a2d;
    background: var(--cream);
    color: var(--forest);
    font: 1rem/1.45 system-ui, sans-serif;
    scroll-padding-top: 8rem;
    accent-color: var(--forest);
  }
  *, *::before, *::after { box-sizing: border-box; }
  body, h1, h2, h3, p, figure, fieldset { margin: 0; }
  img { display: block; width: 100%; }
  button { font: inherit; }
  .frame { width: min(100% - 2rem, 78rem); margin-inline: auto; }
  .masthead { position: sticky; z-index: 1; top: 0; background: var(--paper); border-bottom: 1px solid var(--line); }
  .masthead .frame { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .5rem 1.25rem; padding-block: .75rem; }
  h1 { font-size: 1.125rem; font-weight: 750; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
  .progress { color: var(--muted); font-size: .875rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  .score-warning:not([hidden]) { display: block; font-size: .75rem; font-weight: 500; }
  button {
    min-height: 44px; padding: .5rem 1rem; border: 1px solid var(--forest); border-radius: .4rem;
    color: var(--paper); background: var(--forest); font-size: .875rem; font-weight: 750; cursor: pointer;
  }
  button:hover:not(:disabled) { background: #284f37; }
  button:disabled { color: var(--muted); background: #e9e9dc; border-color: var(--line); cursor: default; }
  .warning { padding: .5rem .75rem; background: #fff0b9; border-inline-start: 3px solid var(--focus); }
  .plant { padding-block: 1.5rem 1.75rem; border-bottom: 1px solid var(--line); }
  .plant-title { margin-bottom: .875rem; }
  h2 { font: 700 clamp(1.625rem, 4vw, 2.125rem)/1.15 Georgia, serif; overflow-wrap: anywhere; text-wrap: balance; }
  .scientific { margin-top: .125rem; color: var(--muted); font-style: italic; overflow-wrap: anywhere; }
  .comparison { display: grid; gap: .875rem; align-items: start; }
  .reference, .candidate { min-width: 0; padding: .625rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--paper); }
  figcaption, h3 { margin: 0 0 .5rem; font-size: .875rem; font-weight: 750; }
  .reference img { height: 10.5rem; object-fit: contain; background: #ecebde; border-radius: .25rem; }
  .candidates { min-width: 0; padding: 0; border: 0; }
  .candidate-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 16.5rem), 1fr)); gap: .875rem; }
  .candidate:has(.approval input:checked) { border-color: var(--forest); box-shadow: inset 0 0 0 1px var(--forest); }
  .candidate img {
    height: 10.5rem; padding: .5rem; object-fit: contain; border-radius: .25rem;
    background: repeating-conic-gradient(#f3f1e5 0% 25%, #e8e9dc 0% 50%) 0 0 / 1rem 1rem;
  }
  .rating { min-width: 0; padding: 0; border: 0; margin-top: .5rem; }
  .rating legend { padding: 0; margin-bottom: .25rem; font-size: .8125rem; font-weight: 650; }
  .score-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(44px, 1fr)); gap: .25rem; }
  label { min-height: 44px; display: flex; align-items: center; justify-content: center; color: var(--forest); cursor: pointer; }
  .score-options label, .approval { border: 1px solid var(--line); border-radius: .3rem; background: var(--paper); gap: .25rem; }
  label:hover, label:has(input:checked) { border-color: var(--forest); background: var(--leaf-light); }
  label:has(input:checked) { font-weight: 750; }
  label input { width: 1rem; height: 1rem; margin: 0; flex: none; }
  button:focus-visible, label:has(input:focus-visible) { outline: 3px solid var(--focus); outline-offset: 2px; }
  .score-options span { font-size: .8125rem; }
  .approval { justify-content: start; gap: .5rem; margin-top: .625rem; padding-inline: .625rem; font-size: .875rem; }
  .approved-text, .approval:has(input:checked) .approve-text { display: none; }
  .approval:has(input:checked) .approved-text { display: inline; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 30rem) {
    .actions { width: 100%; }
    .progress { flex: 1; min-width: 0; }
    .reference img, .candidate img { height: 9rem; }
  }
  @media (min-width: 48rem) {
    .comparison { grid-template-columns: minmax(12rem, 1fr) minmax(0, 3fr); }
    .reference { position: sticky; top: 5.25rem; }
    .reference img { height: auto; aspect-ratio: 1; }
  }
`;

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function renderRating(candidate: string, metric: 'cuteness' | 'accuracy', label: string) {
  const scores = [1, 2, 3, 4, 5].map((score) => `<label>
    <input type="radio" name="${candidate}-${metric}" data-candidate="${candidate}" data-metric="${metric}" value="${score}">
    <span>${score}</span>
  </label>`).join('');
  return `<fieldset class="rating"><legend>${label}</legend><div class="score-options">${scores}</div></fieldset>`;
}

function renderPlant(plant: ReviewPlant, index: number) {
  const name = escapeHtml(plant.name);
  const scientific = plant.scientificName ? `<p class="scientific">${escapeHtml(plant.scientificName)}</p>` : '';
  const candidates = plant.candidates.map((file, candidateIndex) => {
    const number = candidateIndex + 1;
    return `<article class="candidate" aria-labelledby="candidate-${index}-${number}">
      <h3 id="candidate-${index}-${number}">Candidate ${number}</h3>
      <img src="${file}" alt="Candidate ${number} sprite for ${name}">
      ${renderRating(file, 'cuteness', 'Cuteness')}
      ${renderRating(file, 'accuracy', 'Accuracy')}
      <label class="approval">
        <input type="radio" name="approval-${index}" data-plant="${index}" value="${file}">
        <span class="approve-text">Approve sprite</span><span class="approved-text">Approved sprite</span>
      </label>
    </article>`;
  }).join('');
  return `<section class="plant" aria-labelledby="plant-${index}">
    <header class="plant-title"><h2 id="plant-${index}">${name}</h2>${scientific}</header>
    <div class="comparison">
      <figure class="reference">
        <figcaption>Reference photo</figcaption>
        <img src="${plant.reference}" alt="Reference photo of ${name}">
      </figure>
      <fieldset class="candidates">
        <legend class="visually-hidden">Approve one sprite for ${name}</legend>
        <div class="candidate-grid">${candidates}</div>
      </fieldset>
    </div>
  </section>`;
}

const reviewScript = `
  const packet = JSON.parse(document.querySelector('#review-packet').textContent);
  const form = document.querySelector('#review');
  const progress = document.querySelector('#progress');
  const scoreWarning = document.querySelector('#score-warning');
  const exportButton = document.querySelector('#export');
  const storageWarning = document.querySelector('#storage-warning');
  const storageKey = 'natcut:sprite-review:v1:' + packet.key;
  const total = packet.plants.length;

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.version === 1) {
      for (const input of form.querySelectorAll('input[type="radio"]')) {
        const { candidate, metric, plant } = input.dataset;
        const value = metric ? saved.scores?.[candidate]?.[metric] : saved.approved?.[plant];
        input.checked = String(value) === input.value;
      }
    }
  } catch {
    storageWarning.hidden = false;
  }

  function readProgress() {
    const scores = {};
    const approved = {};
    for (const input of form.querySelectorAll('input:checked')) {
      const { candidate, metric, plant } = input.dataset;
      if (metric) (scores[candidate] ??= {})[metric] = Number(input.value);
      else approved[plant] = input.value;
    }
    return { version: 1, scores, approved };
  }

  function completeCount({ scores, approved }) {
    return Object.values(approved).filter((file) => scores[file]?.cuteness && scores[file]?.accuracy).length;
  }

  function showProgress(state) {
    const count = completeCount(state);
    progress.textContent = count + ' of ' + total + (total === 1 ? ' plant' : ' plants') + ' complete';
    scoreWarning.hidden = count === Object.keys(state.approved).length;
    exportButton.disabled = count !== total;
  }

  form.addEventListener('change', () => {
    const state = readProgress();
    showProgress(state);
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
      storageWarning.hidden = true;
    } catch {
      storageWarning.hidden = false;
    }
  });

  exportButton.addEventListener('click', () => {
    const state = readProgress();
    if (completeCount(state) !== total) return;
    const roster = packet.plants.map(({ name, scientificName, candidateSources }, index) => ({
      name, ...(scientificName ? { scientificName } : {}), file: state.approved[index],
      reviewedSource: candidateSources[state.approved[index]],
    }));
    const url = URL.createObjectURL(new Blob([JSON.stringify(roster, null, 2) + '\\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'roster.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  showProgress(readProgress());
`;

function renderPage(packet: ReviewPacket) {
  const data = JSON.stringify(packet).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sprite quality review</title>
  <style>${reviewStyles}</style>
</head>
<body>
  <header class="masthead">
    <div class="frame">
      <h1>Sprite quality review</h1>
      <div class="actions">
        <p class="progress" role="status" aria-atomic="true">
          <span id="progress">0 of ${packet.plants.length} ${packet.plants.length === 1 ? 'plant' : 'plants'} complete</span>
          <small class="score-warning" id="score-warning" hidden>Score both fields on approved sprites.</small>
        </p>
        <button id="export" type="button" disabled>Export roster</button>
      </div>
    </div>
  </header>
  <main class="frame">
    <p class="warning" id="storage-warning" role="alert" hidden>Review progress could not be loaded or saved. Keep this tab open until you export.</p>
    <noscript><p class="warning">Enable JavaScript to score sprites and export your roster.</p></noscript>
    <form id="review" autocomplete="off">
      ${packet.plants.map(renderPlant).join('')}
    </form>
  </main>
  <script type="application/json" id="review-packet">${data}</script>
  <script>${reviewScript}</script>
</body>
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
    await mkdir(path.join(stage, 'sources'));
    for (const plant of manifest.plants) {
      const { name, scientificName } = plant;
      const nameKey = name.toLowerCase();
      if (names.has(nameKey)) throw new Error(`Duplicate plant name: ${name}.`);
      names.add(nameKey);

      const { bytes: photo } = await normalizeImage(root, plant.reference, name, 'reference');
      const reference = `${sha256(photo)}.jpg`;
      if (!files.has(reference)) await writeFile(path.join(stage, reference), photo);
      files.add(reference);

      const candidates: string[] = [];
      const candidateSources: ReviewPlant['candidateSources'] = {};
      for (const filename of plant.candidates) {
        const { bytes: sprite, source, original } = await normalizeImage(root, filename, name, 'candidate');
        const candidate = `${sha256(sprite)}.png`;
        if (files.has(candidate)) throw new Error(`${name}: duplicate candidate artwork in ${JSON.stringify(filename)}.`);
        await writeFile(path.join(stage, candidate), sprite);
        files.add(candidate);
        candidates.push(candidate);
        if (!source || !original) throw new Error('Missing original candidate evidence.');
        candidateSources[candidate] = source;
        await writeFile(path.join(stage, 'sources', source.sha256 + '.png'), original);
      }
      plants.push({ name, ...(scientificName ? { scientificName } : {}), reference, candidates, candidateSources });
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
