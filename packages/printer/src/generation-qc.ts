import { createHash } from 'node:crypto';
import { isUint8Array } from 'node:util/types';
import { recognizedIccSpace } from '@natcut/domain';
import sharp from 'sharp';

export type CanonicalPrintPreview = {
  readonly kind: 'srgb-rgb8-preview';
  readonly width: number;
  readonly height: number;
  readonly channels: 3;
  readonly data: Uint8Array;
};

type DecodedRaster = { width: number; height: number; channels: number; data: Uint8Array };
type Rgb = [number, number, number];
type FidelityReason = 'mean_error' | 'tail_error' | 'high_error_fraction' | 'tile_color_bias';
type QcErrorCode = 'raster_size_mismatch' | 'channel_mismatch' | 'raster_length_mismatch'
  | 'jpeg_decode_failed' | 'jpeg_color_profile' | 'jpeg_fidelity_failed';

export const JPEG_QC_LIMITS = Object.freeze({ maeMilli: 19_313, p99: 96, highErrorPpm: 201_249, worstTileBias: 9 });
export type GenerationQcResult = ReturnType<typeof compareDecodedPreview>;

class GenerationQcError extends Error {
  constructor(readonly code: QcErrorCode, readonly details: object) {
    super(`Print generation QC failed (${code}): ${JSON.stringify(details)}`);
  }
}

function checkShape(preview: CanonicalPrintPreview, actual: Omit<DecodedRaster, 'data'>) {
  if (!Number.isSafeInteger(preview.width) || !Number.isSafeInteger(preview.height) ||
      preview.width <= 0 || preview.height <= 0 || actual.width !== preview.width || actual.height !== preview.height) {
    throw new GenerationQcError('raster_size_mismatch', { expected: [preview.width, preview.height], actual: [actual.width, actual.height] });
  }
  if (preview.kind !== 'srgb-rgb8-preview' || preview.channels !== 3 || actual.channels !== 3) {
    throw new GenerationQcError('channel_mismatch', { expected: 'sRGB RGB8', actual: actual.channels });
  }
}

export function compareDecodedPreview(preview: CanonicalPrintPreview, decoded: DecodedRaster) {
  checkShape(preview, decoded);
  const { width, height } = preview;
  const count = width * height;
  if (!isUint8Array(preview.data) || !isUint8Array(decoded.data)) {
    throw new GenerationQcError('channel_mismatch', { expected: 'sRGB RGB8 byte buffers' });
  }
  if (preview.data.length !== count * 3 || decoded.data.length !== count * 3) {
    throw new GenerationQcError('raster_length_mismatch', {
      expected: count * 3, preview: preview.data.length, decoded: decoded.data.length,
    });
  }
  const sums: Rgb = [0, 0, 0];
  const histogram = new Uint32Array(256);
  let highErrors = 0, worstIndex = 0, worstDelta = 0, worstTileBias = 0;
  // Whole-sheet averages can hide a small contour. Signed mean error in a JPEG
  // 4:2:0 MCU (16x16 pixels) distinguishes local color shifts from codec noise.
  for (let top = 0; top < height; top += 16) for (let left = 0; left < width; left += 16) {
    const bottom = Math.min(top + 16, height), right = Math.min(left + 16, width);
    const bias: Rgb = [0, 0, 0];
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = 3 * (y * width + x);
      let delta = 0;
      for (let c = 0; c < 3; c++) {
        const error = decoded.data[i + c]! - preview.data[i + c]!;
        bias[c]! += error;
        sums[c]! += Math.abs(error);
        delta = Math.max(delta, Math.abs(error));
      }
      histogram[delta]!++;
      if (delta > 32) highErrors++;
      if (delta > worstDelta) { worstDelta = delta; worstIndex = i / 3; }
    }
    const tilePixels = (bottom - top) * (right - left);
    for (const sum of bias) worstTileBias = Math.max(worstTileBias, Math.ceil(Math.abs(sum) / tilePixels));
  }
  const rank = Math.ceil(count * 99 / 100);
  let p99 = 0, cumulative = histogram[0]!;
  while (cumulative < rank) cumulative += histogram[++p99]!;
  const maeMilli = sums.map(sum => Math.ceil(sum * 1000 / count));
  const highErrorPpm = Math.ceil(highErrors * 1_000_000 / count);
  const reasons: FidelityReason[] = [];
  if (Math.max(...maeMilli) > JPEG_QC_LIMITS.maeMilli) reasons.push('mean_error');
  if (p99 > JPEG_QC_LIMITS.p99) reasons.push('tail_error');
  if (highErrorPpm > JPEG_QC_LIMITS.highErrorPpm) reasons.push('high_error_fraction');
  if (worstTileBias > JPEG_QC_LIMITS.worstTileBias) reasons.push('tile_color_bias');
  const start = worstIndex * 3;
  const worstPixel = Object.freeze({
    x: worstIndex % width, y: Math.floor(worstIndex / width), delta: worstDelta,
    expected: Object.freeze(Array.from(preview.data.subarray(start, start + 3))),
    actual: Object.freeze(Array.from(decoded.data.subarray(start, start + 3))),
  });
  return Object.freeze({
    version: 'natcut-jpeg-qc-v1' as const,
    previewSha256: createHash('sha256').update(preview.data).digest('hex'),
    passed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    limits: JPEG_QC_LIMITS,
    maeMilli: Object.freeze(maeMilli), p99, highErrorPpm, worstTileBias, worstPixel,
  });
}

export async function verifyPrintJpeg(preview: CanonicalPrintPreview, jpeg: Uint8Array): Promise<GenerationQcResult> {
  try {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new GenerationQcError('jpeg_decode_failed', { expected: 'JPEG' });
    const input = Buffer.from(jpeg);
    // Inspect the header before the bounded pixel decode so even oversized dimensions
    // have a stable reason and can be reported without allocating the raster.
    const meta = await sharp(input, { failOn: 'warning', limitInputPixels: false }).metadata();
    if (meta.format !== 'jpeg') throw new GenerationQcError('jpeg_decode_failed', { format: meta.format });
    checkShape(preview, meta);
    const profileSha256 = meta.icc && createHash('sha256').update(meta.icc).digest('hex');
    if (!profileSha256 || recognizedIccSpace(profileSha256) !== 'srgb' || meta.space !== 'srgb') {
      throw new GenerationQcError('jpeg_color_profile', { expected: 'embedded sRGB ICC', profileSha256 });
    }
    const image = sharp(input, { failOn: 'warning', limitInputPixels: preview.width * preview.height });
    const { data, info } = await image.withIccProfile('srgb', { attach: false })
      .toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const result = compareDecodedPreview(preview, { ...info, data });
    if (!result.passed) throw new GenerationQcError('jpeg_fidelity_failed', result);
    return result;
  } catch (error) {
    if (error instanceof GenerationQcError) throw error;
    throw new GenerationQcError('jpeg_decode_failed', { error: String(error) });
  }
}
