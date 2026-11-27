import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  DEVFEST_SG_V1, decodeLogicalSourceBundle, encodeLogicalSourceBundle,
  ArtifactReceiptSchema, artifactObjectPath, LogicalSourceBundleDescriptorSchema, srgbColorEvidence, type LogicalSourceBundle,
} from '../src/index.ts';

const width = DEVFEST_SG_V1.sheetWidthPx;
const height = DEVFEST_SG_V1.sheetHeightPx;
const pixels = width * height;
const rgba = new Uint8ClampedArray(pixels * 4);
rgba.set([90, 70, 20, 255], rgba.length - 4);
const mask = new Uint8Array(pixels);
mask[pixels - 1] = 255;
const native = { sourceSpace: 'srgb', sourceProfileSha256: null, action: 'preserved' } as const;
const colorEvidence = { outputSpace: 'srgb', pipelineVersion: 'natcut-srgb-v1', sources: [native] } as const;
const source = { colorEvidence, width, height, rgba, mask, profile: DEVFEST_SG_V1, renderVersion: 'fixture-v1', geometryVersion: 'natcut-geometry-v1' };
const digest = (bytes: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');
let bundle: LogicalSourceBundle;

beforeAll(async () => { bundle = await encodeLogicalSourceBundle(source); });

it('accepts a versioned descriptor and an exact positive decimal generation', () => {
  const receipt = { descriptor: bundle.descriptor, generation: '9007199254740993' };
  expect(ArtifactReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(ArtifactReceiptSchema.parse({ ...receipt, generation: '9223372036854775807' }).generation).toBe('9223372036854775807');
  for (const generation of [0, 1, '', '0', '01', '-1', '1.0', ' 1', '1e2', '9223372036854775808', '1'.repeat(100)]) {
    expect(ArtifactReceiptSchema.safeParse({ ...receipt, generation }).success).toBe(false);
  }
  expect(ArtifactReceiptSchema.safeParse({ ...receipt, objectPath: 'foreign' }).success).toBe(false);
  expect(ArtifactReceiptSchema.safeParse({
    ...receipt, descriptor: { ...receipt.descriptor, profileSha256: '0'.repeat(64) },
  }).success).toBe(false);
  expect(artifactObjectPath(bundle.descriptor)).toBe('logical/v2/' + bundle.descriptor.bundleSha256);
  expect(() => artifactObjectPath({ ...bundle.descriptor, bundleSha256: '../other' })).toThrow();
});

it('encodes RGBA8 followed by binary mask bytes and verifies the complete descriptor', async () => {
  const expected = Buffer.concat([rgba, mask].map((span) => Buffer.from(span)));
  expect(bundle.descriptor).toEqual({
    formatVersion: 2, colorEvidence, width, height, colorByteLength: rgba.length, maskByteLength: pixels, byteLength: pixels * 5,
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

it('requires a complete, exact registered snapshot and a strict versioned descriptor', async () => {
  const { descriptor } = bundle;
  for (const profile of [
    { ...source.profile, version: 2 }, { ...source.profile, knifePressure: 30 }, { ...source.profile, id: ' ' + source.profile.id },
  ]) {
    await expect(encodeLogicalSourceBundle({ ...source, profile })).rejects.toThrow(/profile/i);
    await expect(decodeLogicalSourceBundle(bundle.bytes, { ...descriptor, profile })).rejects.toThrow(/profile/i);
  }
  for (const invalid of [
    { ...descriptor, formatVersion: 3 }, { ...descriptor, objectPath: 'somewhere' },
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

it('rejects missing, unsupported and inconsistent sRGB evidence for new receipts and encoding', async () => {
  for (const invalid of [
    undefined, { ...colorEvidence, outputSpace: 'adobe-rgb' }, { ...colorEvidence, leak: true },
    { ...colorEvidence, pipelineVersion: 'other' }, { ...colorEvidence, sources: [] },
    { ...colorEvidence, sources: [native, native] },
    { ...colorEvidence, sources: [{ ...native, action: 'converted' }] },
    { ...colorEvidence, sources: [{ ...native, extra: true }] },
    { ...colorEvidence, sources: [{ ...native, sourceSpace: 'display-p3', action: 'converted' }] },
    { ...colorEvidence, sources: [{ ...native, sourceProfileSha256: 'not-a-hash' }] },
    { ...colorEvidence, sources: [{ sourceSpace: 'cmyk', action: 'converted', sourceProfileSha256: '0'.repeat(64) }] },
    { ...colorEvidence, sources: [{ sourceSpace: 'cmyk', action: 'converted',
      sourceProfileSha256: 'c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353' }] },
    { ...colorEvidence, sources: [native, { sourceSpace: 'display-p3', action: 'converted',
      sourceProfileSha256: '231752984cd4a5278e1b8d2390fe496767d4511fc81f54e1a5c69ae9ab4c42b5' }] },
  ]) {
    expect(ArtifactReceiptSchema.safeParse({ descriptor: { ...bundle.descriptor, colorEvidence: invalid }, generation: '1' }).success).toBe(false);
    await expect(encodeLogicalSourceBundle({ ...source, colorEvidence: invalid as never })).rejects.toThrow();
  }
});

it('orders native sRGB before every sRGB profile digest and preserves distinct sRGB profile variants', () => {
  const apple = { ...native, sourceProfileSha256: '2b3aa1645779a9e634744faf9b01e9102b0c9b88fd6deced7934df86b949af7e' };
  const vips = { ...native, sourceProfileSha256: 'c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353' };
  const evidence = srgbColorEvidence([vips, apple, native, apple]);
  expect(evidence.sources).toEqual([native, apple, vips]);
  expect(Object.isFrozen(evidence.sources)).toBe(true);
});
