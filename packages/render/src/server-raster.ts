import { createHash } from 'node:crypto';
import sharp, { type OverlayOptions } from 'sharp';
import type { AssetCatalog } from './assets.ts';
import { assertPlanWithinSheet, type PlannedComposition } from './layout.ts';

export type RenderedRaster = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  sha256: string;
};

export async function renderServerRaster(
  plan: PlannedComposition,
  assets: AssetCatalog,
): Promise<RenderedRaster> {
  assertPlanWithinSheet(plan);

  const composites: OverlayOptions[] = [];
  for (const layer of plan.layers) {
    const asset = assets.get(layer.assetId);
    if (!asset) throw new Error(`Missing asset ${layer.assetId} for layer ${layer.id}`);
    if (asset.rgba.length !== asset.width * asset.height * 4) {
      throw new Error(`Asset ${layer.assetId} has invalid RGBA length`);
    }
    const input = Buffer.from(asset.rgba.buffer, asset.rgba.byteOffset, asset.rgba.byteLength);
    const resized = await sharp(input, {
      raw: { width: asset.width, height: asset.height, channels: 4 },
    })
      .resize(layer.width, layer.height, { fit: 'fill', kernel: 'nearest' })
      .raw()
      .toBuffer();
    composites.push({
      input: resized,
      raw: { width: layer.width, height: layer.height, channels: 4 },
      left: layer.x,
      top: layer.y,
    });
  }

  const rendered = await sharp({
    create: {
      width: plan.width,
      height: plan.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .raw()
    .toBuffer();

  return {
    width: plan.width,
    height: plan.height,
    rgba: new Uint8ClampedArray(rendered),
    sha256: createHash('sha256').update(rendered).digest('hex'),
  };
}
