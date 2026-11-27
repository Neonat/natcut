import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { localJobStates, type JobStore, type LocalJobState } from './job-store.ts';

type DeskStatus = 'queued' | 'next' | 'printing' | 'ready' | 'blocked';
export type QueueCursors = { queued: number; ready: number };
export type OperatorQueueRow = {
  submissionId: string;
  queueNumber: number | null;
  publicStatus: DeskStatus;
  localState: LocalJobState | null;
  notice: string | null;
  onHold: boolean;
};

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

  async function page(transaction: Transaction, status: DeskStatus, after: number) {
    // The exclusive worker slot permits at most one Next or Printing ticket in this event.
    const paginated = status === 'queued' || status === 'ready';
    let query = submissions.where('eventId', '==', eventId).where('publicStatus', '==', status)
      .select('queueNumber', 'validation.severity');
    // Ordering excludes documents without this field, including malformed active claims.
    if (paginated) query = query.orderBy('queueNumber');
    if (after) query = query.startAfter(after);
    const snapshot = await transaction.get(query.limit(paginated ? pageSize + 1 : 1));
    const rows: OperatorQueueRow[] = snapshot.docs.slice(0, pageSize).map((doc) => {
      const value = doc.get('queueNumber');
      const queueNumber = Number.isSafeInteger(value) && value > 0 ? value as number : null;
      const executionStopped = status === 'printing' && !store.hasLiveExecutionGuard();
      const state = store.hasArtifactHold(doc.id) ? 'needs_reconciliation' : store.getState(doc.id);
      const localState = state && localJobStates.includes(state) ? state : null;
      const orphan = executionStopped && localState !== 'ready' && localState !== 'failed';
      const reviewState = orphan || queueNumber === null ? 'needs_reconciliation' : localState;
      return {
        submissionId: doc.id, queueNumber, publicStatus: status,
        localState, onHold: reviewState === 'needs_reconciliation' || reviewState === 'failed',
        notice: queueNumber === null ? 'Queue number unavailable. This ticket is on hold.' :
          notice(reviewState, status, doc.get('validation.severity') === 'warning'),
      };
    });
    const canContinue = snapshot.size > pageSize && rows.every(row => row.queueNumber !== null);
    return { rows, next: canContinue ? rows[pageSize - 1]!.queueNumber : null };
  }

  return {
    list(cursors: QueueCursors) {
      return firestore.runTransaction(async (transaction) => {
        const [queued, next, printing, ready] = await Promise.all([
          page(transaction, 'queued', cursors.queued), page(transaction, 'next', 0),
          page(transaction, 'printing', 0), page(transaction, 'ready', cursors.ready),
        ]);
        const rows = [...queued.rows, ...next.rows, ...printing.rows, ...ready.rows];
        const visible = new Set(rows.map((row) => row.submissionId));
        const blockingIds = store.listBlockingSubmissionIds().filter((submissionId) => !visible.has(submissionId));
        const blockers = await Promise.all(blockingIds.map(async (submissionId): Promise<OperatorQueueRow> => {
          const snapshot = await transaction.get(submissions.doc(submissionId));
          const local = store.getBySubmissionId(submissionId);
          const value = snapshot.exists ? snapshot.get('queueNumber') : local?.queueNumber;
          const queueNumber = Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
          const state = store.hasArtifactHold(submissionId) ? 'needs_reconciliation' : local?.state;
          const localState = state && localJobStates.includes(state) ? state : null;
          return {
            submissionId,
            queueNumber,
            publicStatus: 'blocked',
            localState,
            onHold: true,
            notice: notice(localState, 'blocked', false),
          };
        }));
        return {
          rows: [...rows, ...blockers].sort((a, b) => (a.queueNumber ?? 0) - (b.queueNumber ?? 0)),
          next: { queued: queued.next, ready: ready.next },
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
