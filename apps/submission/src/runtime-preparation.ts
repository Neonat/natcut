import { CompositionManifestSchema, DEVFEST_SG_V1, PublishedPrintProfileSchema,
  type CompositionManifest, type PrintProfile } from '@natcut/domain';
import { isRuntimeLetteringId, loadPackagedAssets, planComposition, runtimeLetteringAsset } from '@natcut/render';
import type { PlantFlowKey } from './plant-flow-repository.ts';
import type { createRuntimeSpriteRegistry } from './runtime-sprite.ts';
import { preparePlannedArtifact } from './validation.ts';

type RuntimeRegistry = ReturnType<typeof createRuntimeSpriteRegistry>;

export function createAcceptedRuntimeArtifactPreparer(
  registry: Pick<RuntimeRegistry, 'loadAccepted'>,
  staticArtworkDirectory?: string,
  profileSnapshot: PrintProfile = DEVFEST_SG_V1,
) {
  const profile = PublishedPrintProfileSchema.parse(profileSnapshot);
  return async (flowKey: PlantFlowKey, input: CompositionManifest) => {
    const manifest = CompositionManifestSchema.parse(input);
    if (manifest.renderVersion !== 'runtime-catalog-v1') throw new Error('Runtime preparation requires runtime-catalog-v1.');
    const runtimeSprite = await registry.loadAccepted(flowKey, manifest.spriteAssetId);
    const plan = planComposition(manifest, profile, runtimeSprite.id);
    const staticPlan = { ...plan, layers: plan.layers.filter(layer => layer.assetId !== runtimeSprite.id &&
      !isRuntimeLetteringId(layer.assetId)) };
    const packaged = await loadPackagedAssets(staticPlan, staticArtworkDirectory);
    const assets = new Map(packaged).set(runtimeSprite.id, runtimeSprite);
    for (const layer of plan.layers) if (isRuntimeLetteringId(layer.assetId)) {
      assets.set(layer.assetId, runtimeLetteringAsset(layer.assetId, manifest.plantLabel));
    }
    return preparePlannedArtifact(manifest, plan, assets, profile);
  };
}
