import { generateKeyPairSync } from 'node:crypto';
import { cert, getApps as getAdminApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, setDoc } from 'firebase/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSubmissionRepository, type CreateSubmissionInput } from '../src/index.ts';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const emulatorDescribe = emulatorEnabled ? describe : describe.skip;
const projectId = 'demo-natcut';

function input(idempotencyKey: string): CreateSubmissionInput {
  return {
    ownerUid: 'visitor-one',
    eventId: 'devfest-sg',
    idempotencyKey,
    manifest: {
      schemaVersion: 1,
      spriteAssetId: 'sprite/monstera-v1',
      trainerAssetId: null,
      theme: 'default',
      brandingVariant: 'logo',
      cutGroups: [
        { id: 'main', members: ['sprite'] },
        { id: 'brand', members: ['branding'] },
      ],
      cutMarginMm: 1.5,
      renderVersion: 'fixture-v1',
    },
    manifestHash: 'a'.repeat(64),
    printSpec: { profileId: 'devfest-sg-v1', profileVersion: 1, cutMarginMm: 1.5 },
    validation: {
      valid: true,
      severity: 'ok',
      issues: [],
      contourCount: 2,
      pointCount: 16,
      cutLengthMm: 120,
      minimumContourGapMm: 4,
      edgeClearanceMm: 5,
      geometryVersion: 'natcut-geometry-v1',
      rasterHash: 'b'.repeat(64),
      acknowledgedByVisitor: false,
      acknowledgedAt: null,
    },
    publicStatusTokenHash: 'c'.repeat(64),
    acceptedAt: '2026-11-23T12:00:00.000Z',
    requeuedFrom: null,
  };
}

emulatorDescribe('Firebase emulator integration', () => {
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
    const privateKey = String(
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    );
    const adminApp = getAdminApps()[0] ?? initializeAdminApp({
      projectId,
      credential: cert({ projectId, clientEmail: 'emulator@demo-natcut.iam.gserviceaccount.com', privateKey }),
    });
    const repository = createSubmissionRepository(getAdminFirestore(adminApp));

    const [first, retry] = await Promise.all([
      repository.create(input('same-request')),
      repository.create(input('same-request')),
    ]);
    expect(first.submission.id).toBe(retry.submission.id);
    expect(first.submission.queueNumber).toBe(1);
    expect(retry.submission.queueNumber).toBe(1);

    const second = await repository.create(input('different-request'));
    expect(second.submission.queueNumber).toBe(2);
  }, 20_000);
});
