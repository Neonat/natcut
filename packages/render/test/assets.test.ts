import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { DEVFEST_SG_V1 } from '@natcut/domain';
import { catalogManifest, loadPackagedAssets, loadRgbaAsset, planComposition, renderServerRaster } from '../src/index.ts';

const native = { outputSpace: 'srgb', pipelineVersion: 'natcut-srgb-v1',
  sources: [{ sourceSpace: 'srgb', sourceProfileSha256: null, action: 'preserved' }] };
const plan = planComposition(catalogManifest, DEVFEST_SG_V1);

function swatch() {
  return sharp(Buffer.from([176, 92, 63, 255]), { raw: { width: 1, height: 1, channels: 4 } });
}

it.each(['srgb', 'p3', 'cmyk'] as const)('interprets the actual embedded %s profile before composing layers', async profile => {
  const image = swatch().withIccProfile(profile);
  const bytes = await (profile === 'cmyk' ? image.tiff({ compression: 'none' }) : image.png()).toBuffer();
  const { icc } = await sharp(bytes).metadata();
  const asset = await loadRgbaAsset(bytes, catalogManifest.spriteAssetId);
  const sourceSpace = profile === 'p3' ? 'display-p3' : profile;
  expect(asset.colorEvidence).toEqual({
    ...native, sources: [{ sourceSpace, sourceProfileSha256: createHash('sha256').update(icc!).digest('hex'),
      action: profile === 'srgb' ? 'preserved' : 'converted' }],
  });
  // The stored Display P3 triplet is [165,96,69]. These are the sRGB values after the ICC transform.
  expect(Array.from(asset.rgba)).toEqual(profile === 'cmyk' ? [172, 82, 39, 255] : [176, 92, 63, 255]);
  const catalog = await loadPackagedAssets(plan);
  expect(catalog.get('branding/logo')!.colorEvidence).toEqual(native);
  const raster = await renderServerRaster({ ...plan, layers: [plan.layers[0]!] }, new Map(catalog).set(asset.id, asset));
  expect(raster.colorEvidence).toEqual(asset.colorEvidence);
  expect(Object.isFrozen(raster.colorEvidence)).toBe(true);
});

it('rejects untagged external pixels even when Sharp reports sRGB', async () => {
  const image = await swatch().png().toBuffer();
  expect(await sharp(image).metadata()).toMatchObject({ space: 'srgb', hasProfile: false });
  await expect(loadRgbaAsset(image, 'external')).rejects.toThrow(/profile|untagged/i);
});

// Insert an ancillary chunk immediately after IHDR; metadata must agree with the pixels.
function tagPng(bytes: Buffer, type: string, value: Buffer) {
  const chunk = Buffer.alloc(12 + value.length);
  chunk.writeUInt32BE(value.length, 0);
  chunk.write(type, 4);
  value.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]);
}

it('accepts an explicit PNG sRGB declaration and rejects conflicting or duplicate declarations', async () => {
  const png = await swatch().png().toBuffer();
  const declared = tagPng(png, 'sRGB', Buffer.from([0]));
  const asset = await loadRgbaAsset(declared, 'swatch');
  expect(asset.colorEvidence).toEqual(native);
  expect(Array.from(asset.rgba)).toEqual([176, 92, 63, 255]);
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(100000);
  await expect(loadRgbaAsset(tagPng(declared, 'gAMA', gamma), 'external')).rejects.toThrow();
  await expect(loadRgbaAsset(tagPng(declared, 'sRGB', Buffer.from([1])), 'external')).rejects.toThrow();
  await expect(loadRgbaAsset(tagPng(await swatch().withIccProfile('p3').png().toBuffer(), 'sRGB', Buffer.from([0])), 'external')).rejects.toThrow();
});

it('rejects an unrecognized ICC even when its profile description still says sRGB', async () => {
  const png = await swatch().png().toBuffer();
  const { icc } = await sharp(await swatch().withIccProfile('srgb').png().toBuffer()).metadata();
  const changed = Buffer.from(icc!);
  changed.write('TEST', 80); // ICC creator signature, independent of the description tag.
  const profile = Buffer.concat([Buffer.from('sRGB\0\0'), deflateSync(changed)]);
  await expect(loadRgbaAsset(tagPng(png, 'iCCP', profile), 'external')).rejects.toThrow(/profile/i);
});

it('keeps both distinct ICCs in a single composed receipt', async () => {
  const layers = await loadPackagedAssets(plan);
  const sprite = await loadRgbaAsset(await swatch().withIccProfile('p3').png().toBuffer(), catalogManifest.spriteAssetId);
  const logo = await loadRgbaAsset(await swatch().withIccProfile('cmyk').tiff({ compression: 'none' }).toBuffer(), 'branding/logo');
  const raster = await renderServerRaster(plan, new Map(layers).set(sprite.id, sprite).set(logo.id, logo));
  expect(raster.colorEvidence.sources).toEqual([...logo.colorEvidence.sources, ...sprite.colorEvidence.sources]);
});

it('rejects conflicting gamma and chromaticities paired with a recognized sRGB ICC', async () => {
  const png = await swatch().withIccProfile('srgb').png().toBuffer();
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(100000);
  await expect(loadRgbaAsset(tagPng(png, 'gAMA', gamma), 'external')).rejects.toThrow();
  await expect(loadRgbaAsset(tagPng(png, 'cHRM', Buffer.alloc(32)), 'external')).rejects.toThrow();
});
