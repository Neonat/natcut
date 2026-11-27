import type { VerifiedArtifact } from '@natcut/artifacts/reader';
import type { PreparedPhysicalArtifacts } from './artifacts.ts';

const prepared = new WeakSet<PreparedPhysicalArtifacts>();

export async function preparePhysicalArtifacts(input: VerifiedArtifact): Promise<PreparedPhysicalArtifacts> {
  const { generateVerifiedPhysicalOutputs } = await import('./artifacts.ts');
  const { receipt, print, cut } = await generateVerifiedPhysicalOutputs(input);
  const pair = { receipt, profile: receipt.descriptor.profile, print, cut };
  Object.freeze(pair.receipt.descriptor);
  Object.freeze(pair.receipt);
  Object.freeze(pair.cut.stats);
  Object.freeze(pair.print.preview);
  Object.freeze(pair.print);
  Object.freeze(pair.cut);
  Object.freeze(pair);
  prepared.add(pair);
  return pair;
}

export function isPreparedArtifactPair(pair: PreparedPhysicalArtifacts) {
  return prepared.has(pair);
}
