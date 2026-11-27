import { generateKeyPairSync } from 'node:crypto';
import { cert, getApps as getAdminApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, setDoc } from 'firebase/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { IdempotencyConflictError, RequeueForbiddenError, createSubmissionRepository, createSurveyRepository } from '../src/index.ts';
import { artifact, submissionInput as input } from './fixtures/artifact.ts';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const emulatorDescribe = emulatorEnabled ? describe : describe.skip;
const projectId = 'demo-natcut';

emulatorDescribe('Firebase emulator integration', () => {
  function database() {
    const existing = getAdminApps().find((app) => app.name === 'submission-integration');
    if (existing) return getAdminFirestore(existing);
    const privateKey = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    return getAdminFirestore(initializeAdminApp({
      projectId, credential: cert({ projectId, clientEmail: 'emulator@demo-natcut.iam.gserviceaccount.com', privateKey }),
    }, 'submission-integration'));
  }

  beforeAll(async () => {
    const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST!;
    await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
      method: 'DELETE',
    });
  });

  it('supports anonymous auth while denying direct visitor queue writes', async () => {
    const clientApp = initializeApp(
      { projectId, apiKey: 'demo-key', authDomain: 'demo-natcut.firebaseapp.com' },
      `client-${Date.now()}`,
    );
    const auth = getAuth(clientApp);
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST!}`, { disableWarnings: true });
    const credential = await signInAnonymously(auth);
    expect(credential.user.isAnonymous).toBe(true);

    const firestore = getFirestore(clientApp);
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
    connectFirestoreEmulator(firestore, host!, Number(port));
    await expect(setDoc(doc(firestore, 'submissions/forbidden'), { ownerUid: credential.user.uid })).rejects.toThrow();
    await deleteApp(clientApp);
  });

  it('allocates one queue record for concurrent idempotent creates and increments distinct work', async () => {
    const firestore = database();
    const repository = createSubmissionRepository(firestore);

    const [first, retry] = await Promise.all([
      repository.create(input('same-request')),
      repository.create(input('same-request')),
    ]);
    expect(first.submission.id).toBe(retry.submission.id);
    expect(first.submission.queueNumber).toBe(1);
    expect(retry.submission.queueNumber).toBe(1);
    expect([first.created, retry.created].sort()).toEqual([false, true]);
    expect((await firestore.doc('submissions/' + first.submission.id).get()).data()).toMatchObject({ recordVersion: 2, artifact });
    expect(await repository.findAccepted(input('same-request'))).toEqual(first.submission);
    await expect(repository.findAccepted({ ...input('same-request'), manifestHash: '0'.repeat(64) })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(repository.create({ ...input('same-request'), requeuedFrom: 'different' })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const second = await repository.create(input('different-request'));
    expect(second.submission.queueNumber).toBe(2);
    await firestore.doc(`submissions/${first.submission.id}`).update({ publicStatus: 'ready' });
    expect((await repository.getPublicStatus(second.submission.id, 'c'.repeat(64)))?.jobsAhead).toBe(0);
  }, 20_000);

  it('counts queued tickets with future or malformed receipts without decoding unrelated artifacts', async () => {
    const firestore = database();
    const repository = createSubmissionRepository(firestore);
    const ticket = (key: string) => ({ ...input(key), eventId: 'queue-count' });
    const first = (await repository.create(ticket('future'))).submission;
    const second = (await repository.create(ticket('malformed'))).submission;
    await firestore.doc('submissions/' + first.id).update({ recordVersion: 9 });
    await firestore.doc('submissions/' + second.id).update({ artifact: { generation: 'invalid' } });
    const third = (await repository.create(ticket('new'))).submission;
    expect(third.jobsAhead).toBe(2);
    expect((await repository.getPublicStatus(third.id, third.publicStatusTokenHash))?.jobsAhead).toBe(2);
    await expect(repository.getPublicStatus(first.id, first.publicStatusTokenHash)).rejects.toThrow();
    await expect(repository.getPublicStatus(second.id, second.publicStatusTokenHash)).rejects.toThrow();
  });

  it('retains legacy retry, status, leave and survey access, and requires the same event for requeue', async () => {
    const firestore = database();
    const repository = createSubmissionRepository(firestore);
    const request = { ...input('legacy-key'), eventId: 'legacy-event' };
    const { submission } = await repository.create(request);
    const { recordVersion, artifact: receipt, ...legacy } = submission;
    const ref = firestore.doc('submissions/' + submission.id);
    await ref.set({ ...legacy, workerLease: { workerId: 'old-worker' } });
    expect(await repository.findAccepted(request)).toEqual(legacy);
    expect(await repository.getPublicStatus(legacy.id, request.publicStatusTokenHash)).toEqual(legacy);
    expect(await repository.leave(legacy.id, request.publicStatusTokenHash, request.acceptedAt)).toBe('cancelled');
    const requeue = { ...request, idempotencyKey: 'requeue', requeuedFrom: legacy.id };
    await expect(repository.findAccepted({ ...requeue, eventId: 'foreign-event' })).rejects.toBeInstanceOf(RequeueForbiddenError);
    expect(await repository.findAccepted(requeue)).toBeNull();
    await ref.update({ publicStatus: 'queued' });
    await expect(repository.create(requeue)).rejects.toBeInstanceOf(RequeueForbiddenError);
    await ref.update({ publicStatus: 'cancelled' });
    await expect(repository.create({ ...requeue, eventId: 'foreign-event' })).rejects.toBeInstanceOf(RequeueForbiddenError);
    expect((await firestore.doc('queueCounters/foreign-event').get()).exists).toBe(false);
    expect((await repository.create(requeue)).submission.queueNumber).toBe(2);
    await ref.update({ publicStatus: 'collected' });
    const survey = createSurveyRepository(firestore);
    const surveyInput = { ...request, stickerSubmissionId: legacy.id, cuteRating: 5 as const, marketingEmail: null, submittedAt: request.acceptedAt };
    expect(await survey.status(surveyInput)).toEqual({ eligible: true, submitted: false });
    expect((await survey.submit(surveyInput)).created).toBe(true);

    await ref.update({ recordVersion: 9 });
    await expect(repository.findAccepted(request)).rejects.toThrow();
    expect((await survey.status(surveyInput)).eligible).toBe(false);
    await expect(survey.submit(surveyInput)).rejects.toThrow();
  }, 20_000);
});
