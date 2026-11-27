import type { CompositionManifest, GeometryReport } from '@natcut/domain';
import { useEffect, useRef, useState } from 'react';

export type ContourPreview = Array<{ x: number; y: number }>;
export type CutPreviewRequest = { revision: number; exact: true; manifest: CompositionManifest };
export type CutPreviewResult = { revision: number; manifestFingerprint?: string } & (
  | { report: GeometryReport; contours: ContourPreview[]; error?: never }
  | { error: string; report?: never; contours?: never }
);

export class CutPreviewCoordinator {
  private revision = 0;
  private latestRequested = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly post: (request: CutPreviewRequest) => void,
    private readonly apply: (result: CutPreviewResult) => void,
    private readonly debounceMs = 180,
  ) {}

  move(manifest: CompositionManifest) {
    if (this.timer) clearTimeout(this.timer);
    const revision = ++this.revision;
    this.latestRequested = revision;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.post({ revision, exact: true, manifest });
    }, this.debounceMs);
  }

  release(manifest: CompositionManifest) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const revision = ++this.revision;
    this.latestRequested = revision;
    this.post({ revision, exact: true, manifest });
  }

  receive(result: CutPreviewResult) {
    if (result.revision === this.latestRequested) this.apply(result);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
  }
}

type WorkerPort = {
  postMessage(request: CutPreviewRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<CutPreviewResult>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<CutPreviewResult>) => void): void;
  terminate?(): void;
};

function defaultWorker(): WorkerPort | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('../workers/cut-preview.worker.ts', import.meta.url), { type: 'module' });
}

export function useCutPreview(workerFactory: () => WorkerPort | null = defaultWorker) {
  const [result, setResult] = useState<CutPreviewResult | null>(null);
  const coordinator = useRef<CutPreviewCoordinator | null>(null);

  useEffect(() => {
    const port = workerFactory();
    const next = new CutPreviewCoordinator((request) => port?.postMessage(request), setResult);
    coordinator.current = next;
    const listener = (event: MessageEvent<CutPreviewResult>) => next.receive(event.data);
    port?.addEventListener('message', listener);
    return () => {
      next.dispose();
      port?.removeEventListener('message', listener);
      port?.terminate?.();
    };
  }, [workerFactory]);

  return {
    result,
    move: (manifest: CompositionManifest) => { setResult(null); coordinator.current?.move(manifest); },
    release: (manifest: CompositionManifest) => { setResult(null); coordinator.current?.release(manifest); },
  };
}
