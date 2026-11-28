import { createHash, generateKeyPairSync } from 'node:crypto';
import { cert, getApps as getAdminApps, initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, setDoc } from 'firebase/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { catalogManifest, loadRgbaAsset, normalizeSpritePng } from '@natcut/render';
import { NATIVE_SRGB_EVIDENCE } from '@natcut/domain';
import { IdempotencyConflictError, RequeueForbiddenError, createSubmissionRepository, createSurveyRepository } from '../src/index.ts';
import { createPlantFlowRepository, PlantFlowConflictError } from '../src/plant-flow-repository.ts';
import { createRuntimeSpriteRegistry, RuntimeSpriteIntegrityError, type RuntimeSpriteObjectStore } from '../src/runtime-sprite.ts';
import { createAcceptedRuntimeArtifactPreparer } from '../src/runtime-preparation.ts';
import { createTrustedArtifactPreparer } from '../src/validation.ts';
import { createTrustedCandidateRegistrar, createPlantFlowCoordinator } from '../src/plant-flow.ts';
import { sourcePhotoDigest, type PlantOutcome } from '../src/plant-job-contract.ts';
import { buildSubmissionServer } from '../src/routes.ts';
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

  it('reserves one plant intent and commits only the first local outcome across concurrent callers', async () => {
    const repository = createPlantFlowRepository(database());
    const key = { eventId: 'plant-event', visitorSessionId: 'plant-visitor', captureId: 'plant-capture' };
    const input = { ...key, requestFingerprint: 'a'.repeat(64),
      liveDeadlineAt: '2026-11-28T00:00:15.000Z', fallbackAssetId: 'sprite/approved' };
    const [first, retry] = await Promise.all([repository.reserve(input), repository.reserve(input)]);
    expect(first.generationIntentId).toBe(retry.generationIntentId);
    expect(first.liveDeadlineAt).toBe(retry.liveDeadlineAt);
    await expect(repository.reserve({ ...input, requestFingerprint: 'b'.repeat(64) })).rejects.toBeInstanceOf(PlantFlowConflictError);
    await repository.bind(key, first.generationIntentId, 'plant-job-1');
    await expect(repository.bind(key, first.generationIntentId, 'other-job')).rejects.toBeInstanceOf(PlantFlowConflictError);
    await repository.observe(key, first.generationIntentId, 'eligible');
    await repository.holdCandidate(key, first.generationIntentId, { candidateId: 'candidate-1',
      sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'image/png', objectGeneration: '1' },
    '2026-11-28T00:00:14.000Z');
    const fallback = { decisionId: 'decision-1', decidedAt: '2026-11-28T00:00:15.000Z',
      outcome: 'catalog_fallback_accepted' as const, catalogAssetId: input.fallbackAssetId,
      reason: 'operator_fallback' as const };
    const generated = { decisionId: 'decision-2', decidedAt: '2026-11-28T00:00:14.000Z',
      outcome: 'generated_accepted' as const, candidateId: 'candidate-1',
      natcutAssetId: 'sprite/generated', reason: 'candidate_ready_before_deadline' as const };
    const [winner, loser] = await Promise.all([
      repository.commit(key, first.generationIntentId, fallback),
      repository.commit(key, first.generationIntentId, generated),
    ]);
    expect(winner.accepted).toEqual(loser.accepted);
    expect((await repository.get(key))?.accepted).toEqual(winner.accepted);
    expect((await repository.commit(key, first.generationIntentId, generated)).accepted).toEqual(winner.accepted);
    expect((await repository.recordAck(key, first.generationIntentId, winner.accepted!.decisionId, 'confirmed')).sproutAck).toBe('confirmed');
    expect((await repository.recordAck(key, first.generationIntentId, winner.accepted!.decisionId, 'needs_reconciliation')).sproutAck).toBe('confirmed');
    await expect(repository.recordAck(key, first.generationIntentId, 'wrong-decision', 'confirmed')).rejects.toBeInstanceOf(PlantFlowConflictError);
  }, 20_000);

  it('keeps a staged generated sprite out of print preparation until its exact acceptance and pinned generation', async () => {
    const firestore = database();
    const flows = createPlantFlowRepository(firestore);
    const key = { eventId: 'runtime-event', visitorSessionId: 'runtime-visitor', captureId: 'runtime-capture' };
    const flow = await flows.reserve({ ...key, requestFingerprint: 'a'.repeat(64),
      liveDeadlineAt: '2099-01-01T00:00:00.000Z', fallbackAssetId: catalogManifest.spriteAssetId });
    await flows.bind(key, flow.generationIntentId, 'runtime-job');
    await flows.observe(key, flow.generationIntentId, 'eligible');
    await flows.holdCandidate(key, flow.generationIntentId, { candidateId: 'candidate-1',
      sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'image/png', objectGeneration: '9' },
    '2026-11-28T00:00:01.000Z');
    const source = await sharp(Buffer.from([119, 255, 0, 255]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).withIccProfile('srgb').png().toBuffer();
    const normalized = await normalizeSpritePng(source, 'runtime-candidate');
    let generation = '17';
    let stored = Buffer.from(normalized.png);
    const objects: RuntimeSpriteObjectStore = {
      async publishCreateOnly() { return { generation }; },
      async readExact(_path, requested) {
        if (requested !== generation) throw new RuntimeSpriteIntegrityError('Generation is missing.');
        return Buffer.from(stored);
      },
    };
    const registry = createRuntimeSpriteRegistry({ firestore, flows, objects });
    const staged = { flowKey: key, generationIntentId: flow.generationIntentId,
      plantJobId: 'runtime-job', candidateId: 'candidate-1', sourceObjectGeneration: '9',
      sourcePng: source, sourceSha256: createHash('sha256').update(source).digest('hex'), sourceByteLength: source.length,
      png: normalized.png, pngSha256: createHash('sha256').update(normalized.png).digest('hex'),
      colorEvidence: normalized.colorEvidence };
    await expect(registry.stage({ ...staged, colorEvidence: NATIVE_SRGB_EVIDENCE }))
      .rejects.toThrow(/color evidence differs/i);
    await expect(registry.stage({ ...staged, sourceSha256: '0'.repeat(64) }))
      .rejects.toThrow(/source candidate digest/i);
    const assetId = await registry.stage(staged);
    expect(await registry.stage(staged)).toBe(assetId);
    const runtimeManifest = { ...catalogManifest, spriteAssetId: assetId, renderVersion: 'runtime-catalog-v1' };
    await expect(registry.loadAccepted(key, assetId)).rejects.toThrow(/no matching confirmed/i);
    await expect(createAcceptedRuntimeArtifactPreparer(registry)(key, runtimeManifest)).rejects.toThrow(/no matching confirmed/i);
    await expect(createTrustedArtifactPreparer()(runtimeManifest)).rejects.toThrow(/unsupported render version/i);
    const decision = { decisionId: 'runtime-decision', decidedAt: '2026-11-28T00:00:01.000Z',
      outcome: 'generated_accepted' as const, candidateId: 'candidate-1', natcutAssetId: assetId,
      reason: 'candidate_ready_before_deadline' as const };
    await flows.commit(key, flow.generationIntentId, decision);
    await expect(registry.loadAccepted(key, assetId)).rejects.toThrow(/no matching confirmed/i);
    await flows.recordAck(key, flow.generationIntentId, decision.decisionId, 'confirmed');
    await expect(registry.loadAccepted({ ...key, captureId: 'different' }, assetId))
      .rejects.toThrow(/no matching confirmed/i);
    expect(await registry.stage(staged)).toBe(assetId);
    await expect(registry.stage({ ...staged, candidateId: 'other-candidate' }))
      .rejects.toThrow(/different candidate/i);
    const loaded = await registry.loadAccepted(key, assetId);
    expect(loaded.colorEvidence).toEqual(normalized.colorEvidence);
    const prepared = await createAcceptedRuntimeArtifactPreparer(registry)(key, runtimeManifest);
    expect(prepared.bundle.descriptor.formatVersion).toBe(2);
    if (prepared.bundle.descriptor.formatVersion !== 2) throw new Error('Expected a v2 receipt.');
    for (const sourceEvidence of normalized.colorEvidence.sources) {
      expect(prepared.bundle.descriptor.colorEvidence.sources).toContainEqual(sourceEvidence);
    }
    stored = Buffer.from(stored);
    stored[stored.length - 10] = stored[stored.length - 10]! ^ 1;
    await expect(registry.loadAccepted(key, assetId)).rejects.toThrow(/digest or length|Invalid PNG/i);
    generation = '18';
    await expect(registry.loadAccepted(key, assetId)).rejects.toThrow(/Generation is missing/i);
  }, 20_000);

  it('runs an authenticated plant capture through generated acceptance and one fenced queue submission', async () => {
    const firestore = database();
    const flows = createPlantFlowRepository(firestore);
    const objectsInMemory = new Map<string, Buffer>();
    let runtimeStorageUnavailable = false;
    const objects: RuntimeSpriteObjectStore = {
      async publishCreateOnly(path, bytes) {
        if (!objectsInMemory.has(path)) objectsInMemory.set(path, Buffer.from(bytes));
        return { generation: '31' };
      },
      async readExact(path, generation) {
        if (runtimeStorageUnavailable) throw new Error('Temporary runtime storage outage.');
        if (generation !== '31' || !objectsInMemory.has(path)) throw new Error('Pinned object unavailable.');
        return Buffer.from(objectsInMemory.get(path)!);
      },
    };
    const registry = createRuntimeSpriteRegistry({ firestore, flows, objects });
    const captureBytes = await sharp(Buffer.from([60, 120, 90]), {
      raw: { width: 1, height: 1, channels: 3 },
    }).withIccProfile('srgb').jpeg().toBuffer();
    const captureColor = (await loadRgbaAsset(captureBytes, 'capture')).colorEvidence;
    const candidateBytes = await sharp(Buffer.from([119, 255, 0, 255]), {
      raw: { width: 1, height: 1, channels: 4 },
    }).withIccProfile('srgb').png().toBuffer();
    const candidate = { candidateId: 'candidate-1', mediaType: 'image/png' as const,
      byteLength: candidateBytes.length, sha256: sourcePhotoDigest(candidateBytes), objectGeneration: '7' };
    const createCalls: string[] = [];
    const sprout = {
      async create(request: { generationIntentId: string }) {
        createCalls.push(request.generationIntentId);
        return { plantJobId: 'plant-job', generationIntentId: request.generationIntentId,
          state: 'received' as const, createdAt: new Date().toISOString(), liveDeadlineMs: 15_000 as const };
      },
      async status() { return { plantJobId: 'plant-job', generationIntentId: createCalls[0]!,
        state: 'candidate_ready' as const, createdAt: new Date().toISOString(), liveDeadlineMs: 15_000 as const,
        identificationThresholdBps: 7000 as const, candidate, lateResultStored: false }; },
      async candidate() { return candidateBytes; },
      async outcome(_jobId: string, decision: PlantOutcome) { return decision; },
    };
    const coordinator = createPlantFlowCoordinator({ repository: flows, sprout,
      registrar: createTrustedCandidateRegistrar(registry) });
    const captures = {
      async resolveConfirmed(ownerUid: string, _eventId: string, captureId: string) {
        return ownerUid === 'alice' && captureId === 'capture-1' ? {
          visitorSessionId: 'session-1', captureId, sanitizedImage: captureBytes,
          sanitizedImageSha256: sourcePhotoDigest(captureBytes),
          sourcePhotoReceipt: { mediaType: 'image/jpeg' as const, width: 1, height: 1, colorEvidence: captureColor },
        } : null;
      },
      async findOwned(ownerUid: string, _eventId: string, captureId: string) {
        return ownerUid === 'alice' && captureId === 'capture-1'
          ? { visitorSessionId: 'session-1', captureId } : null;
      },
    };
    const submissions = createSubmissionRepository(firestore);
    const server = buildSubmissionServer({ eventId: 'devfest-sg', statusTokenSecret: 'test-secret-at-least-32-bytes-long',
      repository: submissions, surveyRepository: createSurveyRepository(firestore),
      verifyBearerToken: async token => { if (token !== 'alice' && token !== 'bob') throw new Error('auth'); return { uid: token }; },
      prepareArtifact: createTrustedArtifactPreparer(),
      publisher: { publish: async bundle => ({ descriptor: bundle.descriptor, generation: '1' }) },
      plant: { captureSource: captures, coordinator, policyVersion: 'policy-v1',
        verifyRuntimeAcceptance: (key, manifest) => registry.assertAccepted(key, manifest.spriteAssetId),
        prepareRuntimeArtifact: createAcceptedRuntimeArtifactPreparer(registry) },
    });
    const post = (url: string, payload: object, token = 'alice') => server.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${token}` }, payload });
    try {
      expect((await post('/v1/plant-jobs', { captureId: 'capture-1', fallbackAssetId: catalogManifest.spriteAssetId,
        sanitizedImageBase64: 'browser-forged' })).statusCode).toBe(400);
      expect((await post('/v1/plant-jobs', { captureId: 'capture-1', fallbackAssetId: catalogManifest.spriteAssetId }, 'bob')).statusCode).toBe(404);
      expect((await post('/v1/plant-jobs', { captureId: 'capture-1', fallbackAssetId: catalogManifest.spriteAssetId })).json())
        .toMatchObject({ state: 'waiting' });
      expect(createCalls).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: '/v1/plant-jobs/capture-1',
        headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
      expect((await server.inject({ method: 'GET', url: '/v1/plant-jobs/capture-1',
        headers: { authorization: 'Bearer alice' } })).json()).toMatchObject({ state: 'candidate_available', candidateId: 'candidate-1' });
      const unaccepted = { ...catalogManifest, spriteAssetId: `sprite/runtime/${'0'.repeat(64)}`,
        renderVersion: 'runtime-catalog-v1' };
      expect((await post('/v1/plant-jobs/capture-1/submissions', {
        manifest: unaccepted, idempotencyKey: 'one' })).statusCode).toBe(409);
      const chosen = (await post('/v1/plant-jobs/capture-1/accept-generated', { candidateId: 'candidate-1' })).json();
      expect(chosen).toMatchObject({ state: 'accepted', sproutAck: 'pending',
        decision: { outcome: 'generated_accepted' } });
      const manifest = { ...catalogManifest, spriteAssetId: chosen.decision.natcutAssetId,
        renderVersion: 'runtime-catalog-v1' };
      expect((await post('/v1/plant-jobs/capture-1/submissions', { manifest, idempotencyKey: 'one' })).statusCode).toBe(409);
      expect((await post('/v1/plant-jobs/capture-1/sync-outcome', {})).json()).toMatchObject({ state: 'accepted', sproutAck: 'confirmed' });
      expect((await post('/v1/plant-jobs', { captureId: 'capture-1', fallbackAssetId: catalogManifest.spriteAssetId })).json())
        .toMatchObject({ state: 'accepted', sproutAck: 'confirmed' });
      expect(createCalls).toHaveLength(1);
      const first = await post('/v1/plant-jobs/capture-1/submissions', { manifest, idempotencyKey: 'one' });
      expect(first.statusCode).toBe(201);
      runtimeStorageUnavailable = true;
      const retry = await post('/v1/plant-jobs/capture-1/submissions', { manifest, idempotencyKey: 'one' });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().submissionId).toBe(first.json().submissionId);
      expect((await post('/v1/submissions', { manifest, idempotencyKey: 'one' })).statusCode).toBe(422);
      expect((await post('/v1/plant-jobs/capture-1/submissions', { manifest, idempotencyKey: 'one' }, 'bob')).statusCode).toBe(404);
      expect((await firestore.collection('submissions').where('ownerUid', '==', 'alice').get()).size).toBe(1);
    } finally { await server.close(); }
  }, 30_000);

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
