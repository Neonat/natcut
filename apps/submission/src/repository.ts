import { createHash } from 'node:crypto';
import {
  SubmissionSchema,
  type CompositionManifest,
  type GeometryReport,
  type PrintSpec,
  type Submission,
} from '@natcut/domain';
import type { Firestore } from 'firebase-admin/firestore';

const StoredSubmissionSchema = SubmissionSchema.strip();

export type CreateSubmissionInput = {
  ownerUid: string;
  eventId: string;
  idempotencyKey: string;
  manifest: CompositionManifest;
  manifestHash: string;
  printSpec: PrintSpec;
  validation: GeometryReport;
  publicStatusTokenHash: string;
  acceptedAt: string;
  requeuedFrom: string | null;
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key is already bound to a different submission payload.');
  }
}

export class RequeueForbiddenError extends Error {
  constructor() {
    super('The requeued submission must be cancelled and owned by the same visitor.');
  }
}

export type LeaveResult = 'cancelled' | 'locked' | 'not-found';

export interface SubmissionRepository {
  create(input: CreateSubmissionInput): Promise<{ submission: Submission; created: boolean }>;
  getPublicStatus(id: string, tokenHash: string): Promise<Submission | null>;
  leave(id: string, tokenHash: string, now: string): Promise<LeaveResult>;
}

function idempotencyDocumentId(ownerUid: string, eventId: string, key: string): string {
  return createHash('sha256').update(`${ownerUid}\0${eventId}\0${key}`).digest('hex');
}

function isUnfinished(status: Submission['publicStatus']): boolean {
  return ['joining', 'queued', 'next', 'printing'].includes(status);
}

export function createSubmissionRepository(firestore: Firestore): SubmissionRepository {
  const submissions = firestore.collection('submissions');
  const idempotency = firestore.collection('submissionIdempotency');
  const counters = firestore.collection('queueCounters');

  return {
    async create(input) {
      const idempotencyRef = idempotency.doc(
        idempotencyDocumentId(input.ownerUid, input.eventId, input.idempotencyKey),
      );
      const submissionRef = submissions.doc();
      const counterRef = counters.doc(input.eventId);

      return firestore.runTransaction(async (transaction) => {
        const idempotencySnapshot = await transaction.get(idempotencyRef);
        if (idempotencySnapshot.exists) {
          const binding = idempotencySnapshot.data()!;
          if (binding.manifestHash !== input.manifestHash || binding.requeuedFrom !== input.requeuedFrom) {
            throw new IdempotencyConflictError();
          }
          const existingSnapshot = await transaction.get(submissions.doc(String(binding.submissionId)));
          if (!existingSnapshot.exists) throw new Error('Idempotency binding references a missing submission');
          return { submission: StoredSubmissionSchema.parse(existingSnapshot.data()), created: false };
        }

        const counterSnapshot = await transaction.get(counterRef);
        const nextQueueNumber = Number(counterSnapshot.data()?.lastQueueNumber ?? 0) + 1;

        if (input.requeuedFrom) {
          const priorSnapshot = await transaction.get(submissions.doc(input.requeuedFrom));
          const prior = priorSnapshot.exists ? StoredSubmissionSchema.parse(priorSnapshot.data()) : null;
          if (!prior || prior.ownerUid !== input.ownerUid || prior.publicStatus !== 'cancelled') {
            throw new RequeueForbiddenError();
          }
        }

        const eventSnapshot = await transaction.get(submissions.where('eventId', '==', input.eventId));
        const jobsAhead = eventSnapshot.docs
          .map((document) => StoredSubmissionSchema.parse(document.data()))
          .filter((submission) => isUnfinished(submission.publicStatus)).length;

        const submission = SubmissionSchema.parse({
          id: submissionRef.id,
          ownerUid: input.ownerUid,
          eventId: input.eventId,
          idempotencyKey: input.idempotencyKey,
          manifest: input.manifest,
          manifestHash: input.manifestHash,
          printSpec: input.printSpec,
          validation: input.validation,
          publicStatus: 'queued',
          publicStatusTokenHash: input.publicStatusTokenHash,
          queueNumber: nextQueueNumber,
          jobsAhead,
          acceptedAt: input.acceptedAt,
          cancelledAt: null,
          requeuedFrom: input.requeuedFrom,
          updatedAt: input.acceptedAt,
        });

        transaction.set(counterRef, { lastQueueNumber: nextQueueNumber });
        transaction.create(submissionRef, submission);
        transaction.create(idempotencyRef, {
          submissionId: submission.id,
          manifestHash: submission.manifestHash,
          requeuedFrom: submission.requeuedFrom,
        });
        return { submission, created: true };
      });
    },

    async getPublicStatus(id, tokenHash) {
      const snapshot = await submissions.doc(id).get();
      if (!snapshot.exists) return null;
      const submission = StoredSubmissionSchema.parse(snapshot.data());
      if (submission.publicStatusTokenHash !== tokenHash) return null;
      const aheadSnapshot = await submissions
        .where('eventId', '==', submission.eventId)
        .where('queueNumber', '<', submission.queueNumber)
        .get();
      const jobsAhead = aheadSnapshot.docs
        .map((document) => StoredSubmissionSchema.parse(document.data()))
        .filter((candidate) => isUnfinished(candidate.publicStatus)).length;
      return { ...submission, jobsAhead };
    },

    async leave(id, tokenHash, now) {
      const ref = submissions.doc(id);
      return firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return 'not-found';
        const submission = StoredSubmissionSchema.parse(snapshot.data());
        if (submission.publicStatusTokenHash !== tokenHash) return 'not-found';
        if (submission.publicStatus !== 'joining' && submission.publicStatus !== 'queued') return 'locked';
        transaction.update(ref, { publicStatus: 'cancelled', cancelledAt: now, updatedAt: now });
        return 'cancelled';
      });
    },
  };
}
