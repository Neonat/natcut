import { createHash } from 'node:crypto';
import { verifyArtifactBytes } from '@natcut/artifacts/reader';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '@natcut/domain';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { pathToPixels } from '../../../vendor/pixcut-trace/transform.ts';
import { preparePhysicalArtifacts, type PreparedPhysicalArtifacts } from './artifacts.ts';

const diagnosticDesignVersion = 'natcut-six-circle-physical-proof-v1';
const inkRadiusPixels = 225;
const cutExpansionPixels = 20;
const cutRadiusPixels = inkRadiusPixels + cutExpansionPixels;
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
        if (distanceSquared <= cutRadiusPixels ** 2) mask[pixel] = 255;
        if (distanceSquared <= inkRadiusPixels ** 2) {
          const color = colors[sticker]!;
          rgba.set([color[0], color[1], color[2], 255], pixel * 4);
        }
      }
    }
  }
  return { rgba, mask, colorEvidence: NATIVE_SRGB_EVIDENCE };
}
function svgPath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
}

function buildCutPreviewSvg({ print, cut }: PreparedPhysicalArtifacts) {
  const profile = DEVFEST_SG_V1;
  const paddingX = (profile.rasterWidthPx - profile.sheetWidthPx) / 2;
  const paddingY = (profile.rasterHeightPx - profile.sheetHeightPx) / 2;
  const document = parsePlt(new TextDecoder().decode(cut.bytes));
  const paths = document.paths.map((path) => pathToPixels(
    path,
    profile.sheetWidthPx,
    profile.sheetHeightPx,
    { fillMethod: 'fit', scaleRatio: 1 },
  ));
  const serialized = paths.map((path) =>
    `<path d="${svgPath(path)}" fill="none" stroke="#ff315c" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${profile.rasterWidthPx}" height="${profile.rasterHeightPx}" viewBox="0 0 ${profile.rasterWidthPx} ${profile.rasterHeightPx}" role="img" aria-label="Blade path overlay"><title>Blade path overlay; red lines are the exact PLT trajectories</title><image width="${profile.rasterWidthPx}" height="${profile.rasterHeightPx}" href="data:image/jpeg;base64,${Buffer.from(print.bytes).toString('base64')}"/><g transform="translate(${paddingX} ${paddingY})">${serialized}</g></svg>`;
}

export async function buildPhysicalProof() {
  const profile = DEVFEST_SG_V1;
  const bundle = await encodeLogicalSourceBundle({
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    profile,
    renderVersion: diagnosticDesignVersion,
    geometryVersion: diagnosticDesignVersion,
    ...proofRasters(),
  });
  const receipt = { descriptor: bundle.descriptor, generation: '1' };
  const verified = await verifyArtifactBytes(bundle.bytes, receipt);
  const artifacts = await preparePhysicalArtifacts(verified);
  const evidence = {
    designVersion: diagnosticDesignVersion,
    sourceImageSha256: null,
    bundleSha256: receipt.descriptor.bundleSha256,
    profileSha256: receipt.descriptor.profileSha256,
    jpeg: { byteLength: artifacts.print.bytes.byteLength, sha256: artifacts.print.sha256 },
    plt: { byteLength: artifacts.cut.bytes.byteLength, sha256: artifacts.cut.sha256 },
    mediaSize: profile.mediaSize,
    mediaType: profile.mediaType,
    knifePressure: profile.knifePressure,
    copies: profile.copies,
  };
  const summary = {
    approvalFingerprint: sha256(JSON.stringify(evidence)),
    label: 'Six-circle diagnostic',
    media: '4x7 Liene adhesive photo paper',
    profileId: profile.id,
    knifePressure: profile.knifePressure,
    copies: profile.copies,
    stickerCount: artifacts.cut.stats.pathCount,
    cutExpansion: {
      pixels: cutExpansionPixels,
      millimeters: Number(((cutExpansionPixels * 25.4) / 300).toFixed(4)),
    },
    raster: { width: profile.rasterWidthPx, height: profile.rasterHeightPx },
    jpeg: evidence.jpeg,
    plt: evidence.plt,
    bundleSha256: evidence.bundleSha256,
    profileSha256: evidence.profileSha256,
    colorEvidence: artifacts.print.colorEvidence,
    generationQc: artifacts.print.generationQc,
  };
  const binding = {
    submissionId: `physical-proof-${receipt.descriptor.bundleSha256.slice(0, 24)}`,
    eventId: 'local-physical-proof',
    workerId: 'local-operator-webapp',
    executionToken: diagnosticDesignVersion,
    manifestHash: sha256(diagnosticDesignVersion),
    receipt,
  };
  return { artifacts, binding, summary, cutPreviewSvg: buildCutPreviewSvg(artifacts) };
}
