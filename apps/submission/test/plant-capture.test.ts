import { NATIVE_SRGB_EVIDENCE } from '@natcut/domain';
import { loadRgbaAsset } from '@natcut/render';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { verifyResolvedPlantCapture } from '../src/plant-capture.ts';
import { sourcePhotoDigest } from '../src/plant-job-contract.ts';

it('accepts only the exact tagged, sanitized source receipt resolved for the requested capture', async () => {
  const sanitizedImage = await sharp(Buffer.from([90, 120, 60]), {
    raw: { width: 1, height: 1, channels: 3 },
  }).withIccProfile('srgb').jpeg().toBuffer();
  const colorEvidence = (await loadRgbaAsset(sanitizedImage, 'capture')).colorEvidence;
  const capture = { visitorSessionId: 'session-1', captureId: 'capture-1', sanitizedImage,
    sanitizedImageSha256: sourcePhotoDigest(sanitizedImage),
    sourcePhotoReceipt: { mediaType: 'image/jpeg' as const, width: 1, height: 1, colorEvidence } };
  await expect(verifyResolvedPlantCapture(capture, 'capture-1')).resolves.toMatchObject(capture);
  await expect(verifyResolvedPlantCapture(capture, 'different')).rejects.toThrow(/identity/i);
  await expect(verifyResolvedPlantCapture({ ...capture, sanitizedImageSha256: '0'.repeat(64) }, 'capture-1'))
    .rejects.toThrow(/digest/i);
  await expect(verifyResolvedPlantCapture({ ...capture, sourcePhotoReceipt: {
    ...capture.sourcePhotoReceipt, width: 2 } }, 'capture-1')).rejects.toThrow(/dimensions/i);
  await expect(verifyResolvedPlantCapture({ ...capture, sourcePhotoReceipt: {
    ...capture.sourcePhotoReceipt, mediaType: 'image/png' as const } }, 'capture-1')).rejects.toThrow(/media type/i);
  const withExif = await sharp(Buffer.from([90, 120, 60]), {
    raw: { width: 1, height: 1, channels: 3 },
  }).withIccProfile('srgb').withExif({ IFD0: { ImageDescription: 'private location note' } }).jpeg().toBuffer();
  await expect(verifyResolvedPlantCapture({ ...capture, sanitizedImage: withExif,
    sanitizedImageSha256: sourcePhotoDigest(withExif) }, 'capture-1')).rejects.toThrow(/metadata/i);
  const trailingJpeg = Buffer.concat([sanitizedImage, Buffer.from('GPS PRIVATE DATA')]);
  await expect(verifyResolvedPlantCapture({ ...capture, sanitizedImage: trailingJpeg,
    sanitizedImageSha256: sourcePhotoDigest(trailingJpeg) }, 'capture-1')).rejects.toThrow(/trailing data/i);
  await expect(verifyResolvedPlantCapture({ ...capture, sourcePhotoReceipt: {
    ...capture.sourcePhotoReceipt, colorEvidence: NATIVE_SRGB_EVIDENCE,
  } }, 'capture-1')).rejects.toThrow(/color evidence/i);
  const pngWithDensity = await sharp(Buffer.from([90, 120, 60]), {
    raw: { width: 1, height: 1, channels: 3 },
  }).withIccProfile('srgb').png().toBuffer();
  const pngChunks: Buffer[] = [pngWithDensity.subarray(0, 8)];
  for (let offset = 8; offset < pngWithDensity.length;) {
    const end = offset + 12 + pngWithDensity.readUInt32BE(offset);
    if (pngWithDensity.toString('ascii', offset + 4, offset + 8) !== 'pHYs') {
      pngChunks.push(pngWithDensity.subarray(offset, end));
    }
    offset = end;
  }
  const png = Buffer.concat(pngChunks);
  const pngReceipt = { mediaType: 'image/png' as const, width: 1, height: 1,
    colorEvidence: (await loadRgbaAsset(png, 'capture')).colorEvidence };
  const pngCapture = { ...capture, sanitizedImage: png, sanitizedImageSha256: sourcePhotoDigest(png),
    sourcePhotoReceipt: pngReceipt };
  await expect(verifyResolvedPlantCapture(pngCapture, 'capture-1')).resolves.toMatchObject(pngCapture);
  const trailingPng = Buffer.concat([png, Buffer.from('GPS PRIVATE DATA')]);
  await expect(verifyResolvedPlantCapture({ ...pngCapture, sanitizedImage: trailingPng,
    sanitizedImageSha256: sourcePhotoDigest(trailingPng) }, 'capture-1')).rejects.toThrow(/PNG end/i);
  const missingIend = png.subarray(0, -12);
  await expect(verifyResolvedPlantCapture({ ...pngCapture, sanitizedImage: missingIend,
    sanitizedImageSha256: sourcePhotoDigest(missingIend) }, 'capture-1')).rejects.toThrow(/PNG end/i);
  const untagged = await sharp(Buffer.from([90, 120, 60]), {
    raw: { width: 1, height: 1, channels: 3 },
  }).jpeg().toBuffer();
  await expect(verifyResolvedPlantCapture({ ...capture, sanitizedImage: untagged,
    sanitizedImageSha256: sourcePhotoDigest(untagged), sourcePhotoReceipt: {
      ...capture.sourcePhotoReceipt, colorEvidence: NATIVE_SRGB_EVIDENCE } }, 'capture-1')).rejects.toThrow(/profile|untagged/i);
});
