import type { LocalJobState, LocalPrintJob } from './job-store.ts';

// Executors must await this transition before performing any side effect for the phase.
export type PhaseTransition = (state: LocalJobState, changedAt: string, reason?: string) => Promise<void> | void;
export interface PhysicalExecutor {
  execute(job: LocalPrintJob, transition: PhaseTransition): Promise<void>;
}

const phases: LocalJobState[] = [
  'rendering',
  'validating',
  'ready_to_declare',
  'declaring',
  'uploading_cut',
  'uploading_image',
  'printing',
  'cutting',
  'ready',
];

export class SimulatedPrinter implements PhysicalExecutor {
  private readonly now: () => string;
  private readonly onPhase: (phase: LocalJobState) => void;
  private readonly delayMs: number;

  constructor(options: { now?: () => string; onPhase?: (phase: LocalJobState) => void; delayMs?: number } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onPhase = options.onPhase ?? (() => undefined);
    this.delayMs = options.delayMs ?? 0;
  }

  async execute(_job: LocalPrintJob, transition: PhaseTransition) {
    for (const phase of phases) {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      await transition(phase, this.now());
      this.onPhase(phase);
    }
  }
}
