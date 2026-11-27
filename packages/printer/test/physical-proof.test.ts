import { expect, it } from 'vitest';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { buildPhysicalProof } from '../src/physical-proof.ts';

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
    cutExpansion: { pixels: 20, millimeters: 1.6933 },
  });
  expect(first.summary.approvalFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(first.summary.jpeg.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.summary.plt.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.artifacts.print.bytes).toEqual(second.artifacts.print.bytes);
  expect(first.artifacts.cut.bytes).toEqual(second.artifacts.cut.bytes);
  expect(parsePlt(new TextDecoder().decode(first.artifacts.cut.bytes)).paths).toHaveLength(6);
  expect(first.cutPreviewSvg).toMatch(/^<svg[^>]+viewBox="0 0 1216 2128"/);
  expect(first.cutPreviewSvg).toContain('Blade path overlay');
  expect(first.cutPreviewSvg.match(/<path /g)).toHaveLength(6);
});
