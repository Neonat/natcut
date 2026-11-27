import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { verifyArtifactBytes, type VerifiedArtifact } from '@natcut/artifacts';
import { DEVFEST_SG_V1, encodeLogicalSourceBundle } from '@natcut/domain';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { encodePrinterJpeg, preparePhysicalArtifacts } from '../src/index.ts';

const profile = DEVFEST_SG_V1;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fixtureBytes(noise = false) {
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
  let random = 0x12345678;
  for (let y = 0; y < profile.sheetHeightPx; y++) {
    for (let x = 0; x < profile.sheetWidthPx; x++) {
      const pixel = y * profile.sheetWidthPx + x;
      const offset = pixel * 4;
      if (noise) {
        random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
        rgba[offset] = random & 255;
        rgba[offset + 1] = (random >>> 8) & 255;
        rgba[offset + 2] = (random >>> 16) & 255;
        rgba[offset + 3] = 255;
      } else if (x >= 300 && x < 400 && y >= 500 && y < 600) {
        rgba.set([240, 20, 30, 255], offset);
      }
      if (x >= 300 && x < 400 && y >= 500 && y < 600) mask[pixel] = 255;
    }
  }
  return { rgba, mask };
}

async function artifact(options: { noise?: boolean; emptyMask?: boolean } = {}): Promise<VerifiedArtifact> {
  const source = fixtureBytes(options.noise);
  if (options.emptyMask) source.mask.fill(0);
  const bundle = await encodeLogicalSourceBundle({
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    profile,
    renderVersion: 'server-raster-v1',
    geometryVersion: 'geometry-v1',
    ...source,
  });
  return verifyArtifactBytes(bundle.bytes, { descriptor: bundle.descriptor, generation: '1' });
}

async function customArtifact(
  paint: (rgba: Uint8Array, mask: Uint8Array) => void,
  generation = '1',
): Promise<VerifiedArtifact> {
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
  paint(rgba, mask);
  const bundle = await encodeLogicalSourceBundle({
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    profile,
    renderVersion: 'server-raster-v1',
    geometryVersion: 'geometry-v1',
    rgba,
    mask,
  });
  return { receipt: { descriptor: bundle.descriptor, generation }, bytes: bundle.bytes };
}

function fillRect(rgba: Uint8Array, mask: Uint8Array, left: number, top: number, width: number, height: number) {
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
    const pixel = y * profile.sheetWidthPx + x;
    rgba.set([40, 170, 80, 255], pixel * 4);
    mask[pixel] = 255;
  }
}

function fillBlackWhiteNoise(rgba: Uint8Array) {
  let state = 54321;
  for (let pixel = 0; pixel < profile.sheetWidthPx * profile.sheetHeightPx; pixel++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const value = state < 0 ? 0 : 255;
    rgba.set([value, value, value, 255], pixel * 4);
  }
}

describe('preparePhysicalArtifacts', () => {
  it('creates a bounded printer JPEG with centered opaque white padding', async () => {
    const prepared = await preparePhysicalArtifacts(await artifact());
    const image = sharp(prepared.jpeg);
    expect(await image.metadata()).toMatchObject({
      format: 'jpeg', width: 1216, height: 2128,
    });
    expect(prepared.jpeg.byteLength).toBeLessThanOrEqual(profile.jpegMaxBytes);
    expect(prepared.jpegSha256).toBe(sha256(prepared.jpeg));
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
    const red = ((14 + 550) * 1216 + 8 + 350) * 3;
    expect(data[red]).toBeGreaterThan(220);
    expect(data[red + 1]).toBeLessThan(50);
    expect(data[red + 2]).toBeLessThan(60);
  });

  it('derives a bounded KP42 PLT from the exact stored expanded mask without another margin', async () => {
    const input = await artifact();
    const prepared = await preparePhysicalArtifacts(input);
    const document = parsePlt(new TextDecoder().decode(prepared.plt));
    expect(document.knifePressure).toBe(42);
    expect(document.paths).toHaveLength(1);
    expect(prepared.pltSha256).toBe(sha256(prepared.plt));
    expect(prepared.sourceMaskSha256).toBe(input.receipt.descriptor.maskSha256);
    expect(document.paths[0]).toEqual(expect.arrayContaining([
      { x: 1016, y: 5415 }, { x: 1351, y: 5415 },
      { x: 1351, y: 5080 }, { x: 1016, y: 5080 },
    ]));
    for (const path of document.paths) {
      for (const point of path) {
        expect(point.x).toBeGreaterThanOrEqual(950);
        expect(point.x).toBeLessThanOrEqual(1400);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(4064);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(7112);
      }
    }
  });

  it('re-verifies the immutable bytes instead of trusting the VerifiedArtifact type', async () => {
    const input = await artifact();
    input.bytes[0] = input.bytes[0]! ^ 255;
    await expect(preparePhysicalArtifacts(input)).rejects.toThrow(/artifact|digest/i);
  });

  it('rejects an empty accepted cut mask', async () => {
    await expect(preparePhysicalArtifacts(await artifact({ emptyMask: true }))).rejects.toThrow(/nothing to cut/i);
  });

  it('preserves every accepted mask island instead of applying the stock minimum-area filter', async () => {
    const input = await customArtifact((rgba, mask) => {
      fillRect(rgba, mask, 300, 500, 100, 100);
      fillRect(rgba, mask, 700, 900, 24, 24);
    });
    const document = parsePlt(new TextDecoder().decode((await preparePhysicalArtifacts(input)).plt));
    expect(document.paths).toHaveLength(2);
  });

  it('rejects an edge path whose unclipped lead-in escapes the sheet', async () => {
    const input = await customArtifact((rgba, mask) => fillRect(rgba, mask, 0, 0, 100, 100));
    await expect(preparePhysicalArtifacts(input)).rejects.toThrow(/escapes the published sheet/i);
  });

  it('parses the whole receipt before preparing evidence', async () => {
    const input = await artifact();
    input.receipt = { ...input.receipt, generation: '0' };
    await expect(preparePhysicalArtifacts(input)).rejects.toThrow(/receipt|generation/i);
  });

  it('does not leave an unhandled JPEG rejection when cut validation fails first', async () => {
    const input = await customArtifact((rgba) => fillBlackWhiteNoise(rgba));
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', capture);
    try {
      await expect(preparePhysicalArtifacts(input)).rejects.toThrow(/nothing to cut/i);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
    }
  }, 10_000);

  it('white-composites colored transparent pixels and all four padding borders before JPEG encoding', async () => {
    const input = await customArtifact((rgba, mask) => {
      rgba.set([255, 0, 0, 0], 0);
      fillRect(rgba, mask, 500, 700, 60, 60);
    });
    const prepared = await preparePhysicalArtifacts(input);
    const { data, info } = await sharp(prepared.jpeg).raw().toBuffer({ resolveWithObject: true });
    const sample = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(sample(600, 0)).toEqual([255, 255, 255]);
    expect(sample(600, 2127)).toEqual([255, 255, 255]);
    expect(sample(0, 1000)).toEqual([255, 255, 255]);
    expect(sample(1215, 1000)).toEqual([255, 255, 255]);
    expect(sample(8, 14)).toEqual([255, 255, 255]);
  });

  it('fails when fixed quality attempts cannot fit a complex image under one MiB', async () => {
    const source = fixtureBytes(true);
    await expect(encodePrinterJpeg(source.rgba, { ...profile, jpegMaxBytes: 1024 }))
      .rejects.toThrow(/1024|JPEG/i);
  });
});
