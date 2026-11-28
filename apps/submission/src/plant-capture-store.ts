import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { getStorage } from 'firebase-admin/storage';
import sharp from 'sharp';
import { loadRgbaAsset } from '@natcut/render';
import { sourcePhotoDigest, type SourcePhotoReceipt } from './plant-job-contract.ts';
import { verifyResolvedPlantCapture, type PlantCaptureSource, type ResolvedPlantCapture } from './plant-capture.ts';

type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
type CaptureRecord = {
  eventId: string; ownerUid: string; visitorSessionId: string; captureId: string;
  sha256: string; byteLength: number; objectPath: string; objectGeneration: string;
  sourcePhotoReceipt: SourcePhotoReceipt;
};
const idPattern = /^[A-Za-z0-9_-]{1,256}$/;
const generationPattern = /^[1-9][0-9]*$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class PlantCaptureConflictError extends Error {}

export async function normalizePlantPhoto(input: Buffer): Promise<{ bytes: Buffer; receipt: SourcePhotoReceipt }> {
  if (input.length < 1 || input.length > 8_000_000) throw new Error('Plant photo must be at most 8 MB.');
  const source = sharp(input, { failOn: 'warning', limitInputPixels: 24_000_000 });
  const metadata = await source.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height ||
    metadata.width * metadata.height > 24_000_000) throw new Error('Unsupported plant photo.');
  const bytes = await source.autoOrient().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).toColourspace('srgb').withIccProfile('srgb')
    .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  const decoded = await loadRgbaAsset(bytes, 'sanitized-plant-photo', 20_000_000);
  const receipt: SourcePhotoReceipt = { mediaType: 'image/jpeg', width: decoded.width,
    height: decoded.height, colorEvidence: decoded.colorEvidence };
  await verifyResolvedPlantCapture({ visitorSessionId: 'validation', captureId: 'validation',
    sanitizedImage: bytes, sanitizedImageSha256: sourcePhotoDigest(bytes), sourcePhotoReceipt: receipt }, 'validation');
  return { bytes, receipt };
}

export function createPlantCaptureStore(firestore: Firestore, bucket: Bucket): PlantCaptureSource & {
  confirm(ownerUid: string, eventId: string, captureId: string, raw: Buffer): Promise<{ captureId: string; status: 'confirmed' }>;
} {
  const collection = firestore.collection('natcutPlantCaptures');
  const ref = (ownerUid: string, eventId: string, captureId: string) =>
    collection.doc(digest(`${eventId}\0${ownerUid}\0${captureId}`));
  const sessionId = (ownerUid: string, eventId: string) => digest(`${eventId}\0${ownerUid}`);
  const owned = async (ownerUid: string, eventId: string, captureId: string): Promise<CaptureRecord | null> => {
    if (!idPattern.test(ownerUid) || !idPattern.test(eventId) || !idPattern.test(captureId)) return null;
    const snapshot = await ref(ownerUid, eventId, captureId).get();
    if (!snapshot.exists) return null;
    const record = snapshot.data() as CaptureRecord;
    if (record.ownerUid !== ownerUid || record.eventId !== eventId || record.captureId !== captureId ||
      record.visitorSessionId !== sessionId(ownerUid, eventId) ||
      record.objectPath !== `plant-captures/v1/${record.sha256}.jpg` ||
      !/^[a-f0-9]{64}$/.test(record.sha256) || !generationPattern.test(record.objectGeneration)) {
      throw new PlantCaptureConflictError('Plant capture receipt is inconsistent.');
    }
    return record;
  };
  return {
    async confirm(ownerUid, eventId, captureId, raw) {
      if (![ownerUid, eventId, captureId].every(value => idPattern.test(value))) {
        throw new Error('Invalid plant capture identity.');
      }
      const normalized = await normalizePlantPhoto(raw);
      const sha256 = sourcePhotoDigest(normalized.bytes);
      const existing = await owned(ownerUid, eventId, captureId);
      if (existing) {
        if (existing.sha256 !== sha256 || existing.byteLength !== normalized.bytes.length ||
          JSON.stringify(existing.sourcePhotoReceipt) !== JSON.stringify(normalized.receipt)) {
          throw new PlantCaptureConflictError('Capture ID already contains another photo.');
        }
        return { captureId, status: 'confirmed' };
      }
      const objectPath = `plant-captures/v1/${sha256}.jpg`;
      const file = bucket.file(objectPath);
      try {
        await file.save(normalized.bytes, { resumable: false, validation: 'md5',
          preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'image/jpeg' } });
      } catch {
        // A lost acknowledgement and a repeated content address both use exact readback.
      }
      const [objectMetadata] = await file.getMetadata();
      const objectGeneration = String(objectMetadata.generation);
      if (!generationPattern.test(objectGeneration)) throw new PlantCaptureConflictError('Invalid stored photo generation.');
      const pinned = await bucket.file(objectPath, { generation: objectGeneration }).download({ validation: 'md5' });
      if (!pinned[0].equals(normalized.bytes)) throw new PlantCaptureConflictError('Stored photo differs from upload.');
      const record: CaptureRecord = { eventId, ownerUid, visitorSessionId: sessionId(ownerUid, eventId),
        captureId, sha256, byteLength: normalized.bytes.length, objectPath, objectGeneration,
        sourcePhotoReceipt: normalized.receipt };
      await firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref(ownerUid, eventId, captureId));
        if (snapshot.exists) {
          const prior = snapshot.data() as CaptureRecord;
          if (JSON.stringify(prior) !== JSON.stringify(record)) throw new PlantCaptureConflictError('Capture ID already contains another photo.');
        } else transaction.create(ref(ownerUid, eventId, captureId), record);
      });
      return { captureId, status: 'confirmed' };
    },
    async findOwned(ownerUid, eventId, captureId) {
      const record = await owned(ownerUid, eventId, captureId);
      return record ? { visitorSessionId: record.visitorSessionId, captureId: record.captureId } : null;
    },
    async resolveConfirmed(ownerUid, eventId, captureId): Promise<ResolvedPlantCapture | null> {
      const record = await owned(ownerUid, eventId, captureId);
      if (!record) return null;
      const file = bucket.file(record.objectPath, { generation: record.objectGeneration });
      const [metadata] = await file.getMetadata();
      if (String(metadata.generation) !== record.objectGeneration || Number(metadata.size) !== record.byteLength ||
        metadata.contentEncoding) throw new PlantCaptureConflictError('Pinned photo metadata changed.');
      const [sanitizedImage] = await file.download({ validation: 'md5' });
      if (sanitizedImage.length !== record.byteLength || sourcePhotoDigest(sanitizedImage) !== record.sha256) {
        throw new PlantCaptureConflictError('Pinned photo bytes changed.');
      }
      return verifyResolvedPlantCapture({ visitorSessionId: record.visitorSessionId, captureId,
        sanitizedImage, sanitizedImageSha256: record.sha256,
        sourcePhotoReceipt: record.sourcePhotoReceipt }, captureId);
    },
  };
}
