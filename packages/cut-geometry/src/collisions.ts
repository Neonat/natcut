import type { BinaryMask } from '../../../vendor/pixcut-trace/types.ts';
import type { DistanceField } from './distance-field.ts';
import { marginMmToPixels } from './dilate.ts';

export type GroupCollision = {
  firstId: string;
  secondId: string;
  overlaps: boolean;
  clearanceMm: number;
};

function minimumSourceDistance(first: DistanceField, second: DistanceField): number {
  let minimumSquared = Infinity;
  for (let i = 0; i < first.source.length; i++) {
    if (first.source[i] === 255) minimumSquared = Math.min(minimumSquared, second.squaredDistance[i]!);
    if (second.source[i] === 255) minimumSquared = Math.min(minimumSquared, first.squaredDistance[i]!);
  }
  return Math.sqrt(minimumSquared);
}

export function measureGroupCollisions(
  fields: DistanceField[],
  expanded: BinaryMask[],
  marginMm: number,
  dpi: number,
): GroupCollision[] {
  const radius = marginMmToPixels(marginMm, dpi);
  const collisions: GroupCollision[] = [];
  for (let firstIndex = 0; firstIndex < fields.length; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < fields.length; secondIndex++) {
      const first = fields[firstIndex]!;
      const second = fields[secondIndex]!;
      const firstExpanded = expanded[firstIndex]!;
      const secondExpanded = expanded[secondIndex]!;
      let overlaps = false;
      for (let i = 0; i < firstExpanded.data.length; i++) {
        if (firstExpanded.data[i] === 255 && secondExpanded.data[i] === 255) {
          overlaps = true;
          break;
        }
      }
      const sourceDistancePx = minimumSourceDistance(first, second);
      const clearancePx = Math.max(0, sourceDistancePx - 2 * radius);
      collisions.push({
        firstId: first.id,
        secondId: second.id,
        overlaps,
        clearanceMm: (clearancePx * 25.4) / dpi,
      });
    }
  }
  return collisions;
}

export function minimumExpandedEdgeClearanceMm(
  fields: DistanceField[],
  marginMm: number,
  dpi: number,
): number {
  const marginPx = marginMmToPixels(marginMm, dpi);
  let minimumPx = Infinity;
  for (const field of fields) {
    if (field.foregroundCount === 0) continue;
    for (let index = 0; index < field.source.length; index++) {
      if (field.source[index] !== 255) continue;
      const x = index % field.width;
      const y = (index - x) / field.width;
      minimumPx = Math.min(minimumPx, x, y, field.width - 1 - x, field.height - 1 - y);
    }
  }
  return minimumPx === Infinity ? Infinity : ((minimumPx - marginPx) * 25.4) / dpi;
}
