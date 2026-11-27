import { createHash } from 'node:crypto';
import { verifyArtifactBytes } from '@natcut/artifacts/reader';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle, type SrgbColorEvidence } from '@natcut/domain';
import sharp from 'sharp';
import { loadRgbaAsset } from '@natcut/render';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { pathToPixels } from '../../../vendor/pixcut-trace/transform.ts';
import { preparePhysicalArtifacts } from './artifacts.ts';

const diagnosticDesignVersion = 'natcut-six-circle-physical-proof-v1';
const imageDesignVersion = 'natcut-opaque-sheet-physical-proof-v1';
const cutExpansionPixels = 2;
const colors = [
  [237, 91, 91],
  [244, 176, 67],
  [80, 178, 121],
  [70, 149, 224],
  [141, 105, 211],
  [224, 102, 170],
] as const;
const centers = [
  [350, 400], [850, 400],
  [350, 1050], [850, 1050],
  [350, 1700], [850, 1700],
] as const;

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
function sha256Bytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
function proofRasters() {
  const { sheetWidthPx: width, sheetHeightPx: height } = DEVFEST_SG_V1;
  const rgba = new Uint8Array(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      for (let sticker = 0; sticker < centers.length; sticker += 1) {
        const center = centers[sticker]!;
        const dx = x - center[0];
        const dy = y - center[1];
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared <= 245 * 245) mask[pixel] = 255;
        if (distanceSquared <= 225 * 225) {
          const color = colors[sticker]!;
          rgba.set([color[0], color[1], color[2], 255], pixel * 4);
        }
      }
    }
  }
  return { rgba, mask, colorEvidence: NATIVE_SRGB_EVIDENCE };
}
function backgroundMedian(rgb: Uint8Array, width: number, height: number) {
  const samples: number[][] = [[], [], []];
  const border = 16;
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel += 1) samples[channel]!.push(rgb[offset + channel]!);
  };
  for (let x = 0; x < width; x += 4) for (const y of [0, border - 1, height - border, height - 1]) add(x, y);
  for (let y = border; y < height - border; y += 4) for (const x of [0, border - 1, width - border, width - 1]) add(x, y);
  return samples.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!) as [number, number, number];
}

function removeSmallComponents(candidate: Uint8Array, width: number, minimumPixels: number) {
  const height = candidate.length / width;
  const seen = new Uint8Array(candidate.length);
  const output = new Uint8Array(candidate.length);
  const queue = new Int32Array(candidate.length);
  for (let start = 0; start < candidate.length; start += 1) {
    if (candidate[start] === 0 || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (candidate[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (tail >= minimumPixels) for (let index = 0; index < tail; index += 1) output[queue[index]!] = 255;
  }
  return output;
}

function dilate(mask: Uint8Array, width: number, radius: number) {
  const height = mask.length / width;
  const output = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    if (mask[index] === 0) continue;
    for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) output[nextY * width + nextX] = 255;
    }
  }
  return output;
}

function maskOpaqueSheet(rgb: Uint8Array, width: number, height: number) {
  const background = backgroundMedian(rgb, width, height);
  const candidate = new Uint8Array(width * height);
  const thresholdSquared = 16 * 16;
  for (let pixel = 0; pixel < candidate.length; pixel += 1) {
    const offset = pixel * 3;
    const red = rgb[offset]! - background[0];
    const green = rgb[offset + 1]! - background[1];
    const blue = rgb[offset + 2]! - background[2];
    if (red * red + green * green + blue * blue > thresholdSquared) candidate[pixel] = 255;
  }
  return dilate(removeSmallComponents(candidate, width, 100), width, cutExpansionPixels);
}

function svgPath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
}

function buildCutPreviewSvg(jpeg: Uint8Array, plt: Uint8Array) {
  const profile = DEVFEST_SG_V1;
  const paddingX = (profile.rasterWidthPx - profile.sheetWidthPx) / 2;
  const paddingY = (profile.rasterHeightPx - profile.sheetHeightPx) / 2;
  const document = parsePlt(new TextDecoder().decode(plt));
  const paths = document.paths.map((path) => pathToPixels(
    path,
    profile.sheetWidthPx,
    profile.sheetHeightPx,
    { fillMethod: 'fit', scaleRatio: 1 },
  ));
  const serialized = paths.map((path) =>
    `<path d="${svgPath(path)}" fill="none" stroke="#ff315c" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${profile.rasterWidthPx}" height="${profile.rasterHeightPx}" viewBox="0 0 ${profile.rasterWidthPx} ${profile.rasterHeightPx}" role="img" aria-label="Blade path overlay"><title>Blade path overlay; red lines are the exact PLT trajectories</title><image width="${profile.rasterWidthPx}" height="${profile.rasterHeightPx}" href="data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}"/><g transform="translate(${paddingX} ${paddingY})">${serialized}</g></svg>`;
}

async function buildFromRasters(
  rasters: { rgba: Uint8Array; mask: Uint8Array; colorEvidence: SrgbColorEvidence },
  options: { designVersion: string; label: string; sourceImageSha256?: string },
) {
  const profile = DEVFEST_SG_V1;
  const bundle = await encodeLogicalSourceBundle({
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    profile,
    renderVersion: options.designVersion,
    geometryVersion: options.designVersion,
    ...rasters,
  });
  const receipt = { descriptor: bundle.descriptor, generation: '1' };
  const verified = await verifyArtifactBytes(bundle.bytes, receipt);
  const artifacts = await preparePhysicalArtifacts(verified);
  const evidence = {
    designVersion: options.designVersion,
    sourceImageSha256: options.sourceImageSha256 ?? null,
    bundleSha256: receipt.descriptor.bundleSha256,
    profileSha256: receipt.descriptor.profileSha256,
    jpeg: { byteLength: artifacts.jpeg.byteLength, sha256: artifacts.jpegSha256 },
    plt: { byteLength: artifacts.plt.byteLength, sha256: artifacts.pltSha256 },
    mediaSize: profile.mediaSize,
    mediaType: profile.mediaType,
    knifePressure: profile.knifePressure,
    copies: profile.copies,
  };
  const summary = {
    approvalFingerprint: sha256(JSON.stringify(evidence)),
    label: options.label,
    media: '4x7 Liene adhesive photo paper',
    profileId: profile.id,
    knifePressure: profile.knifePressure,
    copies: profile.copies,
    stickerCount: artifacts.cutStats.pathCount,
    cutExpansion: {
      pixels: cutExpansionPixels,
      millimeters: Number(((cutExpansionPixels * 25.4) / 300).toFixed(4)),
    },
    raster: { width: profile.rasterWidthPx, height: profile.rasterHeightPx },
    jpeg: evidence.jpeg,
    plt: evidence.plt,
    bundleSha256: evidence.bundleSha256,
    profileSha256: evidence.profileSha256,
    ...(options.sourceImageSha256 ? { sourceImageSha256: options.sourceImageSha256 } : {}),
  };
  const binding = {
    submissionId: `physical-proof-${receipt.descriptor.bundleSha256.slice(0, 24)}`,
    eventId: 'local-physical-proof',
    workerId: 'local-operator-webapp',
    executionToken: options.designVersion,
    manifestHash: sha256(options.designVersion),
    receipt,
  };
  return { artifacts, binding, summary, cutPreviewSvg: buildCutPreviewSvg(artifacts.jpeg, artifacts.plt) };
}

export async function buildPhysicalProof() {
  return buildFromRasters(proofRasters(), {
    designVersion: diagnosticDesignVersion,
    label: 'Six-circle diagnostic',
  });
}

export async function buildPhysicalProofFromPng(
  pngBytes: Uint8Array,
  { label = 'Physical proof sheet' }: { label?: string } = {},
) {
  const input = Buffer.from(pngBytes);
  const metadata = await sharp(input, { limitInputPixels: 20_000_000 }).metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height || metadata.width * 7 !== metadata.height * 4) {
    throw new Error('Physical proof image must be a PNG with an exact 4x7 aspect ratio.');
  }
  const profile = DEVFEST_SG_V1;
  const source = await loadRgbaAsset(input, 'physical-proof', 20_000_000);
  const rgb = new Uint8Array(await sharp(Buffer.from(source.rgba), { raw: { width: source.width, height: source.height, channels: 4 } })
    .flatten({ background: { r: 247, g: 243, b: 235 } })
    .resize(profile.sheetWidthPx, profile.sheetHeightPx, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer());
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  for (let pixel = 0; pixel < profile.sheetWidthPx * profile.sheetHeightPx; pixel += 1) {
    rgba.set([rgb[pixel * 3]!, rgb[pixel * 3 + 1]!, rgb[pixel * 3 + 2]!, 255], pixel * 4);
  }
  return buildFromRasters(
    { rgba, colorEvidence: source.colorEvidence, mask: maskOpaqueSheet(rgb, profile.sheetWidthPx, profile.sheetHeightPx) },
    { designVersion: imageDesignVersion, label, sourceImageSha256: sha256Bytes(input) },
  );
}
