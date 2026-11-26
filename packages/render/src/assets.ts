import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlannedAssets } from './catalog.ts';
import type { PlannedComposition } from './layout.ts';
import sharp from 'sharp';

export type RgbaAsset = {
  id: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

export type AssetCatalog = ReadonlyMap<string, RgbaAsset>;

export async function loadRgbaAsset(input: string | Buffer, id: string): Promise<RgbaAsset> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    id,
    width: info.width,
    height: info.height,
    rgba: new Uint8ClampedArray(data),
  };
}

export function loadPackagedAssets(
  plan: PlannedComposition,
  directory = fileURLToPath(new URL('../catalog/artwork/', import.meta.url)),
): Promise<AssetCatalog> {
  return loadPlannedAssets(plan, async (filename, id) => {
    const bytes = await readFile(path.join(directory, filename));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (filename !== digest + '.png') throw new Error(`Artwork digest mismatch for ${id}.`);
    return loadRgbaAsset(bytes, id);
  });
}
