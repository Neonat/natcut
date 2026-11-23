import { findContours, pathLength } from '../../../vendor/pixcut-trace/contours.ts';
import type { BinaryMask, Contour } from '../../../vendor/pixcut-trace/types.ts';

export type TraceMetrics = {
  contours: Contour[];
  contourCount: number;
  pointCount: number;
  cutLengthMm: number;
};

export function combineMasks(masks: BinaryMask[]): BinaryMask {
  const first = masks[0];
  if (!first) return { width: 0, height: 0, data: new Uint8Array() };
  const data = new Uint8Array(first.data.length);
  for (const mask of masks) {
    if (mask.width !== first.width || mask.height !== first.height) throw new Error('Cut masks must share dimensions');
    for (let i = 0; i < data.length; i++) {
      if (mask.data[i] === 255) data[i] = 255;
    }
  }
  return { width: first.width, height: first.height, data };
}

export function traceCutContours(mask: BinaryMask, dpi: number): TraceMetrics {
  const contours = findContours(mask, {
    minArea: 0,
    chainApproximation: 'none',
    includeHoles: false,
    maxContours: 65,
  });
  let pointCount = 0;
  let cutLengthPx = 0;
  for (const contour of contours) {
    pointCount += contour.outer.length;
    cutLengthPx += pathLength(contour.outer);
    for (const inner of contour.inners) {
      pointCount += inner.length;
      cutLengthPx += pathLength(inner);
    }
  }
  return {
    contours,
    contourCount: contours.length,
    pointCount,
    cutLengthMm: (cutLengthPx * 25.4) / dpi,
  };
}
