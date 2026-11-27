import { createHash } from 'node:crypto';
import {
  PublicStatusSchema,
  SubmissionSchema,
  type ArtifactReceipt,
  type CompositionManifest,
  type GeometryReport,
  type PrintSpec,
  type Submission,
} from '@natcut/domain';
import type { Firestore, QuerySnapshot, Transaction } from 'firebase-admin/firestore';

const StoredSubmissionSchema = SubmissionSchema.strip();

type RuntimeEnvironment = Record<string, string | undefined>;

export type FirestoreSelection = {
  projectId: 'demo-natcut' | 'sprout-dev-66f08';
  databaseId: 'natcut' | undefined;
};

export function resolveSubmissionFirestoreSelection(environment: RuntimeEnvironment): FirestoreSelection {
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

export type SubmissionLookup = {
  ownerUid: string;
  eventId: string;
  idempotencyKey: string;
  manifestHash: string;
  requeuedFrom: string | null;
};

export type CreateSubmissionInput = SubmissionLookup & {
  manifest: CompositionManifest;
  artifact: ArtifactReceipt;
  printSpec: PrintSpec;
  validation: GeometryReport;
  publicStatusTokenHash: string;
  acceptedAt: string;
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
  findAccepted(input: SubmissionLookup): Promise<Submission | null>;
  create(input: CreateSubmissionInput): Promise<{ submission: Submission; created: boolean }>;
  getPublicStatus(id: string, tokenHash: string): Promise<Submission | null>;
  leave(id: string, tokenHash: string, now: string): Promise<LeaveResult>;
}

function idempotencyDocumentId(ownerUid: string, eventId: string, key: string): string {
  return createHash('sha256').update(`${ownerUid}\0${eventId}\0${key}`).digest('hex');
}

function countUnfinished(snapshot: QuerySnapshot): number {
  return snapshot.docs.filter((document) =>
    ['joining', 'queued', 'next', 'printing'].includes(PublicStatusSchema.parse(document.get('publicStatus')))).length;
}

export function createSubmissionRepository(firestore: Firestore): SubmissionRepository {
  const submissions = firestore.collection('submissions');
  const idempotency = firestore.collection('submissionIdempotency');
  const counters = firestore.collection('queueCounters');

  const bindingRef = (input: SubmissionLookup) =>
    idempotency.doc(idempotencyDocumentId(input.ownerUid, input.eventId, input.idempotencyKey));

  async function checkRequest(transaction: Transaction, input: SubmissionLookup) {
    const binding = (await transaction.get(bindingRef(input))).data();
    if (!binding) {
      if (input.requeuedFrom) {
        const priorSnapshot = await transaction.get(submissions.doc(input.requeuedFrom));
        const prior = priorSnapshot.exists ? StoredSubmissionSchema.parse(priorSnapshot.data()) : null;
        if (!prior || prior.ownerUid !== input.ownerUid || prior.eventId !== input.eventId || prior.publicStatus !== 'cancelled') {
          throw new RequeueForbiddenError();
        }
      }
      return null;
    }
    if (binding.manifestHash !== input.manifestHash || binding.requeuedFrom !== input.requeuedFrom) {
      throw new IdempotencyConflictError();
    }
    const existing = await transaction.get(submissions.doc(binding.submissionId));
    if (!existing.exists) throw new Error('Idempotency binding references a missing submission');
    const submission = StoredSubmissionSchema.parse(existing.data());
    if (submission.id !== existing.id || submission.ownerUid !== input.ownerUid || submission.eventId !== input.eventId ||
      submission.idempotencyKey !== input.idempotencyKey || submission.manifestHash !== input.manifestHash ||
      submission.requeuedFrom !== input.requeuedFrom) throw new Error('Idempotency binding references a different submission');
    return submission;
  }

  return {
    findAccepted(input) {
      return firestore.runTransaction((transaction) => checkRequest(transaction, input), { readOnly: true });
    },

    async create(input) {
      const submissionRef = submissions.doc();
      const counterRef = counters.doc(input.eventId);

      return firestore.runTransaction(async (transaction) => {
        const existing = await checkRequest(transaction, input);
        if (existing) return { submission: existing, created: false };

        const counterSnapshot = await transaction.get(counterRef);
        const nextQueueNumber = Number(counterSnapshot.data()?.lastQueueNumber ?? 0) + 1;

        const eventSnapshot = await transaction.get(submissions.where('eventId', '==', input.eventId).select('publicStatus'));
        const jobsAhead = countUnfinished(eventSnapshot);

        const submission = SubmissionSchema.parse({
          recordVersion: 2,
          artifact: input.artifact,
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
        transaction.create(bindingRef(input), {
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
        .select('publicStatus')
        .get();
      return { ...submission, jobsAhead: countUnfinished(aheadSnapshot) };
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
