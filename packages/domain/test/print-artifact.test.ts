import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  DEVFEST_SG_V1, decodeLogicalSourceBundle, encodeLogicalSourceBundle,
  ArtifactReceiptSchema, artifactObjectPath, LogicalSourceBundleDescriptorSchema, type LogicalSourceBundle,
} from '../src/index.ts';

const width = DEVFEST_SG_V1.sheetWidthPx;
const height = DEVFEST_SG_V1.sheetHeightPx;
const pixels = width * height;
const rgba = new Uint8ClampedArray(pixels * 4);
rgba.set([90, 70, 20, 255], rgba.length - 4);
const mask = new Uint8Array(pixels);
mask[pixels - 1] = 255;
const source = { width, height, rgba, mask, profile: DEVFEST_SG_V1, renderVersion: 'fixture-v1', geometryVersion: 'natcut-geometry-v1' };
const digest = (bytes: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');
let bundle: LogicalSourceBundle;

beforeAll(async () => { bundle = await encodeLogicalSourceBundle(source); });

it('accepts only a V1 descriptor and an exact positive decimal generation', () => {
  const receipt = { descriptor: bundle.descriptor, generation: '9007199254740993' };
  expect(ArtifactReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const generation of [0, 1, '', '0', '01', '-1', '1.0', ' 1', '1e2']) {
    expect(ArtifactReceiptSchema.safeParse({ ...receipt, generation }).success).toBe(false);
  }
  expect(ArtifactReceiptSchema.safeParse({ ...receipt, objectPath: 'foreign' }).success).toBe(false);
  expect(ArtifactReceiptSchema.safeParse({
    ...receipt, descriptor: { ...receipt.descriptor, profileSha256: '0'.repeat(64) },
  }).success).toBe(false);
  expect(artifactObjectPath(bundle.descriptor.bundleSha256)).toBe('logical/v1/' + bundle.descriptor.bundleSha256);
  expect(() => artifactObjectPath('../other')).toThrow();
});

it('encodes RGBA8 followed by binary mask bytes and verifies the complete descriptor', async () => {
  const expected = Buffer.concat([rgba, mask].map((span) => Buffer.from(span)));
  expect(bundle.descriptor).toEqual({
    formatVersion: 1, width, height, colorByteLength: rgba.length, maskByteLength: pixels, byteLength: pixels * 5,
    colorSha256: digest(rgba), maskSha256: digest(mask), bundleSha256: digest(expected),
    renderVersion: source.renderVersion, geometryVersion: source.geometryVersion,
    profile: DEVFEST_SG_V1, profileSha256: 'f4812e005f9118f42906afdf8fd3c99d0dd60a0fddca9f7875e12eaffca68890',
  });
  expect(Buffer.from(bundle.bytes).equals(expected)).toBe(true);
  const decoded = await decodeLogicalSourceBundle(bundle.bytes, bundle.descriptor);
  expect(digest(decoded.rgba)).toBe(digest(rgba));
  expect(digest(decoded.mask)).toBe(digest(mask));
});

it('changes only color and bundle digests when the RGB value changes', async () => {
  const recolored = rgba.slice();
  recolored[recolored.length - 4] = 42;
  const { descriptor } = await encodeLogicalSourceBundle({ ...source, rgba: recolored });
  expect(descriptor.colorSha256).not.toBe(bundle.descriptor.colorSha256);
  expect(descriptor.bundleSha256).not.toBe(bundle.descriptor.bundleSha256);
  expect(descriptor.maskSha256).toBe(bundle.descriptor.maskSha256);
});

it.each(['colorSha256', 'maskSha256', 'bundleSha256', 'profileSha256'] as const)('rejects a mismatched %s', async (key) => {
  await expect(decodeLogicalSourceBundle(bundle.bytes, { ...bundle.descriptor, [key]: '0'.repeat(64) })).rejects.toThrow();
});

it.each(['colorByteLength', 'maskByteLength', 'byteLength', 'width', 'height'] as const)('rejects a forged %s', async (key) => {
  await expect(decodeLogicalSourceBundle(bundle.bytes, { ...bundle.descriptor, [key]: Number.MAX_SAFE_INTEGER })).rejects.toThrow();
});

it('rejects trailing and truncated data and incorrectly sized encoder inputs', async () => {
  for (const length of [bundle.bytes.length - 1, bundle.bytes.length + 1]) {
    await expect(decodeLogicalSourceBundle(new Uint8Array(length), bundle.descriptor)).rejects.toThrow(/length/i);
  }
  await expect(encodeLogicalSourceBundle({ ...source, rgba: rgba.subarray(1) })).rejects.toThrow(/length/i);
  await expect(encodeLogicalSourceBundle({ ...source, mask: mask.subarray(1) })).rejects.toThrow(/length/i);
});

it('rejects non-binary mask bytes even when every digest agrees', async () => {
  const bytes = bundle.bytes.slice();
  bytes[rgba.length] = 1;
  const badMask = bytes.subarray(rgba.length);
  await expect(encodeLogicalSourceBundle({ ...source, mask: badMask })).rejects.toThrow(/binary/i);
  await expect(decodeLogicalSourceBundle(bytes, {
    ...bundle.descriptor, bundleSha256: digest(bytes), maskSha256: digest(badMask),
  })).rejects.toThrow(/binary/i);
});

it('requires a complete, exact registered snapshot and a strict V1 descriptor', async () => {
  const { descriptor } = bundle;
  for (const profile of [
    { ...source.profile, version: 2 }, { ...source.profile, knifePressure: 30 }, { ...source.profile, id: ' ' + source.profile.id },
  ]) {
    await expect(encodeLogicalSourceBundle({ ...source, profile })).rejects.toThrow(/profile/i);
    await expect(decodeLogicalSourceBundle(bundle.bytes, { ...descriptor, profile })).rejects.toThrow(/profile/i);
  }
  for (const invalid of [
    { ...descriptor, formatVersion: 2 }, { ...descriptor, objectPath: 'somewhere' },
    { ...descriptor, profile: { ...source.profile, foo: 1 } },
  ]) expect(LogicalSourceBundleDescriptorSchema.safeParse(invalid).success).toBe(false);
});

it('returns verified bytes independent of the caller’s mutable buffer', async () => {
  const mutable = Buffer.from(bundle.bytes);
  const verified = await decodeLogicalSourceBundle(mutable, bundle.descriptor);
  mutable.fill(7);
  expect(digest(verified.rgba)).toBe(bundle.descriptor.colorSha256);
  expect(digest(verified.mask)).toBe(bundle.descriptor.maskSha256);
});

it('uses intrinsic typed-array length instead of a shadowed byteLength property', async () => {
  const forged = new Uint8Array([1]);
  Object.defineProperty(forged, 'byteLength', { value: bundle.descriptor.byteLength });
  await expect(decodeLogicalSourceBundle(forged, bundle.descriptor)).rejects.toThrow(/length/i);

  const forgedRgba = new Uint8Array([1]);
  Object.defineProperty(forgedRgba, 'byteLength', { value: bundle.descriptor.colorByteLength });
  await expect(encodeLogicalSourceBundle({ ...source, rgba: forgedRgba })).rejects.toThrow(/length/i);

  const wrongView = new Uint16Array(bundle.descriptor.colorByteLength / 2);
  await expect(encodeLogicalSourceBundle({ ...source, rgba: wrongView as never })).rejects.toThrow(/Uint8/i);
  await expect(decodeLogicalSourceBundle(new DataView(new ArrayBuffer(bundle.descriptor.byteLength)) as never,
    bundle.descriptor)).rejects.toThrow(/Uint8/i);
});
