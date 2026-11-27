import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { NATIVE_SRGB_EVIDENCE, SrgbColorEvidenceSchema, type SrgbColorEvidence } from '@natcut/domain';
import sharp from 'sharp';
import { loadPlannedAssets } from './catalog.ts';
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
// Whole ICC profiles, not mutable descriptions or an RGB channel count. First the three
// libvips built-ins, then Apple's sRGB, Display P3 and Generic CMYK profiles.
const supportedProfiles = new Map<string, SrgbColorEvidence['sourceSpace']>([
  ['c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353', 'srgb'],
  ['231752984cd4a5278e1b8d2390fe496767d4511fc81f54e1a5c69ae9ab4c42b5', 'display-p3'],
  ['156e7c14f244cfc4ed83a755ca4803d80e15dd249b40fae82cb127d3902e15c7', 'cmyk'],
  ['2b3aa1645779a9e634744faf9b01e9102b0c9b88fd6deced7934df86b949af7e', 'srgb'],
  ['0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0', 'display-p3'],
  ['0c8a584b288a306eac9e1d3f1e68bc1b64331c717ceb051420e6257f17b3509a', 'cmyk'],
]);

// Sharp does not expose the PNG sRGB chunk as ICC metadata. Recognize this explicit
// declaration without accepting a guessed color space, contradictory tags, or a bad CRC.
function pngDeclaresSrgb(bytes: Buffer, hasIcc: boolean): boolean {
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
  if (!tag) return false;
  const gamma = chunks.get('gAMA');
  const chroma = chunks.get('cHRM');
  const srgbChroma = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
  if (tag.length !== 1 || tag[0]! > 3 || (gamma && (gamma.length !== 4 || gamma.readUInt32BE() !== 45455)) ||
      (chroma && (chroma.length !== 32 || srgbChroma.some((value, i) => chroma.readUInt32BE(i * 4) !== value)))) {
    throw new Error('Invalid or conflicting PNG sRGB declaration.');
  }
  return true;
}

async function decodeAsset(input: Buffer, id: string, normalizedCatalog: boolean, limitInputPixels?: number) {
  const bytes = Buffer.from(input);
  const image = sharp(bytes, { failOn: 'warning', ...(limitInputPixels === undefined ? {} : { limitInputPixels }) });
  const metadata = await image.metadata();
  const icc = metadata.icc;
  const pngSrgb = metadata.format === 'png' && pngDeclaresSrgb(bytes, !!icc);
  let colorEvidence = NATIVE_SRGB_EVIDENCE;
  if (icc) {
    const sourceProfileSha256 = sha256(icc);
    const sourceSpace = supportedProfiles.get(sourceProfileSha256);
    const expectedBands = sourceSpace === 'cmyk' ? 4 : 3;
    if (!sourceSpace || (metadata.space === 'cmyk') !== (sourceSpace === 'cmyk') ||
        metadata.channels !== expectedBands + Number(metadata.hasAlpha)) {
      throw new Error('Unrecognized or inconsistent embedded ICC profile.');
    }
    colorEvidence = SrgbColorEvidenceSchema.parse({
      ...colorEvidence, sourceSpace, sourceProfileSha256, action: sourceSpace === 'srgb' ? 'preserved' : 'converted',
    });
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

export function loadPackagedAssets(
  plan: PlannedComposition,
  directory = fileURLToPath(new URL('../catalog/artwork/', import.meta.url)),
): Promise<AssetCatalog> {
  return loadPlannedAssets(plan, async (filename, id) => {
    const bytes = await readFile(path.join(directory, filename));
    if (filename !== sha256(bytes) + '.png') throw new Error(`Artwork digest mismatch for ${id}.`);
    // The trusted catalog pins normalized sRGB PNGs by digest, including shipped
    // artwork that predates embedded profiles. External callers cannot take this path.
    return decodeAsset(bytes, id, true);
  });
}
