import type { LocalJobState, LocalPrintJob } from './job-store.ts';

export type PhaseTransition = (state: LocalJobState, changedAt: string) => Promise<void> | void;
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

  constructor(options: { now?: () => string; onPhase?: (phase: LocalJobState) => void } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onPhase = options.onPhase ?? (() => undefined);
  }

  async execute(_job: LocalPrintJob, transition: PhaseTransition) {
    for (const phase of phases) {
      this.onPhase(phase);
      await transition(phase, this.now());
    }
  }
}
