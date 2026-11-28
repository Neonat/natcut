import type {
  CompositionManifest,
  CutGroupMember,
  PrintProfile,
} from '@natcut/domain';

import { assertSupportedRecipe } from './catalog.ts';

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
    const placements = manifest.sheetVariant === 'trio'
      ? [{ x: 360, y: 110, size: 480 }, { x: 360, y: 700, size: 480 }, { x: 360, y: 1290, size: 480 }]
      : manifest.sheetVariant === 'duo'
        ? [{ x: 300, y: 260, size: 600 }, { x: 300, y: 1080, size: 600 }]
        : [{ x: 220, y: 470, size: 760 }];
    for (const [index, placement] of placements.entries()) {
      layers.push({
        id: index === 0 ? 'sprite' : `sprite-${index + 1}`,
        member: 'sprite',
        assetId: manifest.spriteAssetId,
        cutGroupId: cutGroupFor(manifest, 'sprite'),
        x: placement.x,
        y: placement.y,
        width: placement.size,
        height: placement.size,
        zIndex: 10,
      });
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

  const plan: PlannedComposition = {
    width: profile.sheetWidthPx,
    height: profile.sheetHeightPx,
    cutGroupIds: manifest.cutGroups.map((group) => group.id),
    layers: layers.sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id)),
  };
  assertPlanWithinSheet(plan);
  return plan;
}
