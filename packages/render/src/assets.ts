import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { DEVFEST_SG_V1, NATIVE_SRGB_EVIDENCE, SrgbColorEvidenceSchema, srgbColorEvidence, recognizedIccSpace, type SourceColorEvidence, type SrgbColorEvidence } from '@natcut/domain';
import sharp from 'sharp';
import { catalogSpriteEntry, loadPlannedAssets, type SpriteEntry } from './catalog.ts';
import type { PlannedComposition } from './layout.ts';

export type RgbaAsset = {
  id: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};
export type SrgbRgbaAsset = RgbaAsset & { readonly colorEvidence: SrgbColorEvidence };
export type AssetCatalog<T extends RgbaAsset = SrgbRgbaAsset> = ReadonlyMap<string, T>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Sharp does not expose the PNG sRGB chunk as ICC metadata. Recognize this explicit
// declaration without accepting a guessed color space, contradictory tags, or a bad CRC.
function pngDeclaresSrgb(bytes: Buffer, hasIcc: boolean, iccSpace: SourceColorEvidence['sourceSpace'] | undefined): boolean {
  const chunks = new Map<string, Buffer>();
  let seenPixels = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Invalid PNG chunk.');
    const size = bytes.readUInt32BE(offset);
    const end = offset + 8 + size;
    if (end + 4 > bytes.length) throw new Error('Invalid PNG chunk length.');
    const name = bytes.toString('latin1', offset + 4, offset + 8);
    if (name === 'PLTE' || name === 'IDAT') seenPixels = true;
    if (['sRGB', 'iCCP', 'cICP', 'gAMA', 'cHRM'].includes(name)) {
      if (seenPixels || chunks.has(name) || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) {
        throw new Error('Invalid PNG color profile declaration.');
      }
      chunks.set(name, bytes.subarray(offset + 8, end));
    }
    offset = end + 4;
  }
  const tag = chunks.get('sRGB');
  if (chunks.has('cICP') || chunks.has('iCCP') !== hasIcc || (tag && hasIcc)) {
    throw new Error('Ambiguous or unsupported PNG color profile.');
  }
  const gamma = chunks.get('gAMA');
  const chroma = chunks.get('cHRM');
  if (!tag && iccSpace !== 'srgb') {
    if (hasIcc && (gamma || chroma)) throw new Error('Cannot verify PNG gamma or chromaticities against the embedded profile.');
    return false;
  }
  const srgbChroma = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
  if ((tag && (tag.length !== 1 || tag[0]! > 3)) || (gamma && (gamma.length !== 4 || gamma.readUInt32BE() !== 45455)) ||
      (chroma && (chroma.length !== 32 || srgbChroma.some((value, i) => chroma.readUInt32BE(i * 4) !== value)))) {
    throw new Error('Invalid or conflicting PNG sRGB declaration.');
  }
  return !!tag;
}

async function decodeAsset(input: Buffer, id: string, normalizedCatalog: boolean, limitInputPixels?: number) {
  const bytes = Buffer.from(input);
  const image = sharp(bytes, { failOn: 'warning', ...(limitInputPixels === undefined ? {} : { limitInputPixels }) });
  const metadata = await image.metadata();
  const icc = metadata.icc;
  const sourceProfileSha256 = icc ? sha256(icc) : null;
  const sourceSpace = sourceProfileSha256 ? recognizedIccSpace(sourceProfileSha256) : undefined;
  const pngSrgb = metadata.format === 'png' && pngDeclaresSrgb(bytes, !!icc, sourceSpace);
  let colorEvidence = NATIVE_SRGB_EVIDENCE;
  if (icc) {
    const expectedBands = sourceSpace === 'cmyk' ? 4 : 3;
    if (!sourceSpace || (metadata.space === 'cmyk') !== (sourceSpace === 'cmyk') ||
        metadata.channels !== expectedBands + Number(metadata.hasAlpha)) {
      throw new Error('Unrecognized or inconsistent embedded ICC profile.');
    }
    colorEvidence = srgbColorEvidence([
      { sourceSpace, sourceProfileSha256, action: sourceSpace === 'srgb' ? 'preserved' : 'converted' },
    ]);
  } else if (!pngSrgb && !normalizedCatalog) {
    throw new Error('Untagged image requires a recognized color profile.');
  }
  // libvips applies embedded ICC conversion in the decode pipeline. Specify the
  // destination profile explicitly (also for 16-bit input) and reject codec warnings.
  const { data, info } = await image.autoOrient().withIccProfile('srgb', { attach: false })
    .toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error('Expected an RGBA8 raster after sRGB conversion.');
  return { id, width: info.width, height: info.height, rgba: new Uint8ClampedArray(data), colorEvidence };
}

export async function loadRgbaAsset(input: string | Buffer, id: string, limitInputPixels?: number): Promise<SrgbRgbaAsset> {
  return decodeAsset(typeof input === 'string' ? await readFile(input) : input, id, false, limitInputPixels);
}

// PNG sRGB chunk, perceptual intent (0), with its standard length and CRC. The
// raw PNG encoder writes IHDR at offset 8 and emits no other color declarations.
const pngSrgbChunk = Buffer.from('000000017352474200aece1ce9', 'hex');

export async function normalizeSpritePng(bytes: Buffer, name: string, limitInputPixels?: number) {
  const { rgba, width, height, colorEvidence } = await loadRgbaAsset(bytes, name, limitInputPixels);
  const side = Math.min(760, Math.max(width, height));
  const { data, info } = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw().toBuffer({ resolveWithObject: true });
  if (!data.some((value, offset) => offset % 4 === 3 && value >= DEVFEST_SG_V1.alphaThreshold)) {
    throw new Error(`Artwork for ${name} has no pixels above the print alpha threshold.`);
  }
  const png = await sharp(data, { raw: info }).png().toBuffer();
  return { png: Buffer.concat([png.subarray(0, 33), pngSrgbChunk, png.subarray(33)]), side, colorEvidence };
}

export function catalogSpriteId(entry: Pick<SpriteEntry, 'name' | 'scientificName' | 'pngSha256' | 'colorEvidence'>): string {
  const identity: unknown[] = [entry.name, entry.scientificName ?? null, entry.pngSha256];
  if (entry.colorEvidence !== undefined) identity.push(SrgbColorEvidenceSchema.parse(entry.colorEvidence));
  return 'sprite/' + sha256(Buffer.from(JSON.stringify(identity)));
}

export function loadPackagedAssets(
  plan: PlannedComposition,
  directory = fileURLToPath(new URL('../catalog/artwork/', import.meta.url)),
): Promise<AssetCatalog> {
  return loadPlannedAssets(plan, async (filename, id) => {
    const bytes = await readFile(path.join(directory, filename));
    if (filename !== sha256(bytes) + '.png') throw new Error(`Artwork digest mismatch for ${id}.`);
    // The trusted catalog pins normalized sRGB PNGs by digest, including shipped
    // artwork that predates embedded profiles. External callers cannot take this path.
    const entry = catalogSpriteEntry(id);
    if (entry && catalogSpriteId(entry) !== id) throw new Error(`Catalog sprite identity mismatch for ${id}.`);
    const decoded = await decodeAsset(bytes, id, true);
    if (decoded.colorEvidence.sources.some(source => source.sourceSpace !== 'srgb')) throw new Error('Catalog PNG pixels must already be normalized to sRGB.');
    return { ...decoded, colorEvidence: entry?.colorEvidence ?? decoded.colorEvidence };
  });
}
