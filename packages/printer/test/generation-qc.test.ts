import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import * as printer from '../src/index.ts';
import type { CanonicalPrintPreview } from '../src/index.ts';

const width = 256;
const height = 192;
function reference(): CanonicalPrintPreview {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set([40 + (x >> 1), 210 - (y >> 1), 190], (y * width + x) * 3);
  }
  return { kind: 'srgb-rgb8-preview', width, height, channels: 3, data };
}

function asJpeg(pixels: Uint8Array, w = width, h = height) {
  return sharp(pixels, { raw: { width: w, height: h, channels: 3 } })
    .withIccProfile('srgb').jpeg({ quality: 90 }).toBuffer();
}

describe('final JPEG generation QC', () => {
  it('accepts genuine lossy encoding and records worst-pixel coordinates and decoded values', async () => {
    const preview = reference();
    const qc = await printer.verifyPrintJpeg(preview, await asJpeg(preview.data));
    expect(qc).toMatchObject({ version: 'natcut-jpeg-qc-v1', passed: true, reasons: [] });
    const { x, y, expected, actual, delta } = qc.worstPixel;
    const offset = 3 * (y * width + x);
    expect(expected).toEqual([...preview.data.subarray(offset, offset + 3)]);
    expect(Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel]!)))).toBe(delta);
    expect(delta).toBeGreaterThan(0);
  });

  it.each(['swap', 'drift', 'red contour'] as const)('blocks a %s in encoded print pixels', async (change) => {
    const preview = reference();
    const pixels = Buffer.from(preview.data);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = 3 * (y * width + x);
      if (change === 'swap') [pixels[i], pixels[i + 2]] = [pixels[i + 2]!, pixels[i]!];
      if (change === 'drift') {
        for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(255 * (pixels[i + c]! / 255) ** 1.55);
      }
      if (change === 'red contour' && x >= 96 && x < 128 && y >= 48 && y < 80 &&
          (x < 99 || x >= 125 || y < 51 || y >= 77)) pixels.set([255, 49, 92], i);
    }
    await expect(printer.verifyPrintJpeg(preview, await asJpeg(pixels))).rejects.toMatchObject({
      code: 'jpeg_fidelity_failed',
      details: { passed: false, reasons: expect.arrayContaining([change === 'red contour' ? 'tile_color_bias' : 'mean_error']),
        worstPixel: { delta: expect.any(Number), x: expect.any(Number), y: expect.any(Number) } },
    });
  });

  it('measures RGB errors in integer thousandths, nearest-rank p99 and parts per million', () => {
    const preview = { ...reference(), width: 10, height: 10, data: Buffer.alloc(300) };
    const data = Buffer.from(preview.data);
    data.set([40, 12, 0], 297);
    const result = printer.compareDecodedPreview(preview, { width: 10, height: 10, channels: 3, data });
    expect(result).toMatchObject({ maeMilli: [400, 120, 0], p99: 0, highErrorPpm: 10_000, worstTileBias: 1,
      worstPixel: { x: 9, y: 9, actual: [40, 12, 0], expected: [0, 0, 0], delta: 40 } });
  });

  it('rejects an incorrect raster size, non-RGB data, an untagged JPEG and undecodable bytes', async () => {
    const preview = reference();
    await expect(printer.verifyPrintJpeg(preview, await asJpeg(preview.data, width / 2, height)))
      .rejects.toMatchObject({ code: 'raster_size_mismatch', details: { actual: [128, 192], expected: [256, 192] } });
    await expect(printer.verifyPrintJpeg(preview, await asJpeg(Buffer.alloc((width + 1) * height * 3), width + 1, height)))
      .rejects.toMatchObject({ code: 'raster_size_mismatch', details: { actual: [257, 192] } });
    const sixteenBit = new Uint16Array(width * height * 3);
    expect(() => printer.compareDecodedPreview(preview, { width, height, channels: 3, data: sixteenBit as unknown as Uint8Array }))
      .toThrow(expect.objectContaining({ code: 'channel_mismatch' }));
    const grey = await sharp(preview.data, { raw: preview }).toColourspace('b-w').jpeg().toBuffer();
    await expect(printer.verifyPrintJpeg(preview, grey)).rejects.toMatchObject({ code: 'channel_mismatch' });
    const untagged = await sharp(preview.data, { raw: preview }).jpeg().toBuffer();
    await expect(printer.verifyPrintJpeg(preview, untagged)).rejects.toMatchObject({ code: 'jpeg_color_profile' });
    await expect(printer.verifyPrintJpeg(preview, Buffer.from('<svg/>'))).rejects.toMatchObject({ code: 'jpeg_decode_failed' });
    expect(() => printer.compareDecodedPreview(preview, { width, height, channels: 3, data: new Uint8Array(2) }))
      .toThrow(expect.objectContaining({ code: 'raster_length_mismatch' }));
  });
});
