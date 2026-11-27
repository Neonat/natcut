import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { verifyJournalArtifact } from './artifact-verification.ts';
import { localJobStates, type JobStore, type LocalJobState } from './job-store.ts';

type DeskStatus = 'queued' | 'next' | 'printing' | 'ready' | 'collected' | 'acknowledgement_pending' | 'blocked';
export type QueueCursors = { queued: number; ready: number };
export type OperatorQueueRow = {
  submissionId: string;
  queueNumber: number | null;
  publicStatus: DeskStatus;
  localState: LocalJobState | null;
  notice: string | null;
  onHold: boolean;
  completionRetry: boolean;
};

const queueIntegrityScanLimit = 1_000;

function queueNumber(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function notice(state: LocalJobState | null, status: DeskStatus, hasWarning: boolean) {
  if (status === 'blocked') return 'Local completion evidence needs reconciliation. This ticket is on hold.';
  if (state === 'failed') return 'Simulation failed. This ticket is on hold.';
  if (state === 'needs_reconciliation') return 'Execution needs reconciliation. This ticket is on hold.';
  if (state === 'ready' && status === 'printing') return 'Simulation complete. Ready status is waiting to publish.';
  return hasWarning ? 'Design has a geometry warning.' : null;
}

export function createOperatorQueue(firestore: Firestore, eventId: string, store: JobStore) {
  const submissions = firestore.collection('submissions');
  const pageSize = 25;

  async function page(
    transaction: Transaction,
    status: Exclude<DeskStatus, 'collected' | 'acknowledgement_pending' | 'blocked'>,
    after: number,
    blocking: ReadonlySet<string>,
    completionRetrySubmissionId: string | null,
    activeSlotSubmissionId: string | null,
  ) {
    // The exclusive worker slot permits at most one Next or Printing ticket in this event.
    const paginated = status === 'queued' || status === 'ready';
    let query = submissions.where('eventId', '==', eventId).where('publicStatus', '==', status)
      .select('queueNumber', 'validation.severity');
    if (paginated && status !== 'queued') query = query.orderBy('queueNumber');
    if (after && status !== 'queued') query = query.startAfter(after);
    const snapshot = await transaction.get(query.limit(status === 'queued' ? queueIntegrityScanLimit + 1 : paginated ? pageSize + 1 : 1));
    const duplicateNumbers = new Set<number>();
    if (status === 'queued') {
      const seen = new Set<number>();
      for (const doc of snapshot.docs) {
        const number = queueNumber(doc.get('queueNumber'));
        if (number !== null && seen.has(number)) duplicateNumbers.add(number);
        if (number !== null) seen.add(number);
      }
    }
    const integrityOverflow = status === 'queued' && snapshot.size > queueIntegrityScanLimit;
    const orderedQueuedDocuments = status === 'queued'
      ? snapshot.docs.slice(0, queueIntegrityScanLimit).sort((left, right) => {
          const leftNumber = queueNumber(left.get('queueNumber'));
          const rightNumber = queueNumber(right.get('queueNumber'));
          const leftInvalid = leftNumber === null || duplicateNumbers.has(leftNumber);
          const rightInvalid = rightNumber === null || duplicateNumbers.has(rightNumber);
          if (leftInvalid !== rightInvalid) return leftInvalid ? -1 : 1;
          if (leftNumber === null) return rightNumber === null ? left.id.localeCompare(right.id) : -1;
          if (rightNumber === null) return 1;
          return leftNumber - rightNumber || left.id.localeCompare(right.id);
        })
      : snapshot.docs;
    const queueIntegrityFailure = integrityOverflow || (status === 'queued' && orderedQueuedDocuments.some((document) => {
      const number = queueNumber(document.get('queueNumber'));
      return number === null || duplicateNumbers.has(number);
    }));
    const documents = status === 'queued' && !queueIntegrityFailure
      ? orderedQueuedDocuments.filter((document) => after === 0 || (queueNumber(document.get('queueNumber')) ?? 0) > after)
      : orderedQueuedDocuments;
    const rows: OperatorQueueRow[] = documents.slice(0, pageSize).map((doc) => {
      const number = queueNumber(doc.get('queueNumber'));
      const executionStopped = status === 'printing' && !store.hasLiveExecutionGuard();
      const state = store.hasArtifactHold(doc.id) ? 'needs_reconciliation' : store.getState(doc.id);
      const localState = state && localJobStates.includes(state) ? state : null;
      const orphanedNext = status === 'next' && activeSlotSubmissionId !== doc.id;
      const orphan = orphanedNext || (executionStopped && localState !== 'ready' && localState !== 'failed');
      const malformedQueue = status === 'queued' && (number === null || (number !== null && duplicateNumbers.has(number)) || integrityOverflow);
      const genericHold = blocking.has(doc.id);
      const reviewState = orphan || malformedQueue ? 'needs_reconciliation' :
        localState;
      const completionRetry = doc.id === completionRetrySubmissionId;
      return {
        submissionId: doc.id, queueNumber: number,
        publicStatus: completionRetry ? 'acknowledgement_pending' : status,
        localState, completionRetry,
        onHold: !completionRetry && (genericHold || reviewState === 'needs_reconciliation' || reviewState === 'failed'),
        notice: completionRetry ? 'Simulation is complete. Retry only the cloud acknowledgement.' :
          malformedQueue ? 'Queue number unavailable or conflicts with another ticket. This ticket is on hold.' :
          genericHold && reviewState !== 'failed' && reviewState !== 'needs_reconciliation' ? notice(null, 'blocked', false) :
          notice(reviewState, status, doc.get('validation.severity') === 'warning'),
      };
    });
    const canContinue = !queueIntegrityFailure && documents.length > pageSize && rows.every(row => row.queueNumber !== null);
    return { rows, next: canContinue ? rows[pageSize - 1]!.queueNumber : null };
  }

  return {
    async list(cursors: QueueCursors) {
      const pending = store.listPendingPublicStatuses();
      const possibleRetry = pending.length === 1 && pending[0]!.status === 'ready' ? pending[0]! : null;
      const retryJob = possibleRetry ? store.getBySubmissionId(possibleRetry.submissionId) : null;
      let artifactVerified = false;
      if (possibleRetry && retryJob) {
        try {
          await verifyJournalArtifact(retryJob, retryJob.artifactReceiptJson);
          artifactVerified = true;
        } catch {
          artifactVerified = false;
        }
      }
      const completionRetrySubmissionId = artifactVerified && possibleRetry && retryJob?.eventId === eventId && retryJob.state === 'ready' &&
        retryJob.completionAcknowledgedAt === null && retryJob.stateChangedAt === possibleRetry.updatedAt &&
        store.getExecutionToken(possibleRetry.submissionId) !== undefined && !store.hasArtifactHold(possibleRetry.submissionId)
        ? possibleRetry.submissionId : null;
      const blockingIds = store.listBlockingSubmissionIds();
      const blocking = new Set(blockingIds.filter((submissionId) => submissionId !== completionRetrySubmissionId));
      return firestore.runTransaction(async (transaction) => {
        const slotSnapshot = await transaction.get(firestore.collection('workerSlots').doc(eventId));
        const slotSubmissionId = slotSnapshot.exists && typeof slotSnapshot.get('submissionId') === 'string'
          ? String(slotSnapshot.get('submissionId')) : null;
        const [queued, next, printing, ready] = await Promise.all([
          page(transaction, 'queued', cursors.queued, blocking, completionRetrySubmissionId, slotSubmissionId),
          page(transaction, 'next', 0, blocking, completionRetrySubmissionId, slotSubmissionId),
          page(transaction, 'printing', 0, blocking, completionRetrySubmissionId, slotSubmissionId),
          page(transaction, 'ready', cursors.ready, blocking, completionRetrySubmissionId, slotSubmissionId),
        ]);
        const rows = [...queued.rows, ...next.rows, ...printing.rows, ...ready.rows];
        const visible = new Set(rows.map((row) => row.submissionId));
        const hiddenIds = blockingIds.filter((submissionId) => !visible.has(submissionId));
        const blockers = await Promise.all(hiddenIds.map(async (submissionId): Promise<OperatorQueueRow> => {
          const snapshot = await transaction.get(submissions.doc(submissionId));
          const local = store.getBySubmissionId(submissionId);
          const value = snapshot.exists ? snapshot.get('queueNumber') : local?.queueNumber;
          const number = queueNumber(value);
          const state = store.hasArtifactHold(submissionId) ? 'needs_reconciliation' : local?.state;
          const localState = state && localJobStates.includes(state) ? state : null;
          const completionRetry = submissionId === completionRetrySubmissionId;
          return {
            submissionId,
            queueNumber: number,
            publicStatus: completionRetry ? 'acknowledgement_pending' : 'blocked',
            localState,
            completionRetry,
            onHold: !completionRetry,
            notice: completionRetry ? 'Simulation is complete. Retry only the cloud acknowledgement.' : notice(localState, 'blocked', false),
          };
        }));
        return {
          rows: [...rows, ...blockers].sort((left, right) => {
            const leftQueuedHold = left.publicStatus === 'queued' && left.onHold;
            const rightQueuedHold = right.publicStatus === 'queued' && right.onHold;
            if (leftQueuedHold !== rightQueuedHold) return leftQueuedHold ? -1 : 1;
            return (left.queueNumber ?? 0) - (right.queueNumber ?? 0);
          }),
          next: { queued: queued.next, ready: ready.next },
          completionRetrySubmissionId,
        };
      }, { readOnly: true });
    },

    collect(submissionId: string): Promise<'collected' | 'not-found' | 'not-ready'> {
      const ref = submissions.doc(submissionId);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists || snapshot.get('eventId') !== eventId) return 'not-found';
        const status = snapshot.get('publicStatus');
        if (status === 'collected') return 'collected';
        if (status !== 'ready') return 'not-ready';
        transaction.update(ref, { publicStatus: 'collected', updatedAt: new Date().toISOString() });
        return 'collected';
      });
    },
  };
}

export type OperatorQueue = ReturnType<typeof createOperatorQueue>;
