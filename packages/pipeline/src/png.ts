import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { WireFailure } from './sse.ts';

const MAX_PNG_BYTES = 1024 * 1024;
const MAX_PIXELS = 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function validatedPng(base64: unknown): Promise<string> {
  if (typeof base64 !== 'string' || !base64) throw new WireFailure('malformed');
  if (base64.length > 4 * Math.ceil(MAX_PNG_BYTES / 3)) throw new WireFailure('too-large');
  const png = Buffer.from(base64, 'base64');
  if (png.length > MAX_PNG_BYTES) throw new WireFailure('too-large');
  if (png.toString('base64') !== base64 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new WireFailure('malformed');
  }

  // Image decoders may ignore trailing bytes, ancillary chunks or a missing IEND.
  let ended = false;
  for (let offset = 8; offset < png.length;) {
    if (png.length - offset < 12) throw new WireFailure('malformed');
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (end + 4 > png.length || crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end)) {
      throw new WireFailure('malformed');
    }
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw new WireFailure('malformed');
      const pixels = png.readUInt32BE(offset + 8) * png.readUInt32BE(offset + 12);
      if (pixels > MAX_PIXELS) throw new WireFailure('too-large');
    }
    if (type === 'acTL') throw new WireFailure('malformed');
    offset = end + 4;
    if (type === 'IEND') {
      if (length !== 0 || offset !== png.length) throw new WireFailure('malformed');
      ended = true;
    }
  }
  if (!ended) throw new WireFailure('malformed');
  try {
    await sharp(png, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).raw().toBuffer();
  } catch {
    throw new WireFailure('malformed');
  }
  return base64;
}
