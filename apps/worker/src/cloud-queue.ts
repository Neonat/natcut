import { isDeepStrictEqual } from 'node:util';
import { SubmissionSchema, canTransitionPublicStatus, manifestHash, type ArtifactReceipt, type PublicStatus, type Submission } from '@natcut/domain';
import type { Firestore } from 'firebase-admin/firestore';

const StoredSubmissionSchema = SubmissionSchema.strip();

export class InvalidClaimError extends Error {
  readonly submissionId: string;
  constructor(submissionId: string) {
    super('Worker slot references a missing or invalid submission.');
    this.submissionId = submissionId;
  }
}

function readClaimRecord(id: string, data: FirebaseFirestore.DocumentData | undefined, eventId: string) {
  const { workerLease: _claim, executionLease: _execution, ...record } = data ?? {};
  const parsed = SubmissionSchema.safeParse(record);
  return parsed.success && parsed.data.id === id && parsed.data.eventId === eventId ? parsed.data : null;
}

type RuntimeEnvironment = Record<string, string | undefined>;

export type WorkerFirestoreSelection = {
  projectId: 'demo-natcut' | 'sprout-dev-66f08';
  databaseId: 'natcut' | undefined;
};

export function resolveWorkerFirestoreSelection(environment: RuntimeEnvironment): WorkerFirestoreSelection {
  const projectId = environment.NATCUT_PROJECT_ID;
  if (projectId === 'demo-natcut') {
    if (environment.NATCUT_DATABASE_ID !== undefined) {
      throw new Error('Local development must not set NATCUT_DATABASE_ID; the emulator uses its default database.');
    }
    if (environment.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080') {
      throw new Error('Local development requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8080.');
    }
    return { projectId, databaseId: undefined };
  }
  if (projectId !== 'sprout-dev-66f08') {
    throw new Error('Production requires NATCUT_PROJECT_ID=sprout-dev-66f08.');
  }
  if (environment.NATCUT_DATABASE_ID !== 'natcut') {
    throw new Error('Production requires NATCUT_DATABASE_ID=natcut.');
  }
  if (environment.FIRESTORE_EMULATOR_HOST !== undefined) {
    throw new Error('Production must not use FIRESTORE_EMULATOR_HOST.');
  }
  return { projectId, databaseId: 'natcut' };
}

export type ClaimedSubmission = {
  submission: Submission;
  workerId: string;
  claimedAt: string;
  executionToken?: string | null;
};

export type ExecutionEvidence = Pick<Submission, 'manifestHash' | 'validation'> & { receipt: ArtifactReceipt };

export interface CloudQueue {
  isReadyAcknowledged(submissionId: string): Promise<boolean>;
  recoverClaim(workerId: string): Promise<ClaimedSubmission | null>;
  claimNextSubmission(workerId: string): Promise<ClaimedSubmission | null>;
  beginExecution(
    submissionId: string,
    workerId: string,
    executionToken: string,
    updatedAt: string,
    evidence: ExecutionEvidence,
  ): Promise<'acquired' | 'fenced'>;
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
    async isReadyAcknowledged(submissionId) {
      return firestore.runTransaction(async transaction => {
        const [ticket, active] = await Promise.all([transaction.get(submissions.doc(submissionId)), transaction.get(slot)]);
        const status = ticket.get('publicStatus');
        const activeId = active.get('submissionId');
        return ticket.get('id') === submissionId && ticket.get('eventId') === eventId &&
          (status === 'ready' || status === 'collected') &&
          (!active.exists || (typeof activeId === 'string' && activeId.length > 0 && activeId !== submissionId));
      }, { readOnly: true });
    },

    async recoverClaim(workerId) {
      return firestore.runTransaction(async (transaction) => {
        const slotSnapshot = await transaction.get(slot);
        if (!slotSnapshot.exists || slotSnapshot.data()?.workerId !== workerId) return null;
        const submissionSnapshot = await transaction.get(submissions.doc(String(slotSnapshot.data()?.submissionId)));
        const submission = readClaimRecord(submissionSnapshot.id, submissionSnapshot.data(), eventId);
        if (!submission) throw new InvalidClaimError(submissionSnapshot.id);
        return {
          submission,
          workerId,
          claimedAt: String(slotSnapshot.data()?.claimedAt),
          executionToken: submissionSnapshot.data()?.executionLease?.workerId === workerId &&
            typeof submissionSnapshot.data()?.executionLease?.token === 'string'
            ? submissionSnapshot.data()!.executionLease.token
            : null,
        };
      });
    },

    async claimNextSubmission(workerId) {
      const claimed = await firestore.runTransaction(async (transaction) => {
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
        const claimedAt = now();
        transaction.update(document.ref, {
          publicStatus: 'next',
          updatedAt: claimedAt,
          workerLease: { workerId, claimedAt },
        });
        transaction.create(slot, { submissionId: document.id, workerId, claimedAt });
        return { id: document.id, data: document.data(), claimedAt };
      });
      if (!claimed) return null;
      // Decode after committing the slot so an invalid head remains held across workers and restarts.
      const submission = readClaimRecord(claimed.id, claimed.data, eventId);
      if (!submission) throw new InvalidClaimError(claimed.id);
      return {
        submission: { ...submission, publicStatus: 'next', updatedAt: claimed.claimedAt },
        claimedAt: claimed.claimedAt, workerId, executionToken: null,
      };
    },

    async beginExecution(submissionId, workerId, executionToken, updatedAt, evidence) {
      const ref = submissions.doc(submissionId);
      return firestore.runTransaction(async (transaction) => {
        const [snapshot, slotSnapshot] = await Promise.all([
          transaction.get(ref),
          transaction.get(slot),
        ]);
        const slotData = slotSnapshot.data();
        if (
          !slotSnapshot.exists ||
          slotData?.submissionId !== submissionId ||
          slotData?.workerId !== workerId
        ) return 'fenced';
        const submission = readClaimRecord(submissionId, snapshot.data(), eventId);
        if (!submission || submission.publicStatus !== 'next' || submission.recordVersion !== 2 ||
            !isDeepStrictEqual(submission.artifact, evidence.receipt) || !isDeepStrictEqual(submission.validation, evidence.validation) ||
            submission.manifestHash !== evidence.manifestHash || await manifestHash(submission.manifest) !== evidence.manifestHash) {
          return 'fenced';
        }
        transaction.update(ref, {
          publicStatus: 'printing',
          updatedAt,
          executionLease: { workerId, token: executionToken, startedAt: updatedAt },
        });
        return 'acquired';
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
        const superseded =
          (status === 'printing' && ['ready', 'collected'].includes(submission.publicStatus)) ||
          (status === 'ready' && submission.publicStatus === 'collected');
        if (superseded) {
          if (slotSnapshot.data()?.submissionId === submissionId) transaction.delete(slot);
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
