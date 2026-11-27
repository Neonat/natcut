import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import sharp from 'sharp';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { buildPhysicalProof, buildPhysicalProofFromPng } from '../src/physical-proof.ts';

it('builds one deterministic six-sticker 4x7 proof with immutable physical evidence', async () => {
  const first = await buildPhysicalProof();
  const second = await buildPhysicalProof();

  expect(first.summary).toEqual(second.summary);
  expect(first.summary).toMatchObject({
    media: '4x7 Liene adhesive photo paper',
    profileId: 'devfest-sg-v1',
    knifePressure: 42,
    copies: 1,
    stickerCount: 6,
    raster: { width: 1216, height: 2128 },
    cutExpansion: { pixels: 2, millimeters: 0.1693 },
  });
  expect(first.summary.approvalFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(first.summary.jpeg.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.summary.plt.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.artifacts.jpeg).toEqual(second.artifacts.jpeg);
  expect(first.artifacts.plt).toEqual(second.artifacts.plt);
  expect(parsePlt(new TextDecoder().decode(first.artifacts.plt)).paths).toHaveLength(6);
  expect(first.cutPreviewSvg).toMatch(/^<svg[^>]+viewBox="0 0 1216 2128"/);
  expect(first.cutPreviewSvg).toContain('Blade path overlay');
  expect(first.cutPreviewSvg.match(/<path /g)).toHaveLength(6);
});
it('turns an opaque 4x7 artwork sheet into one white-border cut contour', async () => {
  const width = 120;
  const height = 210;
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) rgb.set([247, 243, 235], pixel * 3);
  for (let y = 30; y < 180; y += 1) for (let x = 20; x < 100; x += 1) {
    const offset = (y * width + x) * 3;
    rgb.set(x >= 30 && x < 90 && y >= 40 && y < 170 ? [190, 70, 140] : [255, 255, 255], offset);
  }
  const png = new Uint8Array(await sharp(rgb, { raw: { width, height, channels: 3 } }).withIccProfile('srgb').png().toBuffer());
  const proof = await buildPhysicalProofFromPng(png, { label: 'Moth orchid example' });

  expect(proof.summary).toMatchObject({
    label: 'Moth orchid example',
    sourceImageSha256: createHash('sha256').update(png).digest('hex'),
    stickerCount: 1,
    raster: { width: 1216, height: 2128 },
  });
  expect(parsePlt(new TextDecoder().decode(proof.artifacts.plt)).paths).toHaveLength(1);
  expect(proof.cutPreviewSvg.match(/<path /g)).toHaveLength(1);
});
