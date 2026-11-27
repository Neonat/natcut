import { createHash } from 'node:crypto';
import { parseArtifactReceipt, verifyArtifactBytes, type VerifiedArtifact } from '@natcut/artifacts/reader';
import { decodeLogicalSourceBundle, type SrgbColorEvidence, type PrintProfile } from '@natcut/domain';
import sharp from 'sharp';
import { findContours } from '../../../vendor/pixcut-trace/contours.ts';
import { generateCutPath, type GenerateOptions } from '../../../vendor/pixcut-trace/generate.ts';
import { CUT_CANVAS } from '../../../vendor/pixcut-trace/units.ts';
import type { PltStats } from '../../../vendor/pixcut-trace/plt.ts';
import { verifyPrintJpeg, type CanonicalPrintPreview, type GenerationQcResult } from './generation-qc.ts';
export { preparePhysicalArtifacts } from './prepared-evidence.ts';

export const jpegQualities = [95, 92, 90, 85, 80, 75, 70, 60, 50] as const;

export type PreparedPrintArtifact = {
  readonly kind: 'print-raster-jpeg';
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly quality: number;
  readonly preview: CanonicalPrintPreview;
  readonly colorEvidence: SrgbColorEvidence;
  readonly generationQc: GenerationQcResult;
};
export type PreparedCutArtifact = {
  readonly kind: 'cut-path-plt';
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly sourceMaskSha256: string;
  readonly stats: PltStats;
};
export type PreparedPhysicalArtifacts = {
  readonly receipt: VerifiedArtifact['receipt'];
  readonly profile: Readonly<PrintProfile>;
  readonly print: PreparedPrintArtifact;
  readonly cut: PreparedCutArtifact;
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function centeredPadding(profile: PrintProfile) {
  const horizontal = profile.rasterWidthPx - profile.sheetWidthPx;
  const vertical = profile.rasterHeightPx - profile.sheetHeightPx;
  if (horizontal < 0 || vertical < 0 || horizontal % 2 !== 0 || vertical % 2 !== 0) {
    throw new Error('Printer raster padding must be non-negative, centered, and integral.');
  }
  return { left: horizontal / 2, right: horizontal / 2, top: vertical / 2, bottom: vertical / 2 };
}

export async function buildCanonicalPreview(rgba: Uint8Array, profile: PrintProfile): Promise<CanonicalPrintPreview> {
  const sheet = { width: profile.sheetWidthPx, height: profile.sheetHeightPx, channels: 4 as const };
  if (rgba.length !== sheet.width * sheet.height * sheet.channels) throw new Error('Expected sheet-sized RGBA8 print input.');
  const { data, info } = await sharp(rgba, { raw: sheet })
    .flatten({ background: '#ffffff' })
    .extend({ ...centeredPadding(profile), background: '#ffffff' })
    .toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.width !== profile.rasterWidthPx || info.height !== profile.rasterHeightPx || info.channels !== 3) {
    throw new Error('Expected a profile-sized sRGB RGB8 preview.');
  }
  return { kind: 'srgb-rgb8-preview', width: info.width, height: info.height, channels: 3, data };
}

export function encodePreviewAtQuality(preview: CanonicalPrintPreview, quality: typeof jpegQualities[number]) {
  return sharp(preview.data, { raw: { width: preview.width, height: preview.height, channels: preview.channels } })
    .withIccProfile('srgb')
    .jpeg({ quality, chromaSubsampling: '4:2:0', progressive: false, mozjpeg: false }).toBuffer();
}

async function preparePrint(rgba: Uint8Array, colorEvidence: SrgbColorEvidence, profile: PrintProfile): Promise<PreparedPrintArtifact> {
  const preview = await buildCanonicalPreview(rgba, profile);
  for (const quality of jpegQualities) {
    const bytes = await encodePreviewAtQuality(preview, quality);
    if (bytes.byteLength <= profile.jpegMaxBytes) {
      const generationQc = await verifyPrintJpeg(preview, bytes);
      return { kind: 'print-raster-jpeg', bytes, sha256: sha256(bytes), quality, preview, colorEvidence, generationQc };
    }
  }
  throw new Error(`JPEG cannot fit within ${profile.jpegMaxBytes} bytes (1 MiB profile limit).`);
}

function maskRaster(mask: Uint8Array, profile: PrintProfile) {
  if (!mask.includes(255)) throw new Error('Verified cut mask contains nothing to cut.');
  const data = new Uint8Array(mask.byteLength * 4);
  for (let index = 0; index < mask.byteLength; index++) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = mask[index]!;
  }
  return { width: profile.sheetWidthPx, height: profile.sheetHeightPx, data };
}

function prepareCut(mask: Uint8Array, profile: PrintProfile): PreparedCutArtifact {
  if (!Number.isInteger(profile.knifePressure) || profile.knifePressure < 1 || profile.knifePressure > 100) {
    throw new Error('Knife pressure must be an integer from 1 through 100.');
  }
  const traceOptions: GenerateOptions & { clip: boolean } = {
    binarize: { mode: 'alpha', alphaThreshold: profile.alphaThreshold },
    dilation: 0,
    knifePressure: profile.knifePressure,
    minArea: 0,
    chainApproximation: 'none',
    includeHoles: profile.cutHoles,
    maxContours: 65,
    fillMethod: 'fit',
    scaleRatio: 1,
    clip: false,
  };
  const accepted = findContours(
    { width: profile.sheetWidthPx, height: profile.sheetHeightPx, data: mask },
    {
      minArea: 0,
      chainApproximation: 'none',
      includeHoles: profile.cutHoles,
      maxContours: 65,
    },
  );
  const expectedPathCount = accepted.reduce(
    (count, contour) => count + 1 + (profile.cutHoles ? contour.inners.length : 0),
    0,
  );
  const result = generateCutPath(maskRaster(mask, profile), traceOptions);
  if (result.document.paths.length === 0) throw new Error('Verified cut mask contains nothing to cut.');
  if (result.document.paths.length !== expectedPathCount) {
    throw new Error('Generated PLT lost accepted cut contours.');
  }
  for (const path of result.document.paths) {
    for (const point of path) {
      if (point.x < 0 || point.x > CUT_CANVAS.widthUnits || point.y < 0 || point.y > CUT_CANVAS.heightUnits) {
        throw new Error('Generated cut path escapes the published sheet.');
      }
    }
  }
  const bytes = new TextEncoder().encode(result.plt);
  return { kind: 'cut-path-plt', bytes, sha256: sha256(bytes), sourceMaskSha256: sha256(mask), stats: result.stats };
}

export async function generateVerifiedPhysicalOutputs(input: VerifiedArtifact) {
  const receipt = parseArtifactReceipt(input.receipt);
  const verified = await verifyArtifactBytes(input.bytes, receipt);
  const decoded = await decodeLogicalSourceBundle(verified.bytes, verified.receipt.descriptor);
  const profile = decoded.descriptor.profile;
  if (decoded.descriptor.formatVersion !== 2) throw new Error('Physical generation requires trusted sRGB color evidence.');
  const cut = prepareCut(decoded.mask, profile);
  const print = await preparePrint(decoded.rgba, decoded.descriptor.colorEvidence, profile);
  return { receipt: verified.receipt, print, cut };
}
