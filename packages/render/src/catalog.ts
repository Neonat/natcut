import type { CompositionManifest } from '@natcut/domain';
import index from '../catalog/index.json' with { type: 'json' };
import type { AssetCatalog, RgbaAsset } from './assets.ts';
import type { PlannedComposition } from './layout.ts';

export type SpriteEntry = Readonly<{
  id: string;
  name: string;
  scientificName?: string;
  pngSha256: string;
  width: number;
  height: number;
}>;

export const sprites: readonly SpriteEntry[] = Object.freeze(index.sprites.map((entry) => Object.freeze(entry)));
const byId = new Map<string, SpriteEntry>([...sprites, ...index.archived].map((entry) => [entry.id, entry]));
const legacySprite = 'sprite/monstera-v1';
const legacyTrainer = 'trainer/friend-v1';
const legacySpritePng = '95edfb98885bc6df75799ea892270ff06c1d90b469cf627f7d304286ed2503df';
const wordmarkPng = 'c4c26dc37bfc264b6818fa6bef96b8a1e32d07f9a97d7c0af33c5b702b617a9b';
const legacyPngs = new Map([
  [legacySprite, legacySpritePng],
  [legacyTrainer, legacySpritePng],
  ['branding/logo', wordmarkPng],
  ['branding/logo-and-species', wordmarkPng],
  ['branding/logo-and-sprites', wordmarkPng],
]);

export const legacyManifest: CompositionManifest = {
  schemaVersion: 1, spriteAssetId: legacySprite, trainerAssetId: null,
  theme: 'default', brandingVariant: 'logo',
  cutGroups: [{ id: 'main', members: ['sprite'] }, { id: 'brand', members: ['branding'] }],
  cutMarginMm: 1.5, renderVersion: 'fixture-v1',
};

export const catalogManifest: CompositionManifest = {
  ...legacyManifest, spriteAssetId: sprites[0]!.id, renderVersion: 'catalog-v1',
};

export function assertSupportedRecipe(manifest: CompositionManifest): void {
  if (manifest.renderVersion === 'fixture-v1') {
    if (manifest.spriteAssetId !== legacySprite || (manifest.trainerAssetId !== null && manifest.trainerAssetId !== legacyTrainer)) {
      throw new Error('Unknown fixture layer asset.');
    }
    return;
  }
  if (manifest.renderVersion !== 'catalog-v1') throw new Error('Unsupported render version.');
  const [main, brand] = manifest.cutGroups;
  if (!byId.has(manifest.spriteAssetId) || manifest.theme !== 'default' || manifest.brandingVariant !== 'logo'
    || manifest.trainerAssetId !== null || manifest.cutGroups.length !== 2
    || main?.id !== 'main' || main.members.length !== 1 || main.members[0] !== 'sprite'
    || brand?.id !== 'brand' || brand.members.length !== 1 || brand.members[0] !== 'branding') {
    throw new Error('Unsupported catalog composition.');
  }
}

export function assetPngFilename(assetId: string): string {
  const digest = byId.get(assetId)?.pngSha256 ?? legacyPngs.get(assetId);
  if (!digest) throw new Error('Unknown artwork.');
  return digest + '.png';
}

export async function loadPlannedAssets(
  plan: PlannedComposition,
  load: (filename: string, id: string) => Promise<RgbaAsset>,
): Promise<AssetCatalog> {
  const ids = new Set(plan.layers.map((layer) => layer.assetId));
  const loaded = await Promise.all([...ids].map((id) => load(assetPngFilename(id), id)));
  return new Map(loaded.map((asset) => [asset.id, asset]));
}
