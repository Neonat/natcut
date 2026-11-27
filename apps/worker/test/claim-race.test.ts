import { generateKeyPairSync } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { submission, verifiedClaim } from './fixtures/submission.ts';
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

    const verified = await verifiedClaim(winners[0]!);
    const evidence = { receipt: verified.artifact.receipt, manifestHash: verified.submission.manifestHash,
      validation: verified.submission.validation };
    const head = firestore.doc('submissions/submission-race');
    await head.update({ 'artifact.generation': '2' });
    expect(await cloud.beginExecution(verified.submission.id, verified.workerId, 'changed-generation',
      '2026-11-23T12:00:02.000Z', evidence)).toBe('fenced');
    expect((await head.get()).get('publicStatus')).toBe('next');
    await head.update({ 'artifact.generation': evidence.receipt.generation });

    await head.update({ executionLease: { workerId: winners[0]!.workerId, token: 'old-token', startedAt: '2026-11-23T11:59:00.000Z' } });
    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-a',
      '2026-11-23T12:00:02.000Z',
      evidence,
    )).toBe('fenced');
    await head.update({ executionLease: FieldValue.delete() });
    await head.update({ completionFence: { submissionId: winners[0]!.submission.id } });
    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-a',
      '2026-11-23T12:00:02.000Z',
      evidence,
    )).toBe('fenced');
    await head.update({ completionFence: FieldValue.delete() });

    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-a',
      '2026-11-23T12:00:02.000Z',
      evidence,
    )).toBe('acquired');
    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-b',
      '2026-11-23T12:00:03.000Z',
      evidence,
    )).toBe('fenced');
    expect(await cloud.beginExecution(
      winners[0]!.submission.id,
      winners[0]!.workerId,
      'journal-a',
      '2026-11-23T12:00:04.000Z',
      evidence,
    )).toBe('fenced');
    expect((await cloud.recoverClaim(winners[0]!.workerId))?.executionToken).toBe('journal-a');

    const store = new JobStore(':memory:');
    store.insertClaimed(verified);
    expect(() => store.insertClaimed(verified)).toThrow(/unique/i);
    expect(store.list()).toHaveLength(1);
    store.close();

    const completion = {
      submissionId: winners[0]!.submission.id,
      eventId: winners[0]!.submission.eventId,
      workerId: winners[0]!.workerId,
      executionToken: 'journal-a',
      ...evidence,
    };
    const slot = firestore.doc('workerSlots/devfest-sg');
    await head.update({ 'artifact.generation': '2' });
    expect(await cloud.completeExecution(completion, '2026-11-23T12:00:05.000Z')).toBe('fenced');
    expect(await cloud.completeExecution({
      ...completion,
      receipt: { ...completion.receipt, generation: '2' },
    }, '2026-11-23T12:00:05.000Z')).toBe('fenced');
    expect((await head.get()).get('publicStatus')).toBe('printing');
    expect((await slot.get()).exists).toBe(true);
    await head.update({ 'artifact.generation': evidence.receipt.generation });
    expect(await cloud.completeExecution({ ...completion, workerId: 'stale-worker' }, '2026-11-23T12:00:05.000Z')).toBe('fenced');
    expect(await cloud.completeExecution({ ...completion, executionToken: 'stale-token' }, '2026-11-23T12:00:05.000Z')).toBe('fenced');
    expect(await cloud.completeExecution(completion, 'not-an-iso-timestamp')).toBe('fenced');
    expect((await slot.get()).exists).toBe(true);

    expect(await cloud.completeExecution(completion, '2026-11-23T12:00:05.000Z')).toBe('committed');
    const completed = await head.get();
    expect(completed.get('publicStatus')).toBe('ready');
    expect(completed.get('completionFence')).toEqual({ ...completion, completedAt: '2026-11-23T12:00:05.000Z' });
    expect((await slot.get()).exists).toBe(false);
    expect(await cloud.completeExecution(completion, '2026-11-23T12:00:06.000Z')).toBe('confirmed');

    await slot.set({ workerId: 'malformed-worker' });
    expect(await cloud.completeExecution(completion, '2026-11-23T12:00:06.000Z')).toBe('fenced');
    expect((await slot.get()).data()).toEqual({ workerId: 'malformed-worker' });
    await slot.set({ submissionId: 'different-ticket' });
    expect(await cloud.completeExecution(completion, '2026-11-23T12:00:06.000Z')).toBe('fenced');
    expect((await slot.get()).data()).toEqual({ submissionId: 'different-ticket' });
    await slot.delete();

    await head.update({ publicStatus: 'collected', updatedAt: '2026-11-23T12:00:07.000Z' });
    expect(await cloud.completeExecution(completion, '2026-11-23T12:00:08.000Z')).toBe('confirmed');
    expect(await cloud.completeExecution({
      ...completion,
      receipt: { ...completion.receipt, generation: '2' },
    }, '2026-11-23T12:00:08.000Z')).toBe('fenced');
    expect((await head.get()).get('publicStatus')).toBe('collected');
  }, 20_000);

  it('smoke claims and recovery stop when the queue head is not the expected ticket', async () => {
    const eventId = 'smoke-scope';
    await firestore.doc('submissions/smoke-unexpected').set({
      ...submission('smoke-unexpected', 1), eventId,
    });
    await firestore.doc('submissions/smoke-expected').set({
      ...submission('smoke-expected', 2), eventId,
    });
    const cloud = createFirestoreCloudQueue(firestore, () => '2026-11-28T00:00:00.000Z', eventId);

    await expect(cloud.claimNextSubmission('smoke-worker', 'smoke-expected')).rejects.toThrow(/expected.*smoke-expected/i);
    expect((await firestore.doc(`workerSlots/${eventId}`).get()).exists).toBe(false);
    expect((await firestore.doc('submissions/smoke-unexpected').get()).get('publicStatus')).toBe('queued');
    expect((await firestore.doc('submissions/smoke-expected').get()).get('publicStatus')).toBe('queued');

    await firestore.doc('submissions/smoke-unexpected').update({ publicStatus: 'cancelled' });
    expect((await cloud.claimNextSubmission('smoke-worker', 'smoke-expected'))?.submission.id).toBe('smoke-expected');
    await expect(cloud.recoverClaim('smoke-worker', 'different-ticket')).rejects.toThrow(/expected.*different-ticket/i);
    expect((await firestore.doc(`workerSlots/${eventId}`).get()).get('submissionId')).toBe('smoke-expected');
  });
});
