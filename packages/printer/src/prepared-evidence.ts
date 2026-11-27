import type { PreparedPhysicalArtifacts } from './artifacts.ts';

// Preparation is in-process. Only the verified logical bundle constructor issues a
// pair; an object with copied role tags, hashes and a claimed QC pass cannot enter preflight.
const prepared = new WeakSet<PreparedPhysicalArtifacts>();

export function sealPreparedArtifacts(pair: PreparedPhysicalArtifacts) {
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
