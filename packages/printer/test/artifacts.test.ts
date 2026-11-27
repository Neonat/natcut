import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { verifyArtifactBytes, type VerifiedArtifact } from '@natcut/artifacts';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '@natcut/domain';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { preparePhysicalArtifacts } from '../src/index.ts';

const profile = DEVFEST_SG_V1;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function artifact(options: { emptyMask?: boolean } = {}): Promise<VerifiedArtifact> {
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
  for (let y = 500; y < 600; y++) for (let x = 300; x < 400; x++) {
    const pixel = y * profile.sheetWidthPx + x;
    rgba.set([240, 20, 30, 255], pixel * 4);
    mask[pixel] = 255;
  }
  if (options.emptyMask) mask.fill(0);
  const bundle = await encodeLogicalSourceBundle({
    colorEvidence: NATIVE_SRGB_EVIDENCE,
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    profile,
    renderVersion: 'server-raster-v1',
    geometryVersion: 'geometry-v1',
    rgba, mask,
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
    colorEvidence: NATIVE_SRGB_EVIDENCE,
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
    const image = sharp(prepared.print.bytes);
    expect(await image.metadata()).toMatchObject({
      format: 'jpeg', width: 1216, height: 2128, channels: 3, hasProfile: true,
    });
    expect(prepared.print.bytes.byteLength).toBeLessThanOrEqual(profile.jpegMaxBytes);
    expect(prepared.print.sha256).toBe(sha256(prepared.print.bytes));
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
    const document = parsePlt(new TextDecoder().decode(prepared.cut.bytes));
    expect(document.knifePressure).toBe(42);
    expect(document.paths).toHaveLength(1);
    expect(prepared.cut.sha256).toBe(sha256(prepared.cut.bytes));
    expect(prepared.cut.sourceMaskSha256).toBe(input.receipt.descriptor.maskSha256);
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
    const document = parsePlt(new TextDecoder().decode((await preparePhysicalArtifacts(input)).cut.bytes));
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
    const { data, info } = await sharp(prepared.print.bytes).raw().toBuffer({ resolveWithObject: true });
    const sample = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(sample(600, 0)).toEqual([255, 255, 255]);
    expect(sample(600, 2127)).toEqual([255, 255, 255]);
    expect(sample(0, 1000)).toEqual([255, 255, 255]);
    expect(sample(1215, 1000)).toEqual([255, 255, 255]);
    expect(sample(8, 14)).toEqual([255, 255, 255]);
  });

  it('keeps mask-only changes out of every print pixel and color-only changes out of every cut byte', async () => {
    async function build(shift: number, green: number) {
      return preparePhysicalArtifacts(await customArtifact((rgba, mask) => {
        for (let y = 500; y < 580; y++) for (let x = 300; x < 380; x++) {
          const pixel = y * profile.sheetWidthPx + x;
          rgba.set([25, green, 100, 128], pixel * 4);
          mask[pixel + shift] = 255;
        }
      }));
    }
    const original = await build(0, 140);
    const maskOnly = await build(27, 140);
    const colorOnly = await build(0, 20);
    expect(original.print.kind).toBe('print-raster-jpeg');
    expect(original.cut.kind).toBe('cut-path-plt');
    expect(original.print.preview).toMatchObject({ width: 1216, height: 2128, channels: 3 });
    expect(original.print.colorEvidence).toEqual(NATIVE_SRGB_EVIDENCE);
    expect(original.print.generationQc).toMatchObject({ version: 'natcut-jpeg-qc-v1', passed: true });
    expect(Buffer.compare(original.print.bytes, maskOnly.print.bytes)).toBe(0);
    expect(original.print.sha256).toBe(maskOnly.print.sha256);
    expect(Buffer.compare(await sharp(original.print.bytes).raw().toBuffer(), await sharp(maskOnly.print.bytes).raw().toBuffer())).toBe(0);
    expect(original.cut.sha256).not.toBe(maskOnly.cut.sha256);
    expect(Buffer.compare(original.cut.bytes, maskOnly.cut.bytes)).not.toBe(0);
    expect(Buffer.compare(original.cut.bytes, colorOnly.cut.bytes)).toBe(0);
    expect(original.cut.sha256).toBe(colorOnly.cut.sha256);
    expect(original.print.sha256).not.toBe(colorOnly.print.sha256);
    expect(Buffer.compare(original.print.bytes, colorOnly.print.bytes)).not.toBe(0);
    const i = ((14 + 520) * 1216 + 8 + 320) * 3;
    expect([...original.print.preview.data.subarray(i, i + 3)]).toEqual([139, 197, 177]);
  });

  it('refuses to grant new generation QC to a historical receipt lacking source color evidence', async () => {
    const input = await artifact();
    const { descriptor } = input.receipt;
    if (descriptor.formatVersion !== 2) throw new Error('expected v2 fixture');
    const { colorEvidence: _color, ...legacy } = descriptor;
    await expect(preparePhysicalArtifacts({ ...input, receipt: {
      ...input.receipt, descriptor: { ...legacy, formatVersion: 1 },
    } })).rejects.toThrow(/color evidence/i);
  });
});
