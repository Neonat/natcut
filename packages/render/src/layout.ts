import type {
  CompositionManifest,
  CutGroupMember,
  PrintProfile,
} from '@natcut/domain';

import { assertSupportedRecipe, catalogSpriteEntry, spriteArtworkIds } from './catalog.ts';

export type PlannedLayer = {
  id: string;
  member: CutGroupMember;
  assetId: string;
  cutGroupId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  flipX?: boolean;
};

export type PlannedComposition = {
  width: number;
  height: number;
  cutGroupIds: string[];
  layers: PlannedLayer[];
};

function cutGroupFor(manifest: CompositionManifest, member: CutGroupMember): string {
  const group = manifest.cutGroups.find((candidate) => candidate.members.includes(member));
  if (!group) throw new Error(`No cut group declares the ${member} layer`);
  return group.id;
}

function brandingAssetId(manifest: CompositionManifest): string {
  if (manifest.brandingVariant === 'logo') return 'branding/logo';
  if (manifest.brandingVariant === 'logo-and-sprites') return 'branding/logo-and-sprites';
  return 'branding/logo-and-species';
}

export function assertPlanWithinSheet(plan: PlannedComposition): void {
  for (const layer of plan.layers) {
    const integers = [layer.x, layer.y, layer.width, layer.height];
    if (!integers.every(Number.isInteger) || layer.width <= 0 || layer.height <= 0) {
      throw new Error(`Layer ${layer.id} has invalid pixel bounds`);
    }
    if (
      layer.x < 0 ||
      layer.y < 0 ||
      layer.x + layer.width > plan.width ||
      layer.y + layer.height > plan.height
    ) {
      throw new Error(`Layer ${layer.id} is outside the ${plan.width}x${plan.height} sheet`);
    }
  }
}

export function planComposition(
  manifest: CompositionManifest,
  profile: PrintProfile,
  runtimeSpriteId?: string,
): PlannedComposition {
  assertSupportedRecipe(manifest, runtimeSpriteId);
  const layers: PlannedLayer[] = [];

  if (manifest.trainerAssetId === null) {
    const artworkIds = spriteArtworkIds(catalogSpriteEntry(manifest.spriteAssetId), manifest.spriteAssetId, manifest.sheetVariant);
    const runtime = manifest.renderVersion === 'runtime-catalog-v1';
    const placements: { x: number; y: number; size: number; flipX?: boolean }[] = manifest.sheetVariant === 'trio'
      ? runtime
        ? [{ x: 330, y: 50, size: 540, flipX: false }, { x: 220, y: 700, size: 390, flipX: false },
          { x: 625, y: 1280, size: 390, flipX: true }]
        : [{ x: 360, y: 70, size: 480 }, { x: 360, y: 660, size: 480 }, { x: 360, y: 1250, size: 480 }]
      : manifest.sheetVariant === 'duo'
        ? [{ x: 300, y: 260, size: 600 }, { x: 300, y: 1080, size: 600 }]
        : [{ x: 220, y: 470, size: 760 }];
    for (const [index, placement] of placements.entries()) {
      layers.push({
        id: index === 0 ? 'sprite' : `sprite-${index + 1}`,
        member: 'sprite',
        assetId: artworkIds[index]!,
        cutGroupId: cutGroupFor(manifest, 'sprite'),
        x: placement.x,
        y: placement.y,
        width: placement.size,
        height: placement.size,
        zIndex: 10,
        ...(placement.flipX === undefined ? {} : { flipX: placement.flipX }),
      });
    }
    if (runtime && manifest.sheetVariant === 'trio') {
      for (const [index, y] of [690, 1270].entries()) {
        layers.push({ id: `sprite-card-${index + 2}`, member: 'sprite', assetId: 'decoration/live-card-v1',
          cutGroupId: cutGroupFor(manifest, 'sprite'), x: 170, y, width: 860, height: 410, zIndex: 5 });
      }
      layers.push(
        { id: 'sprite-card-sprout', member: 'sprite', assetId: 'branding/sprout-approved-v1',
          cutGroupId: cutGroupFor(manifest, 'sprite'), x: 620, y: 805, width: 350, height: 130, zIndex: 20 },
        { id: 'sprite-card-devfest', member: 'sprite', assetId: 'branding/devfest-approved-v1',
          cutGroupId: cutGroupFor(manifest, 'sprite'), x: 235, y: 1390, width: 350, height: 119, zIndex: 20 },
      );
    }
  } else {
    layers.push(
      {
        id: 'trainer',
        member: 'trainer',
        assetId: manifest.trainerAssetId,
        cutGroupId: cutGroupFor(manifest, 'trainer'),
        x: 150,
        y: 470,
        width: 540,
        height: 810,
        zIndex: 10,
      },
      {
        id: 'sprite',
        member: 'sprite',
        assetId: manifest.spriteAssetId,
        cutGroupId: cutGroupFor(manifest, 'sprite'),
        x: manifest.theme === 'battling' ? 590 : 650,
        y: 680,
        width: 420,
        height: 420,
        zIndex: 20,
      },
    );
  }

  const approvedTrio = manifest.renderVersion === 'catalog-v1' && manifest.sheetVariant === 'trio'
    && catalogSpriteEntry(manifest.spriteAssetId)?.variants !== undefined;
  if (approvedTrio) {
    layers.push(
      { id: 'branding-devfest', member: 'branding', assetId: 'branding/devfest-approved-v1',
        cutGroupId: cutGroupFor(manifest, 'branding'), x: 60, y: 1850, width: 500, height: 170, zIndex: 20 },
      { id: 'branding-sprout', member: 'branding', assetId: 'branding/sprout-approved-v1',
        cutGroupId: cutGroupFor(manifest, 'branding'), x: 640, y: 1830, width: 500, height: 210, zIndex: 20 },
    );
  } else {
    layers.push({
      id: 'branding',
      member: 'branding',
      assetId: brandingAssetId(manifest),
      cutGroupId: cutGroupFor(manifest, 'branding'),
      x: 390,
      y: 1850,
      width: 420,
      height: 105,
      zIndex: manifest.trainerAssetId === null ? 20 : 30,
    });
  }

  const plan: PlannedComposition = {
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    cutGroupIds: manifest.cutGroups.map((group) => group.id),
    layers: layers.sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id)),
  };
  assertPlanWithinSheet(plan);
  return plan;
}
