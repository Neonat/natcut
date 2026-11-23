import type { BinaryMask } from '../../../vendor/pixcut-trace/types.ts';
import type { DistanceField } from './distance-field.ts';

export function marginMmToPixels(marginMm: number, dpi: number): number {
  if (!Number.isFinite(marginMm) || marginMm < 0) throw new Error('Cut margin must be a non-negative finite number');
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error('DPI must be a positive finite number');
  return (marginMm * dpi) / 25.4;
}

export function previewExpandedMask(
  field: DistanceField,
  marginMm: number,
  dpi: number,
): BinaryMask {
  const radius = marginMmToPixels(marginMm, dpi);
  const radiusSquared = radius * radius + Number.EPSILON;
  const data = new Uint8Array(field.source.length);
  for (let i = 0; i < data.length; i++) {
    if (field.squaredDistance[i]! <= radiusSquared) data[i] = 255;
  }
  return { width: field.width, height: field.height, data };
}
