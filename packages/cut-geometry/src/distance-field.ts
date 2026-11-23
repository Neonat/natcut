import type { CutGroupMask } from '@natcut/render';

const LARGE_DISTANCE = 1e20;

export type DistanceField = {
  id: string;
  width: number;
  height: number;
  source: Uint8Array;
  squaredDistance: Float64Array;
  foregroundCount: number;
};

function transform1d(values: Float64Array, length: number): Float64Array {
  const output = new Float64Array(length);
  const locations = new Int32Array(length);
  const boundaries = new Float64Array(length + 1);
  let k = 0;
  locations[0] = 0;
  boundaries[0] = -Infinity;
  boundaries[1] = Infinity;

  for (let q = 1; q < length; q++) {
    let intersection: number;
    for (;;) {
      const p = locations[k]!;
      intersection = ((values[q]! + q * q) - (values[p]! + p * p)) / (2 * q - 2 * p);
      if (intersection > boundaries[k]!) break;
      k--;
    }
    k++;
    locations[k] = q;
    boundaries[k] = intersection;
    boundaries[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < length; q++) {
    while (boundaries[k + 1]! < q) k++;
    const p = locations[k]!;
    output[q] = (q - p) * (q - p) + values[p]!;
  }
  return output;
}

export function buildDistanceField(mask: CutGroupMask, alphaThreshold = 128): DistanceField {
  const { width, height, alpha } = mask;
  if (alpha.length !== width * height) throw new Error(`Mask ${mask.id} has invalid alpha length`);

  const source = new Uint8Array(alpha.length);
  let foregroundCount = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! >= alphaThreshold) {
      source[i] = 255;
      foregroundCount++;
    }
  }

  if (foregroundCount === 0) {
    return {
      id: mask.id,
      width,
      height,
      source,
      squaredDistance: new Float64Array(alpha.length).fill(Infinity),
      foregroundCount,
    };
  }

  const rowPass = new Float64Array(alpha.length);
  const line = new Float64Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = source[y * width + x] === 255 ? 0 : LARGE_DISTANCE;
    const transformed = transform1d(line, width);
    rowPass.set(transformed, y * width);
  }

  const squaredDistance = new Float64Array(alpha.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = rowPass[y * width + x]!;
    const transformed = transform1d(line, height);
    for (let y = 0; y < height; y++) squaredDistance[y * width + x] = transformed[y]!;
  }

  return { id: mask.id, width, height, source, squaredDistance, foregroundCount };
}
