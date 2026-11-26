import { generateKeyPairSync } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { submission } from './fixtures/submission.ts';
import { JobStore, createFirestoreCloudQueue } from '../src/index.ts';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const emulatorDescribe = enabled ? describe : describe.skip;
const projectId = 'demo-natcut';

emulatorDescribe('cloud claim race', () => {
  let firestore: ReturnType<typeof getFirestore>;

  beforeAll(async () => {
    const host = process.env.FIRESTORE_EMULATOR_HOST!;
    await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
    const privateKey = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const app = getApps()[0] ?? initializeApp({
      projectId,
      credential: cert({ projectId, clientEmail: 'emulator@demo-natcut.iam.gserviceaccount.com', privateKey }),
    });
    firestore = getFirestore(app);
  });

  it('allows exactly one worker lease and one durable local row', async () => {
    await firestore.doc('submissions/submission-race').set(submission());
    await firestore.doc('submissions/submission-second').set(submission('submission-second', 2));
    const cloud = createFirestoreCloudQueue(firestore, () => '2026-11-23T12:00:01.000Z');
    const claims = await Promise.all([
      cloud.claimNextSubmission('mac-a'),
      cloud.claimNextSubmission('mac-b'),
    ]);
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const storedCloud = (await firestore.doc('submissions/submission-race').get()).data();
    expect(storedCloud?.workerLease).toEqual({ workerId: winners[0]!.workerId, claimedAt: '2026-11-23T12:00:01.000Z' });
    expect(storedCloud?.publicStatus).toBe('next');
    expect(await cloud.claimNextSubmission('mac-c')).toBeNull();
    expect((await firestore.doc('workerSlots/devfest-sg').get()).data()?.submissionId).toBe(winners[0]!.submission.id);
    expect((await cloud.recoverClaim(winners[0]!.workerId))?.submission.id).toBe(winners[0]!.submission.id);

    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-a',
      '2026-11-23T12:00:02.000Z',
    )).toBe('acquired');
    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-b',
      '2026-11-23T12:00:03.000Z',
    )).toBe('fenced');
    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-a',
      '2026-11-23T12:00:04.000Z',
    )).toBe('fenced');
    expect((await cloud.recoverClaim(winners[0]!.workerId))?.executionToken).toBe('journal-a');

    const store = new JobStore(':memory:');
    store.insertClaimed(winners[0]!);
    expect(() => store.insertClaimed(winners[0]!)).toThrow(/unique/i);
    expect(store.list()).toHaveLength(1);
    store.close();

    await cloud.updatePublicStatus(winners[0]!.submission.id, 'ready', '2026-11-23T12:00:05.000Z');
    await expect(cloud.updatePublicStatus(
      winners[0]!.submission.id,
      'printing',
      '2026-11-23T12:00:06.000Z',
    )).resolves.toBeUndefined();
  }, 20_000);
});
