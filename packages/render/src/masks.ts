import type { AssetCatalog, RgbaAsset } from './assets.ts';
import { assertPlanWithinSheet, type PlannedComposition, type PlannedLayer } from './layout.ts';
import { nearestSourceCoordinate } from './sampling.ts';
import { sampledSpriteHalo } from './runtime-halo.ts';

export type CutGroupMask = {
  id: string;
  width: number;
  height: number;
  alpha: Uint8Array;
};

function requireAsset(assets: AssetCatalog<RgbaAsset>, layer: PlannedLayer): RgbaAsset {
  const asset = assets.get(layer.assetId);
  if (!asset) throw new Error(`Missing asset ${layer.assetId} for layer ${layer.id}`);
  if (asset.rgba.length !== asset.width * asset.height * 4) {
    throw new Error(`Asset ${layer.assetId} has invalid RGBA length`);
  }
  return asset;
}

function compositeLayerAlpha(mask: Uint8Array, sheetWidth: number, layer: PlannedLayer, asset: RgbaAsset) {
  if (layer.creamHaloPx) {
    const halo = sampledSpriteHalo(layer, asset);
    for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
      if (halo[y * layer.width + x]) mask[(layer.y + y) * sheetWidth + layer.x + x] = 255;
    }
  }
  for (let targetY = 0; targetY < layer.height; targetY++) {
    const sourceY = nearestSourceCoordinate(targetY, layer.height, asset.height);
    for (let targetX = 0; targetX < layer.width; targetX++) {
      const sourceX = nearestSourceCoordinate(layer.flipX ? layer.width - 1 - targetX : targetX,
        layer.width, asset.width);
      const sourceAlpha = asset.rgba[(sourceY * asset.width + sourceX) * 4 + 3] ?? 0;
      if (sourceAlpha === 0) continue;
      const destination = (layer.y + targetY) * sheetWidth + layer.x + targetX;
      const existing = mask[destination] ?? 0;
      mask[destination] = Math.round(sourceAlpha + (existing * (255 - sourceAlpha)) / 255);
    }
  }
}

export function renderCutGroupMasks(
  plan: PlannedComposition,
  assets: AssetCatalog<RgbaAsset>,
): CutGroupMask[] {
  assertPlanWithinSheet(plan);
  const masks = new Map(
    plan.cutGroupIds.map((id) => [id, new Uint8Array(plan.width * plan.height)] as const),
  );

  for (const layer of plan.layers) {
    const mask = masks.get(layer.cutGroupId);
    if (!mask) throw new Error(`Layer ${layer.id} references unknown cut group ${layer.cutGroupId}`);
    compositeLayerAlpha(mask, plan.width, layer, requireAsset(assets, layer));
  }

  return plan.cutGroupIds.map((id) => ({
    id,
    width: plan.width,
    height: plan.height,
    alpha: masks.get(id)!,
  }));
}
