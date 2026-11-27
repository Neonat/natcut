import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

const SurveyRecordSchema = z.object({
  email: z.string().email().nullable(),
  eventId: z.string().min(1),
  stickerSubmissionId: z.string().min(1),
  cuteRating: z.number().int().min(1).max(5),
  selfieStoragePath: z.string().nullable(),
  submittedAt: z.string().datetime(),
}).strict();

export type SurveyRecord = z.infer<typeof SurveyRecordSchema>;

export type SurveyInput = {
  ownerUid: string;
  eventId: string;
  stickerSubmissionId: string;
  cuteRating: 1 | 2 | 3 | 4 | 5;
  marketingEmail: string | null;
  submittedAt: string;
};

export type SubmitSurveyResult = {
  surveyId: string;
  survey: SurveyRecord;
  created: boolean;
};

export class SurveyUnavailableError extends Error {
  constructor() {
    super('The collected sticker is not available for this visitor survey.');
  }
}

export interface SurveyRepository {
  submit(input: SurveyInput): Promise<SubmitSurveyResult>;
  status(input: Pick<SurveyInput, 'ownerUid' | 'eventId' | 'stickerSubmissionId'>): Promise<{ eligible: boolean; submitted: boolean }>;
}

function documentId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function createSurveyRepository(firestore: Firestore): SurveyRepository {
  return {
    async status(input) {
      const submission = (await firestore.collection('submissions').doc(input.stickerSubmissionId).get()).data();
      const eligible = Boolean(submission && submission.ownerUid === input.ownerUid
        && submission.eventId === input.eventId && submission.publicStatus === 'collected');
      if (!eligible) return { eligible: false, submitted: false };
      const surveyId = documentId(input.eventId, input.ownerUid);
      return { eligible: true, submitted: (await firestore.collection('surveys').doc(surveyId).get()).exists };
    },
    async submit(input) {
      const surveyId = documentId(input.eventId, input.ownerUid);
      const surveyRef = firestore.collection('surveys').doc(surveyId);
      const submissionRef = firestore.collection('submissions').doc(input.stickerSubmissionId);
      const email = input.marketingEmail?.trim().toLowerCase() ?? null;
      const leadRef = email ? firestore.collection('marketingLeads').doc(documentId(input.eventId, email)) : null;

      return firestore.runTransaction(async (transaction) => {
        const existing = await transaction.get(surveyRef);
        const submission = await transaction.get(submissionRef);
        const data = submission.data();
        if (!submission.exists || data?.ownerUid !== input.ownerUid || data.eventId !== input.eventId || data.publicStatus !== 'collected') {
          throw new SurveyUnavailableError();
        }
        if (existing.exists) {
          return { surveyId, survey: SurveyRecordSchema.parse(existing.data()), created: false };
        }

        const lead = leadRef ? await transaction.get(leadRef) : null;
        const survey = SurveyRecordSchema.parse({
          email,
          eventId: input.eventId,
          stickerSubmissionId: input.stickerSubmissionId,
          cuteRating: input.cuteRating,
          selfieStoragePath: null,
          submittedAt: input.submittedAt,
        });
        transaction.create(surveyRef, survey);
        if (leadRef && !lead?.exists) {
          transaction.create(leadRef, {
            email,
            eventId: input.eventId,
            onboardedAt: input.submittedAt,
            optionalSubmissionId: surveyId,
          });
        }
        return { surveyId, survey, created: true };
      });
    },
  };
}
