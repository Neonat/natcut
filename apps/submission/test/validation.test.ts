import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { DEVFEST_SG_V1, decodeLogicalSourceBundle } from '@natcut/domain';
import { catalogManifest, loadPackagedAssets, planComposition, renderServerRaster } from '@natcut/render';
import { createTrustedArtifactPreparer, createTrustedManifestValidator } from '../src/index.ts';

const historicalMaskHash = '1465f6f4822228afd53188f8490373156e9005a673cf06a6f3da849ecf90e84d';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('prepares the packaged server color, expanded mask, contours and a verified V2 bundle', async () => {
  const plan = planComposition(catalogManifest, DEVFEST_SG_V1);
  const assets = await loadPackagedAssets(plan);
  const reference = await renderServerRaster(plan, assets);
  const prepared = await createTrustedArtifactPreparer()(catalogManifest);
  const { descriptor, bytes } = prepared.bundle;
  const decoded = await decodeLogicalSourceBundle(bytes, descriptor);

  expect(prepared.profile).toBe(DEVFEST_SG_V1);
  expect(descriptor).toMatchObject({ formatVersion: 2, colorEvidence: reference.colorEvidence });
  expect(descriptor.profile).toEqual(prepared.profile);
  expect(prepared.raster.sha256).toBe(reference.sha256);
  expect(digest(decoded.rgba)).toBe(reference.sha256);
  expect(digest(decoded.mask)).toBe(historicalMaskHash);
  expect(digest(prepared.combinedMask.data)).toBe(historicalMaskHash);
  expect(descriptor.renderVersion).toBe(catalogManifest.renderVersion);
  expect(descriptor.geometryVersion).toBe(prepared.report.geometryVersion);
  expect(prepared.contours).toHaveLength(prepared.report.contourCount);
  expect(await createTrustedManifestValidator()(catalogManifest)).toEqual(prepared.report);
  expect(prepared.report.rasterHash).toBe(historicalMaskHash);
});

it('preserves mask acknowledgements across server artwork color changes', async () => {
  const assets = await loadPackagedAssets(planComposition(catalogManifest, DEVFEST_SG_V1));
  const prepare = createTrustedArtifactPreparer(assets);
  const original = await prepare(catalogManifest);
  const recolored = new Map(assets);
  const sprite = assets.get(catalogManifest.spriteAssetId)!;
  const rgba = sprite.rgba.slice();
  for (let i = 0; i < rgba.length; i += 4) rgba[i] = 255 - rgba[i]!;
  recolored.set(sprite.id, { ...sprite, rgba });
  const changed = await createTrustedArtifactPreparer(recolored)(catalogManifest);
  expect(changed.report.rasterHash).toBe(original.report.rasterHash);
  expect(changed.bundle.descriptor.maskSha256).toBe(original.bundle.descriptor.maskSha256);
  expect(changed.bundle.descriptor.colorSha256).not.toBe(original.bundle.descriptor.colorSha256);
  expect(changed.bundle.descriptor.bundleSha256).not.toBe(original.bundle.descriptor.bundleSha256);
});

it('rejects unpublished profiles and artifact fields supplied in a manifest', async () => {
  expect(() => createTrustedArtifactPreparer(undefined, { ...DEVFEST_SG_V1, copies: 3 })).toThrow(/profile/i);
  await expect(createTrustedManifestValidator(undefined, { ...DEVFEST_SG_V1, copies: 3 })(catalogManifest))
    .resolves.toMatchObject({ valid: true });
  await expect(createTrustedManifestValidator(undefined, { ...DEVFEST_SG_V1, label: 'rehearsal' } as never)(catalogManifest))
    .resolves.toMatchObject({ valid: true });
  const forged = { ...catalogManifest, raster: { sha256: '0'.repeat(64) } };
  await expect(createTrustedArtifactPreparer()(forged)).rejects.toThrow();
});
