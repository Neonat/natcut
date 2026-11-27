import { createHash } from 'node:crypto';
import { DEVFEST_SG_V1, SrgbColorEvidenceSchema, type SrgbColorEvidence } from '@natcut/domain';
import { loadRgbaAsset, normalizeSpritePng, type SrgbRgbaAsset } from '@natcut/render';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { type PlantFlowKey, type PlantFlowRepository } from './plant-flow-repository.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.string().regex(/^[1-9][0-9]*$/);
const id = z.string().min(1).max(256);
const RuntimeSpriteReceiptSchema = z.object({
  receiptVersion: z.literal('natcut-runtime-sprite-v1'),
  assetId: z.string().regex(/^sprite\/runtime\/[a-f0-9]{64}$/),
  flowKey: z.object({ eventId: id, visitorSessionId: id, captureId: id }).strict(),
  generationIntentId: id,
  plantJobId: id,
  candidateId: id,
  sourceObjectGeneration: generation,
  sourceSha256: digest,
  sourceByteLength: z.number().int().positive().max(20_000_000),
  pngSha256: digest,
  pngByteLength: z.number().int().positive().max(20_000_000),
  objectPath: z.string().regex(/^runtime-sprites\/v1\/[a-f0-9]{64}\.png$/),
  objectGeneration: generation,
  colorEvidence: SrgbColorEvidenceSchema,
}).strict();
export type RuntimeSpriteReceipt = z.infer<typeof RuntimeSpriteReceiptSchema>;

export interface RuntimeSpriteObjectStore {
  publishCreateOnly(path: string, bytes: Buffer): Promise<{ generation: string }>;
  readExact(path: string, generation: string): Promise<Buffer>;
}

export type StageRuntimeSpriteInput = {
  flowKey: PlantFlowKey;
  generationIntentId: string;
  plantJobId: string;
  candidateId: string;
  sourceObjectGeneration: string;
  sourcePng: Buffer;
  sourceSha256: string;
  sourceByteLength: number;
  png: Buffer;
  pngSha256: string;
  colorEvidence: SrgbColorEvidence;
};

export class RuntimeSpriteIntegrityError extends Error {}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function objectPath(pngSha256: string) { return `runtime-sprites/v1/${pngSha256}.png`; }
function receiptId(input: Omit<RuntimeSpriteReceipt, 'assetId'>): string {
  return sha256(Buffer.from(JSON.stringify([
    input.flowKey.eventId, input.flowKey.visitorSessionId, input.flowKey.captureId,
    input.generationIntentId, input.plantJobId, input.candidateId,
    input.sourceObjectGeneration, input.sourceSha256, input.sourceByteLength,
    input.pngSha256, input.objectGeneration, input.colorEvidence,
  ])));
}

export function createRuntimeSpriteRegistry(deps: {
  firestore: Firestore;
  flows: PlantFlowRepository;
  objects: RuntimeSpriteObjectStore;
}) {
  const collection = deps.firestore.collection('runtimeSpriteReceipts');
  return {
    async stage(input: StageRuntimeSpriteInput): Promise<string> {
      const flow = await deps.flows.get(input.flowKey);
      if (!flow || flow.generationIntentId !== input.generationIntentId ||
        flow.plantJobId !== input.plantJobId || flow.eligibility !== 'eligible') {
        throw new RuntimeSpriteIntegrityError('Plant flow is not eligible for private candidate staging.');
      }
      const pngSha256 = sha256(input.png);
      if (pngSha256 !== input.pngSha256 || input.png.length > 20_000_000) {
        throw new RuntimeSpriteIntegrityError('Runtime sprite digest or length mismatch.');
      }
      if (input.sourcePng.length !== input.sourceByteLength || input.sourcePng.length > 20_000_000 ||
        sha256(input.sourcePng) !== input.sourceSha256) {
        throw new RuntimeSpriteIntegrityError('Source candidate digest or length mismatch.');
      }
      const renormalized = await normalizeSpritePng(input.sourcePng, input.candidateId, 20_000_000);
      if (!renormalized.png.equals(input.png) ||
        JSON.stringify(renormalized.colorEvidence) !== JSON.stringify(input.colorEvidence)) {
        throw new RuntimeSpriteIntegrityError('Staged PNG or color evidence differs from trusted normalization.');
      }
      const decoded = await loadRgbaAsset(input.png, 'staged-runtime-sprite', 20_000_000);
      if (decoded.width !== decoded.height || decoded.width > 760) {
        throw new RuntimeSpriteIntegrityError('Runtime sprite must be a normalized square PNG.');
      }
      if (!decoded.rgba.some((value, offset) => offset % 4 === 3 && value >= DEVFEST_SG_V1.alphaThreshold)) {
        throw new RuntimeSpriteIntegrityError('Runtime sprite contains no printable alpha.');
      }
      const colorEvidence = SrgbColorEvidenceSchema.parse(input.colorEvidence);
      const path = objectPath(pngSha256);
      if (flow.accepted) {
        if (flow.accepted.outcome !== 'generated_accepted' || flow.accepted.candidateId !== input.candidateId ||
          !/^sprite\/runtime\/[a-f0-9]{64}$/.test(flow.accepted.natcutAssetId)) {
          throw new RuntimeSpriteIntegrityError('Plant flow accepted a different candidate.');
        }
        const acceptedId = flow.accepted.natcutAssetId;
        const snapshot = await collection.doc(acceptedId.slice('sprite/runtime/'.length)).get();
        if (!snapshot.exists) throw new RuntimeSpriteIntegrityError('Accepted runtime sprite receipt is missing.');
        const receipt = RuntimeSpriteReceiptSchema.parse(snapshot.data());
        const { assetId: _assetId, ...identity } = receipt;
        if (receipt.assetId !== acceptedId || receiptId(identity) !== acceptedId.slice('sprite/runtime/'.length) ||
          receipt.flowKey.eventId !== input.flowKey.eventId ||
          receipt.flowKey.visitorSessionId !== input.flowKey.visitorSessionId ||
          receipt.flowKey.captureId !== input.flowKey.captureId ||
          receipt.generationIntentId !== input.generationIntentId || receipt.plantJobId !== input.plantJobId ||
          receipt.candidateId !== input.candidateId || receipt.sourceObjectGeneration !== input.sourceObjectGeneration ||
          receipt.sourceSha256 !== input.sourceSha256 || receipt.sourceByteLength !== input.sourceByteLength ||
          receipt.pngSha256 !== pngSha256 || receipt.pngByteLength !== input.png.length ||
          receipt.objectPath !== path || JSON.stringify(receipt.colorEvidence) !== JSON.stringify(colorEvidence)) {
          throw new RuntimeSpriteIntegrityError('Accepted runtime sprite receipt differs from retry evidence.');
        }
        const pinned = await deps.objects.readExact(path, receipt.objectGeneration);
        if (!pinned.equals(input.png)) throw new RuntimeSpriteIntegrityError('Accepted runtime sprite bytes differ from retry.');
        return acceptedId;
      }
      const published = await deps.objects.publishCreateOnly(path, input.png);
      const pinned = await deps.objects.readExact(path, published.generation);
      if (pinned.length !== input.png.length || sha256(pinned) !== pngSha256) {
        throw new RuntimeSpriteIntegrityError('Pinned runtime sprite differs from staged bytes.');
      }
      const base = {
        receiptVersion: 'natcut-runtime-sprite-v1' as const,
        flowKey: input.flowKey, generationIntentId: input.generationIntentId,
        plantJobId: input.plantJobId, candidateId: input.candidateId,
        sourceObjectGeneration: input.sourceObjectGeneration,
        sourceSha256: input.sourceSha256, sourceByteLength: input.sourceByteLength,
        pngSha256, pngByteLength: input.png.length, objectPath: path,
        objectGeneration: published.generation, colorEvidence,
      };
      const receipt = RuntimeSpriteReceiptSchema.parse({ ...base, assetId: `sprite/runtime/${receiptId(base)}` });
      const ref = collection.doc(receipt.assetId.slice('sprite/runtime/'.length));
      await deps.firestore.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (snapshot.exists) {
          const existing = RuntimeSpriteReceiptSchema.parse(snapshot.data());
          if (JSON.stringify(existing) !== JSON.stringify(receipt)) throw new RuntimeSpriteIntegrityError('Runtime sprite receipt conflict.');
          return;
        }
        transaction.create(ref, receipt);
      });
      return receipt.assetId;
    },

    async loadAccepted(flowKey: PlantFlowKey, assetId: string): Promise<SrgbRgbaAsset> {
      if (!/^sprite\/runtime\/[a-f0-9]{64}$/.test(assetId)) throw new RuntimeSpriteIntegrityError('Invalid runtime sprite identity.');
      const [flow, snapshot] = await Promise.all([
        deps.flows.get(flowKey), collection.doc(assetId.slice('sprite/runtime/'.length)).get(),
      ]);
      if (!snapshot.exists) throw new RuntimeSpriteIntegrityError('Runtime sprite receipt is missing.');
      const receipt = RuntimeSpriteReceiptSchema.parse(snapshot.data());
      if (!flow || flow.accepted?.outcome !== 'generated_accepted' ||
        flow.accepted.natcutAssetId !== assetId || flow.accepted.candidateId !== receipt.candidateId ||
        flow.sproutAck !== 'confirmed' || flow.generationIntentId !== receipt.generationIntentId ||
        flow.plantJobId !== receipt.plantJobId || receipt.assetId !== assetId ||
        flowKey.eventId !== receipt.flowKey.eventId || flowKey.visitorSessionId !== receipt.flowKey.visitorSessionId ||
        flowKey.captureId !== receipt.flowKey.captureId) {
        throw new RuntimeSpriteIntegrityError('Runtime sprite has no matching confirmed NatCut acceptance.');
      }
      const { assetId: _assetId, ...identity } = receipt;
      if (receipt.objectPath !== objectPath(receipt.pngSha256) ||
        receipt.assetId !== `sprite/runtime/${receiptId(identity)}`) {
        throw new RuntimeSpriteIntegrityError('Runtime sprite receipt identity mismatch.');
      }
      const bytes = await deps.objects.readExact(receipt.objectPath, receipt.objectGeneration);
      if (bytes.length !== receipt.pngByteLength || sha256(bytes) !== receipt.pngSha256) {
        throw new RuntimeSpriteIntegrityError('Pinned runtime sprite digest or length mismatch.');
      }
      const decoded = await loadRgbaAsset(bytes, assetId, 20_000_000);
      if (decoded.width !== decoded.height || decoded.width > 760) throw new RuntimeSpriteIntegrityError('Runtime sprite dimensions changed.');
      return { ...decoded, colorEvidence: receipt.colorEvidence };
    },
  };
}
