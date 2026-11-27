import { ArtifactReceiptSchema, decodeLogicalSourceBundle, type ArtifactReceipt } from '@natcut/domain';

export interface VerifiedArtifact {
  receipt: ArtifactReceipt;
  bytes: Uint8Array;
}

export interface ArtifactReader {
  read(receipt: ArtifactReceipt, options?: { signal?: AbortSignal }): Promise<VerifiedArtifact>;
}

/** Retrying the same generation cannot repair missing or inconsistent evidence. */
export class ArtifactIntegrityError extends Error {}

export function parseArtifactReceipt(input: unknown): ArtifactReceipt {
  const result = ArtifactReceiptSchema.safeParse(input);
  if (!result.success) throw new ArtifactIntegrityError('Invalid artifact receipt.', { cause: result.error });
  return result.data;
}

export async function verifyArtifactBytes(bytes: Uint8Array, receipt: ArtifactReceipt): Promise<VerifiedArtifact> {
  try {
    const { descriptor, generation } = parseArtifactReceipt(receipt);
    const decoded = await decodeLogicalSourceBundle(bytes, descriptor);
    return { receipt: { generation, descriptor: decoded.descriptor }, bytes: decoded.bytes };
  } catch (cause) {
    throw new ArtifactIntegrityError('Invalid logical artifact: ' + (cause instanceof Error ? cause.message : 'invalid bytes'), { cause });
  }
}
