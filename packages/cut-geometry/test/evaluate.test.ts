import { expect, it } from 'vitest';
import { DEVFEST_SG_V1, sha256Hex } from '@natcut/domain';
import { evaluateCutGeometry } from '../src/index.ts';

it('exposes the combined expanded mask whose hash identifies the geometry report', async () => {
  const width = 40, height = 40;
  const groups = [10, 30].map((x) => {
    const alpha = new Uint8Array(width * height);
    alpha[20 * width + x] = 255;
    return { id: String(x), width, height, alpha };
  });
  const result = await evaluateCutGeometry(groups, 0.5, { ...DEVFEST_SG_V1, sheetWidthPx: width, sheetHeightPx: height });
  expect(result.combinedMask).toMatchObject({ width, height });
  expect(result.combinedMask.data[20 * width + 11]).toBe(255);
  expect(result.combinedMask.data[20 * width + 29]).toBe(255);
  expect(await sha256Hex(result.combinedMask.data)).toBe(result.report.rasterHash);
});
