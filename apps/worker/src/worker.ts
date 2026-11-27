import { randomUUID } from 'node:crypto';
import { ArtifactIntegrityError, type ArtifactReader } from '@natcut/artifacts';
import { verifyClaim, verifyJournalArtifact } from './artifact-verification.ts';
import { InvalidClaimError, UnexpectedSubmissionError, type CloudQueue, type CompletionEvidence } from './cloud-queue.ts';
import { safelyExecutableStates, type JobStore, type LocalJobState, type LocalPrintJob } from './job-store.ts';
import type { PhysicalExecutor } from './simulated-printer.ts';

export type WorkerResult =
  | { kind: 'idle' }
  | { kind: 'completed'; submissionId: string }
  | { kind: 'busy'; submissionId: string }
  | { kind: 'waiting_for_cloud'; submissionId: string }
  | { kind: 'needs_reconciliation'; submissionId: string }
  | { kind: 'failed'; submissionId: string; error: string };

export type WorkerDependencies = {
  workerId: string;
  expectedSubmissionId?: string;
  cloud: CloudQueue;
  store: JobStore;
  executor: PhysicalExecutor;
  artifactReader: ArtifactReader;
  signal?: AbortSignal;
  now?: () => string;
};

export type PreparedJob = Pick<LocalPrintJob, 'submissionId' | 'eventId' | 'queueNumber' | 'manifestHash' | 'geometryReportJson' | 'artifactReceiptJson'>;

class ExecutionFenceError extends Error {
  constructor(readonly outcome: 'waiting_for_cloud' | 'needs_reconciliation') {
    super(outcome === 'waiting_for_cloud'
      ? 'Cloud execution fence could not be reached.'
      : 'Cloud execution fence no longer matches the verified job.');
  }
}

function pendingConflict(
  store: JobStore,
  allowedReadyFor?: string,
): { kind: 'needs_reconciliation'; submissionId: string } | null {
  const conflict = store.listPendingPublicStatuses().find(intent =>
    intent.submissionId !== allowedReadyFor || intent.status !== 'ready');
  return conflict ? { kind: 'needs_reconciliation', submissionId: conflict.submissionId } : null;
}

// Rebuild completion proof only from the durable ready transition, verified
// journal bytes and the token created before this execution began.
async function completionEvidence(
  store: JobStore,
  workerId: string,
  pending: ReturnType<JobStore['listPendingPublicStatuses']>[number],
): Promise<CompletionEvidence | null> {
  const { submissionId } = pending;
  const job = store.getBySubmissionId(submissionId);
  const executionToken = store.getExecutionToken(submissionId);
  if (!job || job.state !== 'ready' || job.completionAcknowledgedAt || job.stateChangedAt !== pending.updatedAt ||
      !isIsoTimestamp(pending.updatedAt) || !job.eventId || !executionToken) return null;
  try {
    return {
      submissionId,
      eventId: job.eventId,
      workerId,
      executionToken,
      ...await verifyJournalArtifact(job, job.artifactReceiptJson),
    };
  } catch {
    return null;
  }
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function markCompletionReconciliation(
  store: JobStore,
  submissionId: string,
  changedAt: string,
  reason: string,
  guardToken?: string,
) {
  if (store.getBySubmissionId(submissionId)) {
    store.transition(submissionId, 'needs_reconciliation', changedAt, reason);
  } else {
    if (guardToken) store.holdArtifactWhileGuarded(submissionId, changedAt, reason, guardToken);
    else store.holdArtifact(submissionId, changedAt, reason);
  }
}

async function publishVerifiedReady(
  store: JobStore,
  cloud: CloudQueue,
  workerId: string,
  submissionId: string,
  guardToken?: string,
): Promise<WorkerResult | null> {
  const conflict = pendingConflict(store, submissionId);
  if (conflict) {
    const blocked = store.listPendingPublicStatuses().find(intent => intent.submissionId === conflict.submissionId);
    if (!blocked) throw new Error('Pending completion conflict disappeared from the durable outbox.');
    markCompletionReconciliation(
      store,
      conflict.submissionId,
      blocked.updatedAt,
      'Multiple unresolved completion intents require operator reconciliation.',
      guardToken,
    );
    return conflict;
  }
  const pending = store.listPendingPublicStatuses().find(intent => intent.submissionId === submissionId && intent.status === 'ready');
  if (!pending) return null;
  const evidence = await completionEvidence(store, workerId, pending);
  if (!evidence) {
    markCompletionReconciliation(store, submissionId, pending.updatedAt, 'Completion intent lacks exact verified execution evidence.', guardToken);
    return { kind: 'needs_reconciliation', submissionId };
  }
  try {
    const outcome = await cloud.completeExecution(evidence, pending.updatedAt);
    if (outcome !== 'committed' && outcome !== 'confirmed') {
      markCompletionReconciliation(store, submissionId, pending.updatedAt, 'Cloud completion fence rejected the local execution evidence.', guardToken);
      return { kind: 'needs_reconciliation', submissionId };
    }
    if (!store.acknowledgeCompletion(pending)) {
      markCompletionReconciliation(store, submissionId, pending.updatedAt, 'Completion acknowledgement did not match the durable ready transition.', guardToken);
      return { kind: 'needs_reconciliation', submissionId };
    }
    return null;
  } catch {
    return { kind: 'waiting_for_cloud', submissionId };
  }
}

function publicStatusFor(state: LocalJobState): 'next' | 'printing' | 'ready' {
  if (state === 'ready') return 'ready';
  if (['declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting'].includes(state)) return 'printing';
  return 'next';
}

export async function runWorkerOnce(deps: WorkerDependencies): Promise<WorkerResult> {
  const prepared = await prepareNextWorkerJob(deps);
  if (prepared.kind !== 'prepared') return prepared;
  return runLocalJob(deps, prepared.job);
}

export async function prepareNextWorkerJob(
  deps: Omit<WorkerDependencies, 'executor'>,
): Promise<{ kind: 'prepared'; job: PreparedJob } | WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    // Completion retries carry the same verified journal and execution identity. A committed
    // response may be lost, but only the exact persisted cloud completion fence confirms it.
    const pendingIntents = deps.store.listPendingPublicStatuses();
    if (pendingIntents.length > 0) {
      const recoveryToken = randomUUID();
      if (!deps.store.tryAcquireExecutionGuard(recoveryToken, process.pid)) {
        return { kind: 'busy', submissionId: pendingIntents[0]!.submissionId };
      }
      try {
        for (const pending of pendingIntents) {
          if (pending.status !== 'ready') {
            markCompletionReconciliation(
              deps.store,
              pending.submissionId,
              pending.updatedAt,
              'Unsupported legacy status intent requires operator reconciliation.',
              recoveryToken,
            );
            return { kind: 'needs_reconciliation', submissionId: pending.submissionId };
          }
          const result = await publishVerifiedReady(deps.store, deps.cloud, deps.workerId, pending.submissionId, recoveryToken);
          if (result) return result;
        }
      } finally {
        deps.store.releaseExecutionGuard(recoveryToken);
      }
    }
    for (const method of ['recoverClaim', 'claimNextSubmission'] as const) {
      if (method === 'claimNextSubmission') {
        const conflict = pendingConflict(deps.store);
        if (conflict) return conflict;
        const unresolved = deps.store.firstUnresolvedLocalJob();
        if (unresolved) {
          if (unresolved.state !== 'needs_reconciliation' && unresolved.state !== 'failed') {
            deps.store.transition(
              unresolved.submissionId,
              'needs_reconciliation',
              now(),
              'Local journal has no matching cloud slot and blocks the next claim.',
            );
          }
          return { kind: 'needs_reconciliation', submissionId: unresolved.submissionId };
        }
        const held = deps.store.listBlockingSubmissionIds()[0];
        if (held) return { kind: 'needs_reconciliation', submissionId: held };
      }
      const claim = await deps.cloud[method](deps.workerId, deps.expectedSubmissionId);
      if (!claim) continue;
      const submissionId = claim.submission.id;
      if (deps.store.hasLiveExecutionGuard()) return { kind: 'busy', submissionId };
      if (claim.workerId !== deps.workerId) return { kind: 'needs_reconciliation', submissionId };
      if (deps.store.hasArtifactHold(submissionId)) return { kind: 'needs_reconciliation', submissionId };
      const conflict = pendingConflict(deps.store, method === 'recoverClaim' ? submissionId : undefined);
      if (conflict) return conflict;
      const deadline = AbortSignal.timeout(30_000);
      const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
      let verified;
      try {
        verified = await verifyClaim(claim, deps.artifactReader, signal, now);
      } catch (error) {
        if (error instanceof ArtifactIntegrityError) {
          return { kind: deps.store.holdArtifact(submissionId, now(), error.message), submissionId };
        }
        return { kind: 'waiting_for_cloud', submissionId };
      }
      const availability = deps.store.ensureClaimed(verified);
      if (availability !== 'available') return { kind: availability, submissionId };
      const job = deps.store.getBySubmissionId(submissionId)!;
      if (safelyExecutableStates.has(job.state)) {
        const pending = pendingConflict(deps.store);
        if (pending) return pending;
        const { eventId, queueNumber, manifestHash, geometryReportJson, artifactReceiptJson } = job;
        return { kind: 'prepared', job: { submissionId, eventId, queueNumber, manifestHash, geometryReportJson, artifactReceiptJson } };
      }
      if (method !== 'recoverClaim' || job.state !== 'ready') return { kind: 'needs_reconciliation', submissionId };
      if (claim.submission.publicStatus !== 'printing') return { kind: 'needs_reconciliation', submissionId };
      deps.store.stagePublicStatus(submissionId, 'ready', job.stateChangedAt);
      const unpublished = await publishVerifiedReady(deps.store, deps.cloud, deps.workerId, submissionId);
      if (unpublished) return unpublished;
    }
    return { kind: 'idle' };
  } catch (error) {
    if (error instanceof UnexpectedSubmissionError) {
      return { kind: 'failed', submissionId: error.actualSubmissionId, error: error.message };
    }
    if (!(error instanceof InvalidClaimError)) throw error;
    return { kind: deps.store.holdArtifact(error.submissionId, now(), error.message), submissionId: error.submissionId };
  }
}

export async function runLocalJob(
  deps: WorkerDependencies,
  job: PreparedJob,
): Promise<WorkerResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const executionToken = randomUUID();
  if (!deps.store.tryAcquireExecutionGuard(executionToken, process.pid)) {
    return { kind: 'busy', submissionId: job.submissionId };
  }

  try {
    const authoritativeJob = deps.store.getBySubmissionId(job.submissionId);
    if (!authoritativeJob) {
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    if (authoritativeJob.state === 'ready') {
      if (authoritativeJob.completionAcknowledgedAt) return { kind: 'completed', submissionId: job.submissionId };
      return deps.store.listPendingPublicStatuses().some(intent => intent.submissionId === job.submissionId && intent.status === 'ready')
        ? { kind: 'waiting_for_cloud', submissionId: job.submissionId }
        : { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    if (!safelyExecutableStates.has(authoritativeJob.state)) {
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    const pending = pendingConflict(deps.store);
    if (pending) return pending;
    let evidence;
    try {
      if (job.eventId !== authoritativeJob.eventId || job.manifestHash !== authoritativeJob.manifestHash ||
          job.queueNumber !== authoritativeJob.queueNumber ||
          job.geometryReportJson !== authoritativeJob.geometryReportJson) throw new ArtifactIntegrityError('Prepared journal changed.');
      evidence = await verifyJournalArtifact(authoritativeJob, job.artifactReceiptJson);
    } catch {
      deps.store.transition(job.submissionId, 'needs_reconciliation', now(), 'Stored artifact failed verification before execution.');
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    }
    if (deps.signal?.aborted) return { kind: 'waiting_for_cloud', submissionId: job.submissionId };
    let staged = publicStatusFor(authoritativeJob.state);
    let completionPending: WorkerResult | null = null;
    try {
      await deps.executor.execute(authoritativeJob, async (state, changedAt) => {
        const nextPublic = publicStatusFor(state);
        if (staged === 'next' && nextPublic === 'printing') {
          const journalExecutionToken = deps.store.getOrCreateExecutionToken(job.submissionId);
          let executionFence: 'acquired' | 'fenced';
          try {
            executionFence = await deps.cloud.beginExecution(
              job.submissionId,
              deps.workerId,
              journalExecutionToken,
              changedAt,
              evidence,
            );
          } catch {
            throw new ExecutionFenceError('waiting_for_cloud');
          }
          if (executionFence === 'fenced') {
            throw new ExecutionFenceError('needs_reconciliation');
          }
          staged = 'printing';
          deps.store.transition(job.submissionId, state, changedAt);
          return;
        }
        if (nextPublic === 'ready' && staged !== 'ready') {
          if (staged !== 'printing') throw new ExecutionFenceError('needs_reconciliation');
          deps.store.transitionAndStagePublicStatus(job.submissionId, state, changedAt, 'ready');
          staged = 'ready';
          const completion = await publishVerifiedReady(deps.store, deps.cloud, deps.workerId, job.submissionId);
          if (completion?.kind === 'needs_reconciliation') throw new ExecutionFenceError('needs_reconciliation');
          if (completion?.kind === 'waiting_for_cloud') completionPending = completion;
        } else {
          deps.store.transition(job.submissionId, state, changedAt);
        }
      });
      if (completionPending) return completionPending;
      const finished = deps.store.getBySubmissionId(job.submissionId);
      if (finished?.state === 'ready' && finished.completionAcknowledgedAt) {
        return { kind: 'completed', submissionId: job.submissionId };
      }
      if (finished?.state !== 'needs_reconciliation') {
        deps.store.transition(
          job.submissionId,
          'needs_reconciliation',
          now(),
          'Executor returned without an acknowledged ready completion.',
        );
      }
      return { kind: 'needs_reconciliation', submissionId: job.submissionId };
    } catch (cause) {
      if (cause instanceof ExecutionFenceError) {
        if (cause.outcome === 'needs_reconciliation') {
          deps.store.transition(
            job.submissionId,
            'needs_reconciliation',
            now(),
            cause.message,
          );
        }
        return { kind: cause.outcome, submissionId: job.submissionId };
      }
      const error = cause instanceof Error ? cause.message : String(cause);
      deps.store.transition(job.submissionId, 'failed', now(), error);
      return { kind: 'failed', submissionId: job.submissionId, error };
    }
  } finally {
    deps.store.releaseExecutionGuard(executionToken);
  }
}

const uncertainStates = new Set<LocalJobState>([
  'declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting',
]);

export function recoverInterruptedJobs(
  store: JobStore,
  changedAt: string,
  _executor?: PhysicalExecutor,
): string[] {
  const recoveryToken = randomUUID();
  if (!store.tryAcquireExecutionGuard(recoveryToken, process.pid)) return [];
  const recovered: string[] = [];
  try {
    for (const job of store.listStates()) {
      if (!uncertainStates.has(job.state)) continue;
      const changed = store.transitionIfCurrentState(
        job.submissionId,
        job.state,
        'needs_reconciliation',
        changedAt,
        'Worker restarted during physical execution.',
      );
      if (changed) recovered.push(job.submissionId);
    }
  } finally {
    store.releaseExecutionGuard(recoveryToken);
  }
  return recovered;
}
