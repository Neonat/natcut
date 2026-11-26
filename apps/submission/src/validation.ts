import { evaluateCutGeometry } from '@natcut/cut-geometry';
import {
  DEVFEST_SG_V1,
  type CompositionManifest,
  type GeometryReport,
  type PrintProfile,
} from '@natcut/domain';
import {
  loadPackagedAssets,
  planComposition,
  renderCutGroupMasks,
  renderServerRaster,
  type AssetCatalog,
} from '@natcut/render';

export type ValidateManifest = (manifest: CompositionManifest) => Promise<GeometryReport>;

export function createTrustedManifestValidator(
  source: AssetCatalog | typeof loadPackagedAssets = loadPackagedAssets,
  profile: PrintProfile = DEVFEST_SG_V1,
): ValidateManifest {
  return async (manifest) => {
    const plan = planComposition(manifest, profile);
    const assets = typeof source === 'function' ? await source(plan) : source;
    await renderServerRaster(plan, assets);
    const masks = renderCutGroupMasks(plan, assets);
    return (await evaluateCutGeometry(masks, manifest.cutMarginMm, profile)).report;
  };
}
