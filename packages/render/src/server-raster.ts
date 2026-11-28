import { createHash } from 'node:crypto';
import { NATIVE_SRGB_EVIDENCE, SrgbColorEvidenceSchema, srgbColorEvidence, type SourceColorEvidence, type SrgbColorEvidence } from '@natcut/domain';
import type { AssetCatalog } from './assets.ts';
import { assertPlanWithinSheet, type PlannedComposition } from './layout.ts';
import { compositeRgbaPixel, nearestSourceCoordinate } from './sampling.ts';

export type RenderedRaster = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  sha256: string;
  readonly colorEvidence: SrgbColorEvidence;
};

export async function renderServerRaster(
  plan: PlannedComposition,
  assets: AssetCatalog,
): Promise<RenderedRaster> {
  assertPlanWithinSheet(plan);

  const sources: SourceColorEvidence[] = [];
  const rendered = new Uint8ClampedArray(plan.width * plan.height * 4);
  for (const layer of plan.layers) {
    const asset = assets.get(layer.assetId);
    if (!asset) throw new Error(`Missing asset ${layer.assetId} for layer ${layer.id}`);
    const layerEvidence = SrgbColorEvidenceSchema.parse(asset.colorEvidence);
    sources.push(...layerEvidence.sources);
    if (asset.rgba.length !== asset.width * asset.height * 4) {
      throw new Error(`Asset ${layer.assetId} has invalid RGBA length`);
    }
    for (let targetY = 0; targetY < layer.height; targetY++) {
      const sourceY = nearestSourceCoordinate(targetY, layer.height, asset.height);
      for (let targetX = 0; targetX < layer.width; targetX++) {
        const sourceX = nearestSourceCoordinate(layer.flipX ? layer.width - 1 - targetX : targetX,
          layer.width, asset.width);
        const sourceOffset = (sourceY * asset.width + sourceX) * 4;
        const destinationOffset = ((layer.y + targetY) * plan.width + layer.x + targetX) * 4;
        compositeRgbaPixel(rendered, destinationOffset, asset.rgba, sourceOffset);
      }
    }
  }

  return {
    width: plan.width,
    height: plan.height,
    rgba: rendered,
    colorEvidence: sources.length ? srgbColorEvidence(sources) : NATIVE_SRGB_EVIDENCE,
    sha256: createHash('sha256').update(rendered).digest('hex'),
  };
}
