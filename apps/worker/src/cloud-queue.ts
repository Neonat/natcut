import { SubmissionSchema, canTransitionPublicStatus, type PublicStatus, type Submission } from '@natcut/domain';
import type { Firestore } from 'firebase-admin/firestore';

const StoredSubmissionSchema = SubmissionSchema.strip();

export type ClaimedSubmission = {
  submission: Submission;
  workerId: string;
  claimedAt: string;
};

export interface CloudQueue {
  recoverClaim(workerId: string): Promise<ClaimedSubmission | null>;
  claimNextSubmission(workerId: string): Promise<ClaimedSubmission | null>;
  updatePublicStatus(submissionId: string, status: PublicStatus, updatedAt: string): Promise<void>;
}

export function createFirestoreCloudQueue(
  firestore: Firestore,
  now: () => string = () => new Date().toISOString(),
  eventId = 'devfest-sg',
): CloudQueue {
  const submissions = firestore.collection('submissions');
  const slot = firestore.collection('workerSlots').doc(eventId);
  return {
    async recoverClaim(workerId) {
      return firestore.runTransaction(async (transaction) => {
        const slotSnapshot = await transaction.get(slot);
        if (!slotSnapshot.exists || slotSnapshot.data()?.workerId !== workerId) return null;
        const submissionSnapshot = await transaction.get(submissions.doc(String(slotSnapshot.data()?.submissionId)));
        if (!submissionSnapshot.exists) throw new Error('Worker slot references a missing submission');
        const submission = StoredSubmissionSchema.parse(submissionSnapshot.data());
        return {
          submission,
          workerId,
          claimedAt: String(slotSnapshot.data()?.claimedAt),
        };
      });
    },

    async claimNextSubmission(workerId) {
      return firestore.runTransaction(async (transaction) => {
        const slotSnapshot = await transaction.get(slot);
        if (slotSnapshot.exists) return null;
        const queued = await transaction.get(
          submissions
            .where('eventId', '==', eventId)
            .where('publicStatus', '==', 'queued')
            .orderBy('queueNumber', 'asc')
            .limit(1),
        );
        const document = queued.docs[0];
        if (!document) return null;
        const submission = StoredSubmissionSchema.parse(document.data());
        const claimedAt = now();
        transaction.update(document.ref, {
          publicStatus: 'next',
          updatedAt: claimedAt,
          workerLease: { workerId, claimedAt },
        });
        transaction.create(slot, { submissionId: submission.id, workerId, claimedAt });
        return { submission: { ...submission, publicStatus: 'next', updatedAt: claimedAt }, workerId, claimedAt };
      });
    },

    async updatePublicStatus(submissionId, status, updatedAt) {
      const ref = submissions.doc(submissionId);
      await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error(`Missing cloud submission ${submissionId}`);
        const submission = StoredSubmissionSchema.parse(snapshot.data());
        const slotSnapshot = await transaction.get(slot);
        if (submission.publicStatus === status) {
          if (status === 'ready' && slotSnapshot.data()?.submissionId === submissionId) transaction.delete(slot);
          return;
        }
        if (!canTransitionPublicStatus(submission.publicStatus, status)) {
          throw new Error(`Invalid public status transition ${submission.publicStatus} -> ${status}`);
        }
        transaction.update(ref, { publicStatus: status, updatedAt });
        if (status === 'ready' && slotSnapshot.data()?.submissionId === submissionId) transaction.delete(slot);
      });
    },
  };
}
