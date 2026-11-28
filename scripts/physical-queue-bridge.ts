import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseArtifactReceipt, verifyArtifactBytes } from '@natcut/artifacts/reader';
import { preparePhysicalArtifacts } from '@natcut/printer';
import { QueuePhysicalQcJournal } from '../packages/printer/src/queue-physical-qc.ts';
import {
  prepareTransportAttempt, runTransportAttempt, SqliteTransportAttemptJournal,
  type TransportAttemptBinding, type TransportAttemptResult, type TransportMutationPort,
} from '../packages/printer/src/transport-attempt.ts';
import { createUsbTransportMutationPort } from '../src/printer-mutation-port.mjs';
import { ReadOnlyPixCut } from '../src/protocol.mjs';
import { verifyJournalArtifact } from '../apps/worker/src/artifact-verification.ts';
import type { CloudQueue } from '../apps/worker/src/cloud-queue.ts';
import { type JobStore, type LocalPrintJob } from '../apps/worker/src/job-store.ts';
import type { PhaseTransition, PhysicalExecutor } from '../apps/worker/src/simulated-printer.ts';
import { publishStagedReady, type WorkerResult } from '../apps/worker/src/worker.ts';

type UsbSession = { io: { read: (...args: any[]) => Promise<Uint8Array>; write: (...args: any[]) => Promise<void> }; close: () => Promise<void> };
type ExpectedPhysicalJob = {
  submissionId: string;
  bundleSha256: string;
  jpegSha256: string;
  pltSha256: string;
};

export function printerIsIdle(snapshot: {
  status: { state: number; sub: number; alerts: number[] };
  activeJobs: number[];
}): boolean {
  return (snapshot.status.state === 20 || snapshot.status.state === 30) &&
    snapshot.status.sub === 2000 && snapshot.status.alerts.length === 0 &&
    snapshot.activeJobs.length === 0;
}

export function transportJournalPath(directory: string, submissionId: string): string {
  if (!path.isAbsolute(directory) || !submissionId) throw new Error('A durable absolute physical journal directory and submission ID are required.');
  return path.join(directory, `${createHash('sha256').update(submissionId).digest('hex')}.sqlite`);
}

async function prepareJob(job: LocalPrintJob, store: JobStore) {
  if (!job.eventId || !job.artifactBytes || !job.artifactReceiptJson) throw new Error('The local job lacks exact artifact evidence.');
  const evidence = await verifyJournalArtifact(job, job.artifactReceiptJson);
  const verified = await verifyArtifactBytes(job.artifactBytes, parseArtifactReceipt(JSON.parse(job.artifactReceiptJson)));
  const artifacts = await preparePhysicalArtifacts(verified);
  return { evidence, artifacts };
}

export class PhysicalQueueExecutor implements PhysicalExecutor {
  private readonly now: () => string;
  private readonly openSession: () => Promise<UsbSession>;
  private readonly onTransferResult: (result: TransportAttemptResult) => void;

  constructor(private readonly options: {
    store: JobStore;
    workerId: string;
    journalDirectory: string;
    expected: ExpectedPhysicalJob;
    openSession: () => Promise<UsbSession>;
    inspectSession?: (session: UsbSession) => Promise<{ status: { state: number; sub: number; alerts: number[] }; activeJobs: number[] }>;
    createTransport?: (session: UsbSession) => TransportMutationPort;
    now?: () => string;
    onTransferResult?: (result: TransportAttemptResult) => void;
  }) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.openSession = options.openSession;
    this.onTransferResult = options.onTransferResult ?? (() => undefined);
  }

  async execute(job: LocalPrintJob, transition: PhaseTransition): Promise<void> {
    const { store, workerId, journalDirectory, expected } = this.options;
    if (job.submissionId !== expected.submissionId || job.bundleSha256 !== expected.bundleSha256) {
      throw new Error('Queue ticket or pinned bundle differs from the one approved for physical send.');
    }
    await transition('rendering', this.now());
    const { evidence, artifacts } = await prepareJob(job, store);
    await transition('validating', this.now());
    if (artifacts.print.sha256 !== expected.jpegSha256 || artifacts.cut.sha256 !== expected.pltSha256 ||
        !isDeepStrictEqual(evidence.receipt, artifacts.receipt)) {
      throw new Error('Physical packet differs from the reviewed JPEG, PLT, or immutable receipt.');
    }
    await mkdir(journalDirectory, { recursive: true });
    const journalPath = transportJournalPath(journalDirectory, job.submissionId);
    const session = await this.openSession();
    try {
      // Hold the same claimed USB interfaces between read-only idle check and mutation.
      const snapshot = await (this.options.inspectSession ?? (opened => new ReadOnlyPixCut(opened.io).snapshot()))(session);
      if (!printerIsIdle(snapshot)) {
        throw new Error('Printer is not idle and clear of alerts and active jobs.');
      }
      await transition('ready_to_declare', this.now());
      // The cloud execution lease is durable before reserving a transport attempt or issuing USB writes.
      await transition('declaring', this.now());
      const executionToken = store.getExecutionToken(job.submissionId);
      if (!executionToken) throw new Error('Durable cloud execution token is missing.');
      const binding: TransportAttemptBinding = {
        submissionId: job.submissionId, eventId: job.eventId!, workerId,
        executionToken, manifestHash: job.manifestHash, receipt: artifacts.receipt,
      };
      const journal = new SqliteTransportAttemptJournal(journalPath);
      let result: TransportAttemptResult;
      try {
        result = await runTransportAttempt(artifacts, binding, {
          journal, transport: this.options.createTransport?.(session) ?? createUsbTransportMutationPort(session.io),
        });
      } finally {
        journal.close();
      }
      this.onTransferResult(result);
      await transition('needs_reconciliation', this.now(), result.reason);
    } finally {
      try { await session.close(); } catch { /* The durable attempt still requires reconciliation. */ }
    }
  }
}

export async function completeObservedPhysicalJob(options: {
  store: JobStore;
  cloud: CloudQueue;
  workerId: string;
  journalDirectory: string;
  expected: ExpectedPhysicalJob;
  now?: () => string;
}): Promise<WorkerResult> {
  const { store, cloud, workerId, journalDirectory, expected } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const guard = randomUUID();
  if (!store.tryAcquireExecutionGuard(guard, process.pid)) return { kind: 'busy', submissionId: expected.submissionId };
  try {
    const job = store.getBySubmissionId(expected.submissionId);
    if (!job || job.bundleSha256 !== expected.bundleSha256 || !job.eventId ||
        !['needs_reconciliation', 'ready'].includes(job.state)) {
      return { kind: 'needs_reconciliation', submissionId: expected.submissionId };
    }
    const { evidence, artifacts } = await prepareJob(job, store);
    if (artifacts.print.sha256 !== expected.jpegSha256 || artifacts.cut.sha256 !== expected.pltSha256) {
      return { kind: 'needs_reconciliation', submissionId: expected.submissionId };
    }
    if (job.state === 'ready' && job.completionAcknowledgedAt) return { kind: 'completed', submissionId: expected.submissionId };
    const token = store.getExecutionToken(job.submissionId);
    const claimed = await cloud.recoverClaim(workerId, expected.submissionId);
    if (!token || !claimed || claimed.submission.publicStatus !== 'printing' || claimed.executionToken !== token ||
        claimed.submission.id !== job.submissionId || claimed.submission.eventId !== job.eventId) {
      return { kind: 'needs_reconciliation', submissionId: expected.submissionId };
    }
    if (!isDeepStrictEqual(claimed.submission.artifact, evidence.receipt) ||
        claimed.submission.manifestHash !== evidence.manifestHash ||
        !isDeepStrictEqual(claimed.submission.validation, evidence.validation)) {
      return { kind: 'needs_reconciliation', submissionId: expected.submissionId };
    }
    const binding: TransportAttemptBinding = {
      submissionId: job.submissionId, eventId: job.eventId, workerId,
      executionToken: token, manifestHash: job.manifestHash, receipt: artifacts.receipt,
    };
    const prepared = prepareTransportAttempt(artifacts, binding);
    if (!prepared) return { kind: 'needs_reconciliation', submissionId: expected.submissionId };
    const physical = new QueuePhysicalQcJournal(transportJournalPath(journalDirectory, job.submissionId));
    try {
      physical.recordPass(job.submissionId, prepared.evidenceHash, now());
    } finally {
      physical.close();
    }
    if (job.state !== 'ready') store.transitionAndStagePublicStatus(job.submissionId, 'ready', now(), 'ready');
  } finally {
    store.releaseExecutionGuard(guard);
  }
  return publishStagedReady(store, cloud, workerId, expected.submissionId);
}
