import { loadRgbaAsset } from '@natcut/render';
import sharp from 'sharp';
import { SourcePhotoReceiptSchema, sourcePhotoDigest, type SourcePhotoReceipt } from './plant-job-contract.ts';

export type ResolvedPlantCapture = {
  visitorSessionId: string;
  captureId: string;
  sanitizedImage: Buffer;
  sanitizedImageSha256: string;
  sourcePhotoReceipt: SourcePhotoReceipt;
};

export interface PlantCaptureSource {
  resolveConfirmed(ownerUid: string, eventId: string, captureId: string): Promise<ResolvedPlantCapture | null>;
  findOwned(ownerUid: string, eventId: string, captureId: string): Promise<Pick<ResolvedPlantCapture, 'visitorSessionId' | 'captureId'> | null>;
}

function assertMetadataFree(bytes: Buffer, mediaType: 'image/jpeg' | 'image/png') {
  if (mediaType === 'image/png') {
    const allowed = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'iCCP', 'gAMA', 'cHRM']);
    let ended = false;
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw new Error('Invalid sanitized PNG chunk.');
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > bytes.length) throw new Error('Invalid sanitized PNG chunk length.');
      const chunk = bytes.toString('latin1', offset + 4, offset + 8);
      if (!allowed.has(chunk)) {
        throw new Error('Plant capture contains PNG metadata.');
      }
      if (chunk === 'IEND') {
        if (length !== 0 || end !== bytes.length || ended) throw new Error('Invalid sanitized PNG end.');
        ended = true;
      }
      offset = end;
    }
    if (!ended) throw new Error('Invalid sanitized PNG end.');
    return;
  }
  let inScan = false;
  for (let offset = 2; offset < bytes.length;) {
    if (inScan) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
      if (offset >= bytes.length) break;
    }
    if (bytes[offset] !== 0xff) throw new Error('Invalid sanitized JPEG marker.');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++]!;
    if (inScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    if (marker === 0xd9) {
      if (offset !== bytes.length) throw new Error('Invalid sanitized JPEG trailing data.');
      return;
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error('Invalid sanitized JPEG marker.');
    }
    if (offset + 2 > bytes.length) throw new Error('Invalid sanitized JPEG segment.');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('Invalid sanitized JPEG segment length.');
    const payload = offset + 2;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      const allowedJfif = marker === 0xe0 && bytes.toString('latin1', payload, payload + 5) === 'JFIF\0';
      const allowedIcc = marker === 0xe2 && bytes.toString('latin1', payload, payload + 12) === 'ICC_PROFILE\0';
      if (!allowedJfif && !allowedIcc) throw new Error('Plant capture contains JPEG metadata.');
    }
    offset += length;
    inScan = marker === 0xda;
  }
  throw new Error('Invalid sanitized JPEG scan.');
}

export async function verifyResolvedPlantCapture(capture: ResolvedPlantCapture, requestedCaptureId: string) {
  if (capture.captureId !== requestedCaptureId || !/^[A-Za-z0-9_-]{1,256}$/.test(capture.visitorSessionId) ||
    capture.sanitizedImage.length < 1 || capture.sanitizedImage.length > 20_000_000 ||
    sourcePhotoDigest(capture.sanitizedImage) !== capture.sanitizedImageSha256) {
    throw new Error('Plant capture identity, digest, or length mismatch.');
  }
  const receipt = SourcePhotoReceiptSchema.parse(capture.sourcePhotoReceipt);
  const isPng = capture.sanitizedImage.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const isJpeg = capture.sanitizedImage.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if ((receipt.mediaType === 'image/png') !== isPng || (receipt.mediaType === 'image/jpeg') !== isJpeg) {
    throw new Error('Plant capture media type mismatch.');
  }
  assertMetadataFree(capture.sanitizedImage, receipt.mediaType);
  const metadata = await sharp(capture.sanitizedImage).metadata();
  if (metadata.exif || metadata.xmp || metadata.iptc || metadata.orientation || metadata.comments?.length) {
    throw new Error('Plant capture contains metadata.');
  }
  const decoded = await loadRgbaAsset(capture.sanitizedImage, 'plant-capture', 20_000_000);
  if (decoded.width !== receipt.width || decoded.height !== receipt.height ||
    JSON.stringify(decoded.colorEvidence) !== JSON.stringify(receipt.colorEvidence)) {
    throw new Error('Plant capture dimensions or color evidence mismatch.');
  }
  return { ...capture, sourcePhotoReceipt: receipt };
}
