import sharp from 'sharp';
import { expect, it } from 'vitest';
import { verifyResolvedPlantCapture } from '../src/plant-capture.ts';
import { sourcePhotoDigest } from '../src/plant-job-contract.ts';
import { normalizePlantPhoto } from '../src/plant-capture-store.ts';

it('normalizes a phone photo to a bounded, tagged JPEG without private metadata', async () => {
  const raw = await sharp(Buffer.from([140, 30, 70]), { raw: { width: 1, height: 1, channels: 3 } })
    .withExif({ IFD0: { ImageDescription: 'private location note' } }).png().toBuffer();
  const { bytes, receipt } = await normalizePlantPhoto(raw);
  expect(receipt.mediaType).toBe('image/jpeg');
  expect(bytes.toString('latin1')).not.toContain('private location note');
  await expect(verifyResolvedPlantCapture({ visitorSessionId: 'visitor', captureId: 'capture',
    sanitizedImage: bytes, sanitizedImageSha256: sourcePhotoDigest(bytes), sourcePhotoReceipt: receipt }, 'capture'))
    .resolves.toMatchObject({ sourcePhotoReceipt: receipt });
  await expect(normalizePlantPhoto(Buffer.from('not an image'))).rejects.toThrow();
});
