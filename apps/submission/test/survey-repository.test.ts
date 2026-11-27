import { generateKeyPairSync } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { submissionInput } from './fixtures/artifact.ts';
import {
  SurveyUnavailableError,
  createSurveyRepository,
  type SurveyInput,
} from '../src/survey-repository.ts';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const emulatorDescribe = emulatorEnabled ? describe : describe.skip;
const eventId = 'survey-repository-test';

emulatorDescribe('survey repository', () => {
  const privateKey = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const admin = getApps().find((app) => app.name === 'survey-repository-test') ?? initializeApp({
    projectId: 'demo-natcut',
    credential: cert({ projectId: 'demo-natcut', clientEmail: 'survey@demo-natcut.iam.gserviceaccount.com', privateKey }),
  }, 'survey-repository-test');
  const firestore = getFirestore(admin);
  const repository = createSurveyRepository(firestore);

  const input = (ownerUid: string, submissionId: string, change: Partial<SurveyInput> = {}): SurveyInput => ({
    ownerUid,
    eventId,
    stickerSubmissionId: submissionId,
    cuteRating: 5,
    marketingEmail: null,
    submittedAt: '2026-11-27T01:00:00.000Z',
    ...change,
  });

  async function seedSubmission(id: string, ownerUid: string, publicStatus = 'collected') {
    const { artifact, ...legacy } = submissionInput(id);
    await firestore.doc(`submissions/${id}`).set({
      ...legacy, id, eventId, ownerUid, publicStatus, queueNumber: 1, jobsAhead: 0,
      updatedAt: legacy.acceptedAt, cancelledAt: null,
    });
  }

  beforeAll(async () => {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-natcut/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('stores an opt-out rating with null email and creates no marketing lead', async () => {
    await seedSubmission('collected-opt-out', 'visitor-opt-out');
    const result = await repository.submit(input('visitor-opt-out', 'collected-opt-out'));

    expect(result.created).toBe(true);
    expect(result.survey).toEqual({
      email: null,
      eventId,
      stickerSubmissionId: 'collected-opt-out',
      cuteRating: 5,
      selfieStoragePath: null,
      submittedAt: '2026-11-27T01:00:00.000Z',
    });
    expect((await firestore.collection('marketingLeads').get()).empty).toBe(true);
  });

  it('returns the immutable first survey when a response is retried with changed fields', async () => {
    await seedSubmission('collected-retry', 'visitor-retry');
    const first = await repository.submit(input('visitor-retry', 'collected-retry', { cuteRating: 4 }));
    const retry = await repository.submit(input('visitor-retry', 'collected-retry', {
      cuteRating: 1,
      marketingEmail: 'later@example.com',
    }));

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.survey.cuteRating).toBe(4);
    expect(retry.survey.email).toBeNull();
    expect((await firestore.collection('marketingLeads').where('email', '==', 'later@example.com').get()).empty).toBe(true);

    await seedSubmission('foreign-after-survey', 'another-owner');
    await seedSubmission('queued-after-survey', 'visitor-retry', 'queued');
    await expect(repository.submit(input('visitor-retry', 'foreign-after-survey'))).rejects.toBeInstanceOf(SurveyUnavailableError);
    await expect(repository.submit(input('visitor-retry', 'queued-after-survey'))).rejects.toBeInstanceOf(SurveyUnavailableError);
  });

  it('reports owner-authenticated eligibility and restores an accepted receipt', async () => {
    await seedSubmission('collected-status', 'visitor-status');
    expect(await repository.status({ ownerUid: 'visitor-status', eventId, stickerSubmissionId: 'collected-status' })).toEqual({
      eligible: true,
      submitted: false,
    });
    expect(await repository.status({ ownerUid: 'intruder', eventId, stickerSubmissionId: 'collected-status' })).toEqual({
      eligible: false,
      submitted: false,
    });
    await repository.submit(input('visitor-status', 'collected-status'));
    expect(await repository.status({ ownerUid: 'visitor-status', eventId, stickerSubmissionId: 'collected-status' })).toEqual({
      eligible: true,
      submitted: true,
    });
  });

  it('serializes concurrent tabs and creates only the winning marketing lead', async () => {
    await seedSubmission('collected-race', 'visitor-race');
    const results = await Promise.all([
      repository.submit(input('visitor-race', 'collected-race', { cuteRating: 2, marketingEmail: 'first@example.com' })),
      repository.submit(input('visitor-race', 'collected-race', { cuteRating: 5, marketingEmail: 'second@example.com' })),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]!.survey).toEqual(results[1]!.survey);
    const leads = await firestore.collection('marketingLeads').where('eventId', '==', eventId).get();
    const raceLeads = leads.docs.map((doc) => doc.data()).filter((lead) => lead.optionalSubmissionId === results[0]!.surveyId);
    expect(raceLeads).toHaveLength(1);
    expect(raceLeads[0]!.email).toBe(results[0]!.survey.email);
  }, 20_000);

  it('normalizes email and keeps the first onboarding record for a repeated address', async () => {
    await seedSubmission('collected-email-1', 'visitor-email-1');
    await seedSubmission('collected-email-2', 'visitor-email-2');
    const first = await repository.submit(input('visitor-email-1', 'collected-email-1', {
      marketingEmail: ' Person@Example.COM ',
    }));
    await repository.submit(input('visitor-email-2', 'collected-email-2', {
      marketingEmail: 'person@example.com',
      submittedAt: '2026-11-27T02:00:00.000Z',
    }));

    const lead = (await firestore.collection('marketingLeads').where('email', '==', 'person@example.com').get()).docs[0]!.data();
    expect(lead).toEqual({
      email: 'person@example.com',
      eventId,
      onboardedAt: '2026-11-27T01:00:00.000Z',
      optionalSubmissionId: first.surveyId,
    });
  });

  it.each([
    ['another visitor', 'collected-owned', 'owner', 'intruder', 'collected'],
    ['an uncollected ticket', 'queued-owned', 'owner-queued', 'owner-queued', 'queued'],
  ])('rejects %s without creating a survey', async (_case, submissionId, submissionOwner, caller, publicStatus) => {
    await seedSubmission(submissionId, submissionOwner, publicStatus);
    await expect(repository.submit(input(caller, submissionId))).rejects.toBeInstanceOf(SurveyUnavailableError);
  });
});
