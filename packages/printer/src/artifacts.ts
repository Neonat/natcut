import { createHash } from 'node:crypto';
import { parseArtifactReceipt, verifyArtifactBytes, type VerifiedArtifact } from '@natcut/artifacts/reader';
import { decodeLogicalSourceBundle, type PrintProfile } from '@natcut/domain';
import sharp from 'sharp';
import { findContours } from '../../../vendor/pixcut-trace/contours.ts';
import { generateCutPath, type GenerateOptions } from '../../../vendor/pixcut-trace/generate.ts';
import { CUT_CANVAS } from '../../../vendor/pixcut-trace/units.ts';
import type { PltStats } from '../../../vendor/pixcut-trace/plt.ts';

const jpegQualities = [95, 92, 90, 85, 80, 75, 70, 60, 50] as const;

export type PreparedPhysicalArtifacts = {
  receipt: VerifiedArtifact['receipt'];
  profile: Readonly<PrintProfile>;
  jpeg: Uint8Array;
  jpegSha256: string;
  jpegQuality: number;
  plt: Uint8Array;
  pltSha256: string;
  sourceMaskSha256: string;
  cutStats: PltStats;
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

export async function encodePrinterJpeg(rgba: Uint8Array, profile: PrintProfile) {
  const padding = centeredPadding(profile);
  for (const quality of jpegQualities) {
    const encoded = await sharp(Buffer.from(rgba), {
      raw: { width: profile.sheetWidthPx, height: profile.sheetHeightPx, channels: 4 },
      limitInputPixels: profile.sheetWidthPx * profile.sheetHeightPx,
    })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .extend({ ...padding, background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality, chromaSubsampling: '4:2:0', progressive: false, mozjpeg: false })
      .toBuffer();
    if (encoded.byteLength <= profile.jpegMaxBytes) {
      return { bytes: new Uint8Array(encoded), quality };
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

function encodeCut(mask: Uint8Array, profile: PrintProfile) {
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
  return { bytes: new TextEncoder().encode(result.plt), stats: result.stats };
}

export async function preparePhysicalArtifacts(input: VerifiedArtifact): Promise<PreparedPhysicalArtifacts> {
  const receipt = parseArtifactReceipt(input.receipt);
  const verified = await verifyArtifactBytes(input.bytes, receipt);
  const decoded = await decodeLogicalSourceBundle(verified.bytes, verified.receipt.descriptor);
  const profile = decoded.descriptor.profile;
  const cut = encodeCut(decoded.mask, profile);
  const jpeg = await encodePrinterJpeg(decoded.rgba, profile);
  return {
    receipt: verified.receipt,
    profile,
    jpeg: jpeg.bytes,
    jpegSha256: sha256(jpeg.bytes),
    jpegQuality: jpeg.quality,
    plt: cut.bytes,
    pltSha256: sha256(cut.bytes),
    sourceMaskSha256: decoded.descriptor.maskSha256,
    cutStats: cut.stats,
  };
}
