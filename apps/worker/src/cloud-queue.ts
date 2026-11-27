import { isDeepStrictEqual } from 'node:util';
import { SubmissionSchema, manifestHash, type ArtifactReceipt, type Submission } from '@natcut/domain';
import type { Firestore } from 'firebase-admin/firestore';

export class InvalidClaimError extends Error {
  readonly submissionId: string;
  constructor(submissionId: string) {
    super('Worker slot references a missing or invalid submission.');
    this.submissionId = submissionId;
  }
}

export class UnexpectedSubmissionError extends Error {
  constructor(readonly expectedSubmissionId: string, readonly actualSubmissionId: string) {
    super(`Smoke worker expected submission ${expectedSubmissionId}, but queue selected ${actualSubmissionId}.`);
  }
}

function readClaimRecord(id: string, data: FirebaseFirestore.DocumentData | undefined, eventId: string) {
  const { workerLease: _claim, executionLease: _execution, completionFence: _completion, ...record } = data ?? {};
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

export type CompletionEvidence = ExecutionEvidence & {
  submissionId: string;
  eventId: string;
  workerId: string;
  executionToken: string;
};

export type CompletionOutcome = 'committed' | 'confirmed' | 'fenced';

const queueIntegrityScanLimit = 1_000;

function invalidQueuedSubmission(
  documents: FirebaseFirestore.QueryDocumentSnapshot[],
): string | null {
  const numbers = new Map<number, string>();
  for (const document of documents) {
    const value: unknown = document.get('queueNumber');
    if (!Number.isSafeInteger(value) || Number(value) <= 0) return document.id;
    const queueNumber = Number(value);
    const duplicate = numbers.get(queueNumber);
    if (duplicate) return [duplicate, document.id].sort()[0]!;
    numbers.set(queueNumber, document.id);
  }
  return null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export interface CloudQueue {
  recoverClaim(workerId: string, expectedSubmissionId?: string): Promise<ClaimedSubmission | null>;
  claimNextSubmission(workerId: string, expectedSubmissionId?: string): Promise<ClaimedSubmission | null>;
  beginExecution(
    submissionId: string,
    workerId: string,
    executionToken: string,
    updatedAt: string,
    evidence: ExecutionEvidence,
  ): Promise<'acquired' | 'fenced'>;
  completeExecution(evidence: CompletionEvidence, updatedAt: string): Promise<CompletionOutcome>;
}

export function createFirestoreCloudQueue(
  firestore: Firestore,
  now: () => string = () => new Date().toISOString(),
  eventId = 'devfest-sg',
): CloudQueue {
  const submissions = firestore.collection('submissions');
  const slot = firestore.collection('workerSlots').doc(eventId);
  return {
    async recoverClaim(workerId, expectedSubmissionId) {
      return firestore.runTransaction(async (transaction) => {
        const slotSnapshot = await transaction.get(slot);
        if (!slotSnapshot.exists || slotSnapshot.data()?.workerId !== workerId) return null;
        const submissionId = String(slotSnapshot.data()?.submissionId);
        if (expectedSubmissionId && submissionId !== expectedSubmissionId) {
          throw new UnexpectedSubmissionError(expectedSubmissionId, submissionId);
        }
        const submissionSnapshot = await transaction.get(submissions.doc(submissionId));
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

    async claimNextSubmission(workerId, expectedSubmissionId) {
      const claimed = await firestore.runTransaction(async (transaction) => {
        const slotSnapshot = await transaction.get(slot);
        if (slotSnapshot.exists) return null;
        const orphanedNext = await transaction.get(
          submissions
            .where('eventId', '==', eventId)
            .where('publicStatus', '==', 'next')
            .select('queueNumber')
            .limit(1),
        );
        if (orphanedNext.docs[0]) throw new InvalidClaimError(orphanedNext.docs[0].id);
        const queuedBase = submissions
          .where('eventId', '==', eventId)
          .where('publicStatus', '==', 'queued');
        // Firestore ordering omits documents that do not contain the ordered field. Audit the
        // bounded active queue first so a malformed invisible record cannot release its follower.
        const integrity = await transaction.get(
          queuedBase.select('queueNumber').limit(queueIntegrityScanLimit + 1),
        );
        const invalid = integrity.size > queueIntegrityScanLimit
          ? integrity.docs.map((document) => document.id).sort()[0] ?? null
          : invalidQueuedSubmission(integrity.docs);
        if (invalid) throw new InvalidClaimError(invalid);
        const queued = await transaction.get(
          queuedBase
            .orderBy('queueNumber', 'asc')
            .limit(1),
        );
        const document = queued.docs[0];
        if (!document) return null;
        if (expectedSubmissionId && document.id !== expectedSubmissionId) {
          throw new UnexpectedSubmissionError(expectedSubmissionId, document.id);
        }
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
        if (!isIsoTimestamp(updatedAt) || !submission || submission.publicStatus !== 'next' || submission.recordVersion !== 2 ||
            snapshot.get('executionLease') !== undefined || snapshot.get('completionFence') !== undefined ||
            !isDeepStrictEqual(submission.artifact, evidence.receipt) || !isDeepStrictEqual(submission.validation, evidence.validation) ||
            submission.manifestHash !== evidence.manifestHash || await manifestHash(submission.manifest) !== evidence.manifestHash) {
          return 'fenced';
        }
        transaction.update(ref, {
          publicStatus: 'printing',
          updatedAt,
          executionLease: { workerId, token: executionToken, startedAt: updatedAt, evidence },
        });
        return 'acquired';
      });
    },

    async completeExecution(evidence, updatedAt) {
      const ref = submissions.doc(evidence.submissionId);
      return firestore.runTransaction(async (transaction): Promise<CompletionOutcome> => {
        const [snapshot, slotSnapshot] = await Promise.all([transaction.get(ref), transaction.get(slot)]);
        const submission = readClaimRecord(snapshot.id, snapshot.data(), eventId);
        if (!isIsoTimestamp(updatedAt) || !submission || evidence.eventId !== eventId || submission.id !== evidence.submissionId ||
            submission.eventId !== evidence.eventId || submission.recordVersion !== 2 ||
            !isDeepStrictEqual(submission.artifact, evidence.receipt) ||
            !isDeepStrictEqual(submission.validation, evidence.validation) ||
            submission.manifestHash !== evidence.manifestHash ||
            await manifestHash(submission.manifest) !== evidence.manifestHash) {
          return 'fenced';
        }

        const persistedFence = snapshot.get('completionFence');
        if (submission.publicStatus === 'ready' || submission.publicStatus === 'collected') {
          const terminalSlot = slotSnapshot.data();
          const slotReleased = !slotSnapshot.exists ||
            (typeof terminalSlot?.submissionId === 'string' && terminalSlot.submissionId.length > 0 &&
             terminalSlot.submissionId !== evidence.submissionId &&
             typeof terminalSlot.workerId === 'string' && terminalSlot.workerId.length > 0 &&
             isIsoTimestamp(terminalSlot.claimedAt));
          if (!slotReleased ||
              !persistedFence || !isDeepStrictEqual({
                submissionId: persistedFence.submissionId,
                eventId: persistedFence.eventId,
                workerId: persistedFence.workerId,
                executionToken: persistedFence.executionToken,
                receipt: persistedFence.receipt,
                manifestHash: persistedFence.manifestHash,
                validation: persistedFence.validation,
              }, evidence)) return 'fenced';
          return 'confirmed';
        }

        const slotData = slotSnapshot.data();
        const executionLease = snapshot.get('executionLease');
        if (submission.publicStatus !== 'printing' || persistedFence !== undefined ||
            !slotSnapshot.exists || slotData?.submissionId !== evidence.submissionId ||
            slotData?.workerId !== evidence.workerId || executionLease?.workerId !== evidence.workerId ||
            executionLease?.token !== evidence.executionToken ||
            !isDeepStrictEqual(executionLease?.evidence, {
              receipt: evidence.receipt,
              manifestHash: evidence.manifestHash,
              validation: evidence.validation,
            })) return 'fenced';

        transaction.update(ref, {
          publicStatus: 'ready',
          updatedAt,
          completionFence: { ...evidence, completedAt: updatedAt },
        });
        transaction.delete(slot);
        return 'committed';
      });
    },
  };
}
