import type { RgbaAsset } from './assets.ts';
import type { PlannedLayer } from './layout.ts';
import { nearestSourceCoordinate } from './sampling.ts';

/** Opaque cream backing around the sampled sprite, shared by print and cut geometry. */
export function sampledSpriteHalo(layer: PlannedLayer, asset: RgbaAsset): Uint8Array {
  const radius = layer.creamHaloPx ?? 0;
  const { width, height } = layer;
  const sampled = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = nearestSourceCoordinate(y, height, asset.height);
    for (let x = 0; x < width; x++) {
      const sx = nearestSourceCoordinate(layer.flipX ? width - 1 - x : x, width, asset.width);
      sampled[y * width + x] = asset.rgba[(sy * asset.width + sx) * 4 + 3]! >= 128 ? 1 : 0;
    }
  }
  if (!radius) return sampled;
  const horizontal = new Uint8Array(sampled.length);
  const halo = new Uint8Array(sampled.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (x + dx >= 0 && x + dx < width && sampled[y * width + x + dx]) {
        horizontal[y * width + x] = 1;
        break;
      }
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (let dy = -radius; dy <= radius; dy++) {
      if (y + dy >= 0 && y + dy < height && horizontal[(y + dy) * width + x]) {
        halo[y * width + x] = 1;
        break;
      }
    }
  }
  return halo;
}
