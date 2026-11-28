import { SrgbColorEvidenceSchema, type SrgbColorEvidence, type CompositionManifest } from '@natcut/domain';
import index from '../catalog/index.json' with { type: 'json' };
import type { AssetCatalog, RgbaAsset } from './assets.ts';
import type { PlannedComposition } from './layout.ts';

export type SpriteEntry = Readonly<{
  id: string;
  name: string;
  scientificName?: string;
  pngSha256: string;
  colorEvidence?: SrgbColorEvidence;
  width: number;
  height: number;
  variants?: readonly [SpriteVariant, SpriteVariant];
}>;

export type SpriteVariant = Readonly<{ id: string; pngSha256: string; width: number; height: number }>;

function freezeEntry({ colorEvidence, variants, ...entry }: Omit<SpriteEntry, 'colorEvidence' | 'variants'> & {
  colorEvidence?: unknown; variants?: readonly SpriteVariant[];
}): SpriteEntry {
  const checkedVariants = variants?.map((variant) => {
    if (!/^[a-f0-9]{64}$/.test(variant.pngSha256) || variant.id !== `sprite/variant/${variant.pngSha256}`
      || !Number.isSafeInteger(variant.width) || !Number.isSafeInteger(variant.height)
      || variant.width < 1 || variant.height < 1) throw new Error('Invalid catalog sprite variant.');
    return Object.freeze(variant);
  });
  if (checkedVariants && (checkedVariants.length !== 2 || checkedVariants[0]!.id === checkedVariants[1]!.id)) {
    throw new Error('A catalog sprite needs two distinct phrase variants.');
  }
  return Object.freeze({ ...entry,
    ...(colorEvidence === undefined ? {} : { colorEvidence: SrgbColorEvidenceSchema.parse(colorEvidence) }),
    ...(checkedVariants === undefined ? {} : { variants: checkedVariants as [SpriteVariant, SpriteVariant] }),
  });
}

export const sprites: readonly SpriteEntry[] = Object.freeze(index.sprites.map(freezeEntry));
const archivedSprites: readonly SpriteEntry[] = Object.freeze(index.archived.map(freezeEntry));
const byId = new Map<string, SpriteEntry>([...sprites, ...archivedSprites].map((entry) => [entry.id, entry]));
const variantPngs = new Map<string, string>();
for (const sprite of [...sprites, ...archivedSprites]) {
  for (const variant of sprite.variants ?? []) {
    const previous = variantPngs.get(variant.id);
    if (previous && previous !== variant.pngSha256) throw new Error('Conflicting catalog sprite variant.');
    variantPngs.set(variant.id, variant.pngSha256);
  }
}
const legacySprite = 'sprite/monstera-v1';
const legacyTrainer = 'trainer/friend-v1';
const legacySpritePng = '95edfb98885bc6df75799ea892270ff06c1d90b469cf627f7d304286ed2503df';
const wordmarkPng = 'c4c26dc37bfc264b6818fa6bef96b8a1e32d07f9a97d7c0af33c5b702b617a9b';
const approvedDevfestPng = '398b6a7890a1c8b09dd632c4f571cc0f1b7d93f85a040d2fefa345eea95a19be';
const approvedSproutPng = '8482b9ee369f0d4f82200c202163b3f6eec769c32ef3cfb7f80b202461592561';
const liveCardPng = '81029cd22190b9ffcf5a58e12c821916c304bc133d1e6f43961b5c391e943af7';
const legacyPngs = new Map([
  [legacySprite, legacySpritePng],
  [legacyTrainer, legacySpritePng],
  ['branding/logo', wordmarkPng],
  ['branding/logo-and-species', wordmarkPng],
  ['branding/logo-and-sprites', wordmarkPng],
  ['branding/devfest-approved-v1', approvedDevfestPng],
  ['branding/sprout-approved-v1', approvedSproutPng],
  ['decoration/live-card-v1', liveCardPng],
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

export function spriteChoices(
  selectedId: string,
  active: readonly SpriteEntry[] = sprites,
  archived: readonly SpriteEntry[] = archivedSprites,
): readonly SpriteEntry[] {
  const selected = [...active, ...archived].find((entry) => entry.id === selectedId);
  return selected && !active.some((entry) => entry.id === selectedId) ? Object.freeze([...active, selected]) : active;
}

export function assertSupportedRecipe(manifest: CompositionManifest, runtimeSpriteId?: string): void {
  if (manifest.renderVersion === 'fixture-v1') {
    if (manifest.spriteAssetId !== legacySprite || (manifest.trainerAssetId !== null && manifest.trainerAssetId !== legacyTrainer)) {
      throw new Error('Unknown fixture layer asset.');
    }
    return;
  }
  const runtime = manifest.renderVersion === 'runtime-catalog-v1' &&
    runtimeSpriteId !== undefined && manifest.spriteAssetId === runtimeSpriteId &&
    /^sprite\/runtime\/[a-f0-9]{64}$/.test(runtimeSpriteId);
  if (manifest.renderVersion !== 'catalog-v1' && !runtime) throw new Error('Unsupported render version.');
  const [main, brand] = manifest.cutGroups;
  if (!(runtime || byId.has(manifest.spriteAssetId)) || manifest.theme !== 'default' || manifest.brandingVariant !== 'logo'
    || manifest.trainerAssetId !== null || manifest.cutGroups.length !== 2
    || main?.id !== 'main' || main.members.length !== 1 || main.members[0] !== 'sprite'
    || brand?.id !== 'brand' || brand.members.length !== 1 || brand.members[0] !== 'branding') {
    throw new Error('Unsupported catalog composition.');
  }
}

export function catalogSpriteEntry(assetId: string): SpriteEntry | undefined {
  return byId.get(assetId);
}

export function spriteArtworkIds(entry: SpriteEntry | undefined, assetId: string, sheetVariant: 'classic' | 'duo' | 'trio' | undefined): readonly string[] {
  if (sheetVariant === 'trio') return entry?.variants
    ? [assetId, entry.variants[0].id, entry.variants[1].id]
    : [assetId, assetId, assetId];
  if (sheetVariant === 'duo') return [assetId, assetId];
  return [assetId];
}

export function assetPngFilename(assetId: string): string {
  const digest = byId.get(assetId)?.pngSha256 ?? variantPngs.get(assetId) ?? legacyPngs.get(assetId);
  if (!digest) throw new Error('Unknown artwork.');
  return digest + '.png';
}

export async function loadPlannedAssets<T extends RgbaAsset>(
  plan: PlannedComposition,
  load: (filename: string, id: string) => Promise<T>,
): Promise<AssetCatalog<T>> {
  const ids = new Set(plan.layers.map((layer) => layer.assetId));
  const loaded = await Promise.all([...ids].map((id) => load(assetPngFilename(id), id)));
  return new Map(loaded.map((asset) => [asset.id, asset]));
}
