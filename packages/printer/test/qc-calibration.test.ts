import { expect, it } from 'vitest';
import sharp from 'sharp';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '@natcut/domain';
import { buildCanonicalPreview, encodePreviewAtQuality, jpegQualities, preparePhysicalArtifacts } from '../src/artifacts.ts';
import { compareDecodedPreview, JPEG_QC_LIMITS } from '../src/generation-qc.ts';
import { fixtureNames, fixtureRgba, maximaOf } from './qc-fixtures.ts';

it('calibrates every production codec candidate against the independent fixture matrix', async () => {
  const profile = { ...DEVFEST_SG_V1, sheetWidthPx: 158, sheetHeightPx: 157, rasterWidthPx: 174, rasterHeightPx: 185 };
  const metrics = [];
  for (const name of fixtureNames) {
    const preview = await buildCanonicalPreview(fixtureRgba(name, profile.sheetWidthPx, profile.sheetHeightPx), profile);
    for (const quality of jpegQualities) {
      const jpeg = await encodePreviewAtQuality(preview, quality);
      const { data, info } = await sharp(jpeg).withIccProfile('srgb', { attach: false })
        .toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
      metrics.push(compareDecodedPreview(preview, { ...info, data }));
    }
  }
  expect(metrics).toHaveLength(45);
  expect(maximaOf(metrics)).toEqual({ maeMilli: 18_313, p99: 95, highErrorPpm: 200_249, worstTileBias: 8 });
  expect(JPEG_QC_LIMITS).toEqual({ maeMilli: 19_313, p99: 96, highErrorPpm: 201_249, worstTileBias: 9 });
  expect(metrics.filter(m => !m.passed)).toEqual([]);
});

it('selects all nine fallback qualities under the published 1 MiB cap on verified full sheets', async () => {
  const profile = DEVFEST_SG_V1;
  const { sheetWidthPx: width, sheetHeightPx: height } = profile;
  const mask = new Uint8Array(width * height);
  for (let y = 500; y < 580; y++) mask.fill(255, y * width + 300, y * width + 380);
  const metrics = [];
  const detailRows = [500, 1050, 1200, 1350, 1425, 1500, 1660, 1800, 2100];
  for (const [index, rows] of detailRows.entries()) {
    const bundle = await encodeLogicalSourceBundle({
      profile, width, height, colorEvidence: NATIVE_SRGB_EVIDENCE, renderVersion: 'calibration', geometryVersion: 'calibration',
      rgba: fixtureRgba('seeded-detail', width, height, rows), mask,
    });
    const { print } = await preparePhysicalArtifacts({ bytes: bundle.bytes, receipt: { generation: '1', descriptor: bundle.descriptor } });
    expect(print.quality).toBe(jpegQualities[index]);
    expect(print.bytes.length).toBeLessThanOrEqual(1_048_576);
    metrics.push(print.generationQc);
  }
  expect(maximaOf(metrics)).toEqual({ maeMilli: 14_746, p99: 51, highErrorPpm: 98_770, worstTileBias: 7 });
}, 30_000);
