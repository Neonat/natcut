import sharp from 'sharp';

export type RgbaAsset = {
  id: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

export type AssetCatalog = ReadonlyMap<string, RgbaAsset>;

export async function loadRgbaAsset(filePath: string, id: string): Promise<RgbaAsset> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    id,
    width: info.width,
    height: info.height,
    rgba: new Uint8ClampedArray(data),
  };
}
