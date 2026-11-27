import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { artifactObjectPath, DEVFEST_SG_V1 as profile } from '@natcut/domain';
import { verifyArtifactBytes, parseArtifactReceipt } from '../src/reader.ts';

it('verifies the original receipt without assigning new provenance or moving its object', async () => {
  const { sheetWidthPx: width, sheetHeightPx: height } = profile;
  const pixels = width * height;
  const bytes = new Uint8Array(pixels * 5);
  const sha256 = (span: Uint8Array) => createHash('sha256').update(span).digest('hex');
  const receipt = { generation: '9007199254740993', descriptor: {
    profile, width, height, renderVersion: 'fixture-v1', geometryVersion: 'v1', formatVersion: 1,
    colorByteLength: pixels * 4, colorSha256: sha256(bytes.subarray(0, pixels * 4)),
    maskByteLength: pixels, maskSha256: sha256(bytes.subarray(pixels * 4)),
    byteLength: bytes.length, bundleSha256: sha256(bytes),
    profileSha256: 'f4812e005f9118f42906afdf8fd3c99d0dd60a0fddca9f7875e12eaffca68890',
  } };
  for (const sourceProfileSha256 of ['0'.repeat(64), 'c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353']) {
    const colorEvidence = { outputSpace: 'srgb', pipelineVersion: 'natcut-srgb-v1',
      sources: [{ sourceSpace: 'cmyk', action: 'converted', sourceProfileSha256 }] };
    expect(() => parseArtifactReceipt({ ...receipt,
      descriptor: { ...receipt.descriptor, formatVersion: 2, colorEvidence },
    })).toThrow();
  }
  const verified = await verifyArtifactBytes(bytes, parseArtifactReceipt(receipt));
  expect(verified.receipt).toEqual(receipt);
  expect(artifactObjectPath(verified.receipt.descriptor)).toBe('logical/v1/' + receipt.descriptor.bundleSha256);
  expect(() => parseArtifactReceipt({ ...receipt, descriptor: { ...receipt.descriptor, colorEvidence: null } })).toThrow();
});
