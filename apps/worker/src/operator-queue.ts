import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { localJobStates, type JobStore, type LocalJobState } from './job-store.ts';

type DeskStatus = 'queued' | 'next' | 'printing' | 'ready';
export type QueueCursors = { queued: number; ready: number };
export type OperatorQueueRow = {
  submissionId: string;
  queueNumber: number;
  publicStatus: DeskStatus;
  localState: LocalJobState | null;
  notice: string | null;
  onHold: boolean;
};

function notice(state: LocalJobState | null, status: DeskStatus, hasWarning: boolean) {
  if (state === 'failed') return 'Simulation failed. This ticket is on hold.';
  if (state === 'needs_reconciliation') return 'Execution needs reconciliation. This ticket is on hold.';
  if (state === 'ready' && status === 'printing') return 'Simulation complete. Ready status is waiting to publish.';
  return hasWarning ? 'Design has a geometry warning.' : null;
}

export function createOperatorQueue(firestore: Firestore, eventId: string, store: JobStore) {
  const submissions = firestore.collection('submissions');
  const pageSize = 25;

  async function page(transaction: Transaction, status: DeskStatus, after: number) {
    let query = submissions.where('eventId', '==', eventId).where('publicStatus', '==', status)
      .orderBy('queueNumber').select('queueNumber', 'validation.severity');
    if (after) query = query.startAfter(after);
    // The exclusive worker slot permits at most one Next or Printing ticket in this event.
    const paginated = status === 'queued' || status === 'ready';
    const snapshot = await transaction.get(query.limit(paginated ? pageSize + 1 : 1));
    const rows: OperatorQueueRow[] = snapshot.docs.slice(0, pageSize).map((doc) => {
      const queueNumber = doc.get('queueNumber');
      if (!Number.isSafeInteger(queueNumber) || queueNumber < 1) throw Error('Invalid queue number');
      const executionStopped = status === 'printing' && !store.hasLiveExecutionGuard();
      const state = store.getBySubmissionId(doc.id)?.state;
      const localState = state && localJobStates.includes(state) ? state : null;
      const orphan = executionStopped && localState !== 'ready' && localState !== 'failed';
      const reviewState = orphan ? 'needs_reconciliation' : localState;
      return {
        submissionId: doc.id, queueNumber, publicStatus: status,
        localState, onHold: reviewState === 'needs_reconciliation' || reviewState === 'failed',
        notice: notice(reviewState, status, doc.get('validation.severity') === 'warning'),
      };
    });
    return { rows, next: snapshot.size > pageSize ? rows[pageSize - 1]!.queueNumber : null };
  }

  return {
    list(cursors: QueueCursors) {
      return firestore.runTransaction(async (transaction) => {
        const [queued, next, printing, ready] = await Promise.all([
          page(transaction, 'queued', cursors.queued), page(transaction, 'next', 0),
          page(transaction, 'printing', 0), page(transaction, 'ready', cursors.ready),
        ]);
        return {
          rows: [...queued.rows, ...next.rows, ...printing.rows, ...ready.rows].sort((a, b) => a.queueNumber - b.queueNumber),
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
