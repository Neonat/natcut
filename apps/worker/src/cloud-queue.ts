import { SubmissionSchema, canTransitionPublicStatus, type PublicStatus, type Submission } from '@natcut/domain';
import type { Firestore } from 'firebase-admin/firestore';

const StoredSubmissionSchema = SubmissionSchema.strip();

export type ClaimedSubmission = {
  submission: Submission;
  workerId: string;
  claimedAt: string;
};

export interface CloudQueue {
  claimNextSubmission(workerId: string): Promise<ClaimedSubmission | null>;
  updatePublicStatus(submissionId: string, status: PublicStatus, updatedAt: string): Promise<void>;
}

export function createFirestoreCloudQueue(
  firestore: Firestore,
  now: () => string = () => new Date().toISOString(),
  eventId = 'devfest-sg',
): CloudQueue {
  const submissions = firestore.collection('submissions');
  return {
    async claimNextSubmission(workerId) {
      return firestore.runTransaction(async (transaction) => {
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
        return { submission: { ...submission, publicStatus: 'next', updatedAt: claimedAt }, workerId, claimedAt };
      });
    },

    async updatePublicStatus(submissionId, status, updatedAt) {
      const ref = submissions.doc(submissionId);
      await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error(`Missing cloud submission ${submissionId}`);
        const submission = StoredSubmissionSchema.parse(snapshot.data());
        if (submission.publicStatus === status) return;
        if (!canTransitionPublicStatus(submission.publicStatus, status)) {
          throw new Error(`Invalid public status transition ${submission.publicStatus} -> ${status}`);
        }
        transaction.update(ref, { publicStatus: status, updatedAt });
      });
    },
  };
}
