import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEVFEST_SG_V1, CompositionManifestSchema } from '@natcut/domain';
import { describe, expect, it } from 'vitest';
import {
  assetPngFilename,
  loadPackagedAssets,
  planComposition,
  renderCutGroupMasks,
  renderServerRaster,
  type AssetCatalog,
  type PlannedComposition,
  type RgbaAsset,
} from '../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

const manifest = CompositionManifestSchema.parse({
  schemaVersion: 1,
  spriteAssetId: 'sprite/monstera-v1',
  trainerAssetId: null,
  theme: 'default',
  brandingVariant: 'logo',
  cutGroups: [
    { id: 'main', members: ['sprite'] },
    { id: 'brand', members: ['branding'] },
  ],
  cutMarginMm: 1.5,
  renderVersion: 'fixture-v1',
});

function solidAsset(id: string, red: number, green: number, blue: number): RgbaAsset {
  return {
    id,
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray([
      red, green, blue, 255,
      red, green, blue, 255,
      red, green, blue, 255,
      red, green, blue, 255,
    ]),
  };
}

const assets: AssetCatalog = new Map([
  ['sprite/monstera-v1', solidAsset('sprite/monstera-v1', 58, 148, 92)],
  ['branding/logo', solidAsset('branding/logo', 25, 72, 58)],
]);

describe('planComposition', () => {
  it.each([
    { renderVersion: 'unknown-v2' },
    { spriteAssetId: 'branding/logo' },
    { spriteAssetId: 'trainer/friend-v1' },
  ])('rejects unsupported recipes and swapped layer roles before rasterizing: %j', (change) => {
    expect(() => planComposition({ ...manifest, ...change }, DEVFEST_SG_V1)).toThrow();
  });

  it('produces the fixed 1200x2100 default layout in deterministic layer order', async () => {
    const expected = JSON.parse(
      await readFile(path.join(here, 'fixtures/expected-layout.json'), 'utf8'),
    ) as unknown;

    expect(planComposition(manifest, DEVFEST_SG_V1)).toEqual(expected);
    expect(planComposition(manifest, DEVFEST_SG_V1)).toEqual(expected);
  });

  it('keeps every planned layer inside the logical sheet', () => {
    const plan = planComposition(manifest, DEVFEST_SG_V1);

    for (const layer of plan.layers) {
      expect(layer.x).toBeGreaterThanOrEqual(0);
      expect(layer.y).toBeGreaterThanOrEqual(0);
      expect(layer.x + layer.width).toBeLessThanOrEqual(1_200);
      expect(layer.y + layer.height).toBeLessThanOrEqual(2_100);
    }
  });

  it('brings battling portrait subjects close enough for the overlap-warning fixture', () => {
    const portrait = CompositionManifestSchema.parse({
      ...manifest,
      trainerAssetId: 'trainer/friend-v1',
      theme: 'battling',
      cutGroups: [
        { id: 'trainer', members: ['trainer'] },
        { id: 'sprite', members: ['sprite'] },
        { id: 'brand', members: ['branding'] },
      ],
    });
    const plan = planComposition(portrait, DEVFEST_SG_V1);
    expect(plan.layers.find((layer) => layer.id === 'sprite')?.x).toBe(590);
  });
});

describe('asset loading and masks', () => {
  it('rejects packaged PNG bytes that no longer match a ticket’s immutable asset identity', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'natcut-changed-art-'));
    try {
      const logo = assetPngFilename('branding/logo');
      await cp(path.resolve(here, '../catalog/artwork', logo), path.join(directory, logo));
      await cp(path.join(directory, logo), path.join(directory, assetPngFilename(manifest.spriteAssetId)));
      await expect(loadPackagedAssets(planComposition(manifest, DEVFEST_SG_V1), directory)).rejects.toThrow(/digest/i);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('loads the approved fixture sprite as RGBA', async () => {
    const packaged = await loadPackagedAssets(planComposition(manifest, DEVFEST_SG_V1));
    const asset = packaged.get('sprite/monstera-v1')!;
    expect(asset.id).toBe('sprite/monstera-v1');
    expect(asset.width).toBeGreaterThan(0);
    expect(asset.height).toBeGreaterThan(0);
    expect(asset.rgba).toHaveLength(asset.width * asset.height * 4);
  });

  it('renders one alpha mask per declared cut group and leaves the sheet corner transparent', () => {
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const masks = renderCutGroupMasks(plan, assets);

    expect(masks.map((mask) => mask.id)).toEqual(['main', 'brand']);
    expect(masks.every((mask) => mask.width === 1_200 && mask.height === 2_100)).toBe(true);
    expect(masks.every((mask) => mask.alpha[0] === 0)).toBe(true);
    expect(masks[0]?.alpha[600 * 1_200 + 600]).toBe(255);
  });

  it('rejects a missing planned asset', () => {
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const missingBrand = new Map([['sprite/monstera-v1', assets.get('sprite/monstera-v1')!]]);

    expect(() => renderCutGroupMasks(plan, missingBrand)).toThrow(/branding\/logo/);
  });
});

describe('renderServerRaster', () => {
  it('renders identical raster hashes for identical plans', async () => {
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const first = await renderServerRaster(plan, assets);
    const second = await renderServerRaster(plan, assets);

    expect(first.width).toBe(1_200);
    expect(first.height).toBe(2_100);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(second.rgba).toEqual(first.rgba);
    expect(first.rgba[3]).toBe(0);
  });

  it('uses the same alpha resampling for the trusted raster and cut masks', async () => {
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const realAssets = await loadPackagedAssets(plan);
    const raster = await renderServerRaster(plan, realAssets);
    const masks = renderCutGroupMasks(plan, realAssets);
    let mismatchCount = 0;
    for (let pixel = 0; pixel < plan.width * plan.height; pixel++) {
      const rasterForeground = raster.rgba[pixel * 4 + 3]! >= DEVFEST_SG_V1.alphaThreshold;
      const maskForeground = masks.some((mask) => mask.alpha[pixel]! >= DEVFEST_SG_V1.alphaThreshold);
      if (rasterForeground !== maskForeground) mismatchCount++;
    }
    expect(mismatchCount).toBe(0);
  });

  it('hard-fails before rendering a layer outside the sheet', async () => {
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const invalid: PlannedComposition = {
      ...plan,
      layers: [{ ...plan.layers[0]!, x: -1 }, ...plan.layers.slice(1)],
    };

    expect(() => renderCutGroupMasks(invalid, assets)).toThrow(/outside/i);
    await expect(renderServerRaster(invalid, assets)).rejects.toThrow(/outside/i);
  });
});
