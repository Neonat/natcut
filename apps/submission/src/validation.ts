import { evaluateCutGeometry } from '@natcut/cut-geometry';
import {
  DEVFEST_SG_V1,
  type CompositionManifest,
  type GeometryReport,
  type PrintProfile,
} from '@natcut/domain';
import {
  planComposition,
  renderCutGroupMasks,
  renderServerRaster,
  type AssetCatalog,
} from '@natcut/render';

export type ValidateManifest = (manifest: CompositionManifest) => Promise<GeometryReport>;

export function createTrustedManifestValidator(
  assets: AssetCatalog,
  profile: PrintProfile = DEVFEST_SG_V1,
): ValidateManifest {
  return async (manifest) => {
    const plan = planComposition(manifest, profile);
    await renderServerRaster(plan, assets);
    const masks = renderCutGroupMasks(plan, assets);
    return (await evaluateCutGeometry(masks, manifest.cutMarginMm, profile)).report;
  };
}
