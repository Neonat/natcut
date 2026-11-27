import { evaluateCutGeometry, type GeometryEvaluation } from '@natcut/cut-geometry';
import {
  CompositionManifestSchema,
  DEVFEST_SG_V1,
  PublishedPrintProfileSchema,
  encodeLogicalSourceBundle,
  type CompositionManifest,
  type GeometryReport,
  type LogicalSourceBundle,
  type PrintProfile,
} from '@natcut/domain';
import {
  loadPackagedAssets,
  planComposition,
  renderCutGroupMasks,
  renderServerRaster,
  type AssetCatalog,
  type PlannedComposition,
  type RenderedRaster,
} from '@natcut/render';

export type ValidateManifest = (manifest: CompositionManifest) => Promise<GeometryReport>;
export type PreparedTrustedArtifact = Pick<GeometryEvaluation, 'combinedMask' | 'contours' | 'report'> & {
  profile: Readonly<PrintProfile>;
  raster: RenderedRaster;
  bundle: LogicalSourceBundle;
};
export type PrepareTrustedArtifact = (manifest: CompositionManifest) => Promise<PreparedTrustedArtifact>;
type AssetSource = AssetCatalog | typeof loadPackagedAssets;

export async function preparePlannedArtifact(
  manifest: CompositionManifest, plan: PlannedComposition, assets: AssetCatalog, profile: PrintProfile,
): Promise<PreparedTrustedArtifact> {
  const raster = await renderServerRaster(plan, assets);
  const masks = renderCutGroupMasks(plan, assets);
  const { combinedMask, contours, report } = await evaluateCutGeometry(masks, manifest.cutMarginMm, profile);
  const bundle = await encodeLogicalSourceBundle({
    profile, width: raster.width, height: raster.height,
    colorEvidence: raster.colorEvidence, rgba: raster.rgba, mask: combinedMask.data,
    renderVersion: manifest.renderVersion, geometryVersion: report.geometryVersion,
  });
  return { profile, raster, combinedMask, contours, report, bundle };
}

export function createTrustedArtifactPreparer(
  source: AssetSource = loadPackagedAssets,
  profileSnapshot: PrintProfile = DEVFEST_SG_V1,
): PrepareTrustedArtifact {
  const profile = PublishedPrintProfileSchema.parse(profileSnapshot);
  return async (input) => {
    const manifest = CompositionManifestSchema.parse(input);
    const plan = planComposition(manifest, profile);
    const assets = typeof source === 'function' ? await source(plan) : source;
    return preparePlannedArtifact(manifest, plan, assets, profile);
  };
}

export function createTrustedManifestValidator(
  source: AssetSource = loadPackagedAssets,
  profile: PrintProfile = DEVFEST_SG_V1,
): ValidateManifest {
  return async (input) => {
    const manifest = CompositionManifestSchema.parse(input);
    const plan = planComposition(manifest, profile);
    const assets = typeof source === 'function' ? await source(plan) : source;
    await renderServerRaster(plan, assets);
    const masks = renderCutGroupMasks(plan, assets);
    return (await evaluateCutGeometry(masks, manifest.cutMarginMm, profile)).report;
  };
}
