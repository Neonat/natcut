import { describe, expect, it } from 'vitest';
import { GEOMETRY_LIMITS, type PrintProfile } from '@natcut/domain';
import type { CutGroupMask } from '@natcut/render';
import {
  buildDistanceField,
  classifyTraceComplexity,
  evaluateCutGeometry,
  marginMmToPixels,
  previewExpandedMask,
} from '../src/index.ts';

const DPI = 300;

function mask(
  id: string,
  width: number,
  height: number,
  pixels: Array<[number, number]>,
): CutGroupMask {
  const alpha = new Uint8Array(width * height);
  for (const [x, y] of pixels) alpha[y * width + x] = 255;
  return { id, width, height, alpha };
}

function rectangle(
  id: string,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): CutGroupMask {
  const pixels: Array<[number, number]> = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) pixels.push([x, y]);
  }
  return mask(id, width, height, pixels);
}

function profile(width: number, height: number): PrintProfile {
  return {
    id: 'test',
    version: 1,
    mediaSize: 1,
    mediaType: 1,
    sheetWidthPx: width,
    sheetHeightPx: height,
    rasterWidthPx: width,
    rasterHeightPx: height,
    printQuality: 4,
    copies: 1,
    knifePressure: 42,
    cutHoles: false,
    alphaThreshold: 128,
    jpegMaxBytes: 1_048_576,
  };
}

function hasIssue(result: Awaited<ReturnType<typeof evaluateCutGeometry>>, code: string) {
  return result.report.issues.find((issue) => issue.code === code);
}

describe('distance field dilation', () => {
  it('converts physical margins using the 300dpi print grid', () => {
    expect(marginMmToPixels(25.4, DPI)).toBeCloseTo(300);
    expect(marginMmToPixels(1, DPI)).toBeCloseTo(300 / 25.4);
  });

  it('expands with a circular/elliptical footprint', () => {
    const source = mask('sprite', 5, 5, [[2, 2]]);
    const expanded = previewExpandedMask(
      buildDistanceField(source),
      25.4 / DPI,
      DPI,
    );

    expect(expanded.data[2 * 5 + 2]).toBe(255);
    expect(expanded.data[2 * 5 + 1]).toBe(255);
    expect(expanded.data[1 * 5 + 2]).toBe(255);
    expect(expanded.data[1 * 5 + 1]).toBe(0);
  });

  it('keeps zero-margin output stable and expands monotonically', () => {
    const source = mask('sprite', 9, 9, [[4, 4]]);
    const field = buildDistanceField(source);
    const zero = previewExpandedMask(field, 0, DPI);
    const small = previewExpandedMask(field, 0.2, DPI);
    const large = previewExpandedMask(field, 0.5, DPI);

    expect(zero.data).toEqual(source.alpha);
    for (let i = 0; i < zero.data.length; i++) {
      expect(small.data[i]).toBeGreaterThanOrEqual(zero.data[i]!);
      expect(large.data[i]).toBeGreaterThanOrEqual(small.data[i]!);
    }
  });
});

describe('cut geometry policy', () => {
  it('accepts groups whose expanded cut contours retain the safety gap', async () => {
    const result = await evaluateCutGeometry(
      [rectangle('sprite', 140, 120, 42, 45, 51, 54), rectangle('branding', 140, 120, 83, 45, 92, 54)],
      0.5,
      profile(140, 120),
    );

    expect(result.report.valid).toBe(true);
    expect(result.report.severity).toBe('ok');
    expect(result.report.minimumContourGapMm).toBeGreaterThanOrEqual(GEOMETRY_LIMITS.safetyGapMm);
  });

  it('warns when expanded cut masks overlap', async () => {
    const result = await evaluateCutGeometry(
      [rectangle('sprite', 80, 80, 15, 25, 29, 39), rectangle('branding', 80, 80, 36, 25, 50, 39)],
      0.5,
      profile(80, 80),
    );

    expect(hasIssue(result, 'CUT_CONTOURS_OVERLAP')?.severity).toBe('warning');
    expect(result.report.valid).toBe(true);
  });

  it('warns when contours do not overlap but retain less than 1.5mm clearance', async () => {
    const result = await evaluateCutGeometry(
      [rectangle('sprite', 100, 80, 15, 25, 24, 34), rectangle('branding', 100, 80, 49, 25, 58, 34)],
      0.5,
      profile(100, 80),
    );

    expect(hasIssue(result, 'CUT_CONTOURS_OVERLAP')).toBeUndefined();
    expect(hasIssue(result, 'CUT_GAP_TOO_SMALL')?.severity).toBe('warning');
    expect(result.report.valid).toBe(true);
  });

  it('warns when the cut is inside the sheet but below preferred edge clearance', async () => {
    const result = await evaluateCutGeometry(
      [rectangle('sprite', 100, 80, 25, 25, 40, 40)],
      0.5,
      profile(100, 80),
    );

    expect(hasIssue(result, 'CUT_EDGE_CLEARANCE')?.severity).toBe('warning');
    expect(result.report.valid).toBe(true);
  });

  it('rejects empty artwork', async () => {
    const result = await evaluateCutGeometry([mask('sprite', 40, 40, [])], 0.5, profile(40, 40));

    expect(hasIssue(result, 'EMPTY_ARTWORK')?.severity).toBe('error');
    expect(result.report.valid).toBe(false);
  });

  it('rejects cut margins that extend beyond the sheet', async () => {
    const result = await evaluateCutGeometry(
      [rectangle('sprite', 60, 60, 2, 20, 15, 35)],
      0.5,
      profile(60, 60),
    );

    expect(hasIssue(result, 'OUT_OF_BOUNDS')?.severity).toBe('error');
    expect(result.report.valid).toBe(false);
  });

  it('rejects more than 64 contours', async () => {
    const pixels: Array<[number, number]> = [];
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 10; column++) {
        const left = 25 + column * 10;
        const top = 25 + row * 10;
        for (let y = top; y < top + 3; y++) {
          for (let x = left; x < left + 3; x++) pixels.push([x, y]);
        }
      }
    }
    const result = await evaluateCutGeometry(
      [mask('sprite', 150, 120, pixels)],
      0,
      profile(150, 120),
    );

    expect(hasIssue(result, 'TOO_MANY_CONTOURS')?.severity).toBe('error');
    expect(result.report.contourCount).toBeGreaterThan(GEOMETRY_LIMITS.maxContours);
  });

  it('rejects traces above the point budget', () => {
    const issues = classifyTraceComplexity(1, GEOMETRY_LIMITS.maxContourPoints + 1);
    expect(issues.find((issue) => issue.code === 'TOO_MANY_POINTS')?.severity).toBe('error');
  });
});
