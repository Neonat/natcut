import type { ArtifactReceipt, LogicalSourceBundle } from '@natcut/domain';

export interface ArtifactPublisher {
  publish(bundle: LogicalSourceBundle, options?: { signal?: AbortSignal }): Promise<ArtifactReceipt>;
}
