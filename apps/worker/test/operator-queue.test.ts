import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PublicStatus } from '@natcut/domain';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFirestoreCloudQueue, runWorkerOnce, SimulatedPrinter } from '../src/index.ts';
import { JobStore, type LocalJobState } from '../src/job-store.ts';
import { startSimulatorDesk } from '../src/simulator-desk.ts';
import { operatorEmulator } from './fixtures/operator-emulator.ts';
import { artifactReader, submission, verifiedClaim } from './fixtures/submission.ts';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulator)('operator desk with Firestore and its journal', () => {
  let firestore: Firestore;
  let store: JobStore;
  let server: Awaited<ReturnType<typeof startSimulatorDesk>>;
  let directory: string;
  let journal: string;
  let origin: string;
  let headers: Record<string, string>;
  let eventId: string;
  beforeAll(() => { firestore = operatorEmulator(); });
  beforeEach(async () => {
    eventId = randomUUID();
    directory = await mkdtemp(path.join(tmpdir(), 'natcut-operator-'));
    journal = path.join(directory, 'jobs.sqlite');
    store = new JobStore(journal);
    server = await startSimulatorDesk({ artifactReader, firestore, eventId, store, port: 0, delayMs: 0 });
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const { capability } = await (await fetch(origin + '/session')).json();
    headers = { 'x-natcut-control': capability, 'content-type': 'application/json' };
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => { await firestore.terminate(); });

  async function seed(queueNumber: number, publicStatus: PublicStatus, event = eventId) {
    const record = { ...submission(event + '-' + queueNumber, queueNumber), publicStatus, eventId: event };
    await firestore.collection('submissions').doc(record.id).set(record);
    return record;
  }
  const post = (path: string) => fetch(origin + path, { method: 'POST', headers });

  it.each(['ready', 'collected'])('clears only the local ready intent after a committed ready response was lost and the ticket is %s', async terminal => {
    const ticket = await seed(1, 'queued');
    const cloud = createFirestoreCloudQueue(firestore, undefined, eventId);
    const simulator = new SimulatedPrinter();
    const execute = vi.fn(simulator.execute.bind(simulator));
    const result = await runWorkerOnce({ workerId: 'dev-mac', store, artifactReader, executor: { execute }, cloud: {
      ...cloud,
      async completeExecution(...args) {
        await cloud.completeExecution(...args);
        throw Error('Lost committed response');
      },
    } });
    expect(result).toEqual({ kind: 'waiting_for_cloud', submissionId: ticket.id });
    expect(store.listPendingPublicStatuses()).toMatchObject([{ submissionId: ticket.id, status: 'ready' }]);
    const slot = firestore.doc('workerSlots/' + eventId);
    expect((await slot.get()).exists).toBe(false);
    if (terminal === 'collected') expect((await post('/collect/' + ticket.id)).status).toBe(200);
    const ref = firestore.doc('submissions/' + ticket.id);
    const before = await ref.get();
    expect(before.get('publicStatus')).toBe(terminal);
    const recoverable = await (await fetch(origin + '/queue')).json();
    expect(recoverable.completionRetrySubmissionId).toBe(ticket.id);
    expect(recoverable.rows.find((row: {submissionId: string}) => row.submissionId === ticket.id)).toMatchObject({
      completionRetry: true, onHold: false, publicStatus: 'acknowledgement_pending',
    });
    await seed(2, 'queued');
    expect((await cloud.claimNextSubmission('next-worker'))?.submission.queueNumber).toBe(2);
    const nextSlot = await slot.get();
    const localBefore = store.getBySubmissionId(ticket.id);
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    const reopened = new JobStore(journal);
    store = reopened;
    server = await startSimulatorDesk({ artifactReader, firestore, eventId, store: reopened, port: 0, delayMs: 0 });
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const session = await (await fetch(origin + '/session')).json();
    headers = { 'x-natcut-control': session.capability, 'content-type': 'application/json' };
    const retry = await post('/retry-completion/' + ticket.id);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ submissionId: ticket.id, completionAcknowledged: true });
    expect(reopened.listPendingPublicStatuses()).toEqual([]);
    expect(reopened.getBySubmissionId(ticket.id)).toMatchObject({
      state: 'ready', stateChangedAt: localBefore?.stateChangedAt, completionAcknowledgedAt: localBefore?.stateChangedAt,
    });
    expect((await ref.get()).updateTime).toEqual(before.updateTime);
    expect((await slot.get()).updateTime).toEqual(nextSlot.updateTime);
    expect((await slot.get()).get('workerId')).toBe('next-worker');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'string', 'duplicate'] as const)(
    'keeps a %s queue-number head visible and blocks its follower without claiming either ticket', async variant => {
      const ticket = await seed(1, 'queued');
      const follower = await seed(2, 'queued');
      const ref = firestore.doc('submissions/' + ticket.id);
      if (variant === 'missing') await ref.update({ queueNumber: FieldValue.delete() });
      if (variant === 'string') await ref.update({ queueNumber: '1' });
      if (variant === 'duplicate') await firestore.doc('submissions/' + follower.id).update({ queueNumber: 1 });

      const page = await (await fetch(origin + '/queue')).json();
      expect(page.rows.find((row: {submissionId: string}) => row.submissionId === ticket.id)).toMatchObject({
        submissionId: ticket.id, publicStatus: 'queued', onHold: true,
      });
      expect(page.rows.find((row: {submissionId: string}) => row.submissionId === follower.id)).toMatchObject({
        submissionId: follower.id, publicStatus: 'queued',
      });
      expect(page.completionRetrySubmissionId).toBeNull();
      expect((await post('/claim')).status).toBe(409);
      expect((await post('/start')).status).toBe(409);
      expect((await ref.get()).get('publicStatus')).toBe('queued');
      expect((await firestore.doc('submissions/' + follower.id).get()).get('publicStatus')).toBe('queued');
      expect((await firestore.doc('workerSlots/' + eventId).get()).exists).toBe(false);
    },
  );

  it('front-loads a duplicate beyond the ordinary page boundary so the hold cannot be paged past', async () => {
    const tickets = await Promise.all(Array.from({ length: 30 }, (_, index) => seed(index + 1, 'queued')));
    await firestore.doc('submissions/' + tickets[29]!.id).update({ queueNumber: 29 });

    const page = await (await fetch(origin + '/queue')).json();
    expect(page.rows.slice(0, 2).map((row: {submissionId: string}) => row.submissionId).sort()).toEqual(
      [tickets[28]!.id, tickets[29]!.id].sort(),
    );
    expect(page.rows.slice(0, 2).every((row: {onHold: boolean}) => row.onHold)).toBe(true);
    expect(page.next.queued).toBeNull();
    expect((await post('/claim')).status).toBe(409);
    expect((await firestore.doc('submissions/' + tickets[0]!.id).get()).get('publicStatus')).toBe('queued');
  });

  it('ignores a stale nonzero cursor when an earlier queued record becomes malformed', async () => {
    const tickets = await Promise.all(Array.from({ length: 30 }, (_, index) => seed(index + 1, 'queued')));
    const clean = await (await fetch(origin + '/queue')).json();
    expect(clean.next.queued).toBe(25);
    await firestore.doc('submissions/' + tickets[0]!.id).update({ queueNumber: FieldValue.delete() });

    const page = await (await fetch(origin + '/queue?queuedAfter=25&readyAfter=0')).json();
    expect(page.rows[0]).toMatchObject({
      submissionId: tickets[0]!.id, queueNumber: null, publicStatus: 'queued', onHold: true,
    });
    expect(page.next.queued).toBeNull();
  });

  it.each(['next', 'printing', 'foreign-event', 'still-slotted'] as const)(
    'refuses to acknowledge a pending ready intent against a %s cloud record', async variant => {
      const cloud = createFirestoreCloudQueue(firestore, undefined, eventId);
      const ticket = await seed(1, variant === 'next' || variant === 'printing' ? variant : 'ready',
        variant === 'foreign-event' ? 'other-' + eventId : eventId);
      if (variant === 'still-slotted') {
        await firestore.doc('workerSlots/' + eventId).set({ submissionId: ticket.id, workerId: 'another-worker', claimedAt: ticket.updatedAt });
      }
      store.stagePublicStatus(ticket.id, 'ready', ticket.updatedAt);
      const expected = store.listPendingPublicStatuses();
      expect(await runWorkerOnce({ workerId: 'dev-mac', store, cloud, artifactReader,
        executor: { execute: vi.fn() } })).toEqual({ kind: 'needs_reconciliation', submissionId: ticket.id });
      expect(store.listPendingPublicStatuses()).toEqual(expected);
    },
  );

  it('keeps journal-less completion intents on hold even when one cloud ticket is already ready', async () => {
    const complete = await seed(1, 'ready');
    const active = await seed(2, 'printing');
    const slot = firestore.doc('workerSlots/' + eventId);
    await slot.set({ submissionId: active.id, workerId: 'original', claimedAt: active.updatedAt });
    const before = await slot.get();
    store.stagePublicStatus(active.id, 'ready', active.updatedAt);
    store.stagePublicStatus(complete.id, 'ready', complete.updatedAt);
    const pendingBefore = store.listPendingPublicStatuses();
    const result = await runWorkerOnce({ workerId: 'replacement', store, cloud: createFirestoreCloudQueue(firestore, undefined, eventId),
      artifactReader, executor: { execute: vi.fn() } });
    expect(result.kind).toBe('needs_reconciliation');
    if (result.kind !== 'needs_reconciliation') throw Error('expected reconciliation hold');
    expect(pendingBefore.map((entry) => entry.submissionId)).toContain(result.submissionId);
    expect(store.listPendingPublicStatuses()).toMatchObject([
      { submissionId: active.id, status: 'ready' },
      { submissionId: complete.id, status: 'ready' },
    ]);
    const visible = await (await fetch(origin + '/queue')).json();
    expect(visible.rows.find((row: {submissionId: string}) => row.submissionId === complete.id)).toMatchObject({
      onHold: true, notice: expect.stringMatching(/reconciliation/i),
    });
    expect((await slot.get()).updateTime).toEqual(before.updateTime);
    expect((await firestore.doc('submissions/' + active.id).get()).get('publicStatus')).toBe('printing');
  });

  it('preserves a different worker’s slot and the following ticket when a migrated legacy ready intent is pending', async () => {
    const active = await seed(1, 'printing');
    const next = await seed(2, 'queued');
    const { artifact: _artifact, recordVersion: _version, ...legacy } = active;
    const ref = firestore.doc('submissions/' + active.id);
    const slot = firestore.doc('workerSlots/' + eventId);
    await ref.set({ ...legacy, workerLease: { workerId: 'original', claimedAt: active.updatedAt } });
    await slot.set({ submissionId: active.id, workerId: 'original', claimedAt: active.updatedAt });
    store.insertClaimed(await verifiedClaim({ submission: active, workerId: 'original', claimedAt: active.updatedAt }));
    const migrated = new Database(journal);
    migrated.prepare(`UPDATE local_print_jobs SET artifactReceiptJson=NULL, artifactBytes=NULL, artifactVerifiedAt=NULL,
      colorSha256=NULL, cutMaskSha256=NULL, bundleSha256=NULL WHERE submissionId=?`).run(active.id);
    migrated.close();
    store.transitionAndStagePublicStatus(active.id, 'ready', active.updatedAt, 'ready');
    const pending = store.listPendingPublicStatuses();
    const result = await runWorkerOnce({ workerId: 'replacement', store, cloud: createFirestoreCloudQueue(firestore, undefined, eventId),
      artifactReader, executor: { execute: async () => { throw Error('Unexpected simulator start'); } } });
    expect(result).toEqual({ kind: 'needs_reconciliation', submissionId: active.id });
    expect(store.listPendingPublicStatuses()).toEqual(pending);
    expect((await ref.get()).get('publicStatus')).toBe('printing');
    expect((await slot.get()).get('workerId')).toBe('original');
    expect((await firestore.doc('submissions/' + next.id).get()).get('publicStatus')).toBe('queued');
  });

  it.each(['unknown', 'legacy', 'mismatched-id', 'invalid-number'])('holds a %s head visibly across retries, leaving the next ticket queued', async variant => {
    const ticket = await seed(1, 'queued');
    const next = await seed(2, 'queued');
    const ticketRef = firestore.doc('submissions/' + ticket.id);
    if (variant === 'unknown') await ticketRef.update({ recordVersion: 41 });
    if (variant === 'invalid-number') await ticketRef.update({ queueNumber: 0 });
    if (variant === 'invalid-number') {
      const response = await fetch(origin + '/queue');
      expect(response.status).toBe(200);
      const initial = await response.json();
      expect(initial.rows[0]).toMatchObject({ submissionId: ticket.id, publicStatus: 'queued', queueNumber: null, onHold: true });
      expect(initial.rows[1]).toMatchObject({ submissionId: next.id, queueNumber: 2 });
    }
    if (variant === 'mismatched-id') await ticketRef.update({ id: next.id });
    if (variant === 'legacy') {
      const { artifact: _artifact, recordVersion: _version, ...legacy } = ticket;
      await ticketRef.set(legacy);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post('/claim');
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'JOB_NEEDS_RECONCILIATION', submissionId: ticket.id });
      expect((await post('/start')).status).toBe(409);
    }
    const page = await (await fetch(origin + '/queue')).json();
    if (variant === 'invalid-number') expect(page.rows[0].queueNumber).toBeNull();
    expect(page.rows[0]).toMatchObject({
      submissionId: ticket.id, publicStatus: variant === 'invalid-number' ? 'queued' : 'next',
      onHold: true, notice: expect.stringMatching(/hold/i),
    });
    expect(page.rows[1]).toMatchObject({ submissionId: next.id, publicStatus: 'queued' });
    if (variant === 'invalid-number') expect((await firestore.doc('workerSlots/' + eventId).get()).exists).toBe(false);
    else expect((await firestore.doc('workerSlots/' + eventId).get()).get('submissionId')).toBe(ticket.id);
    expect((await ticketRef.get()).get('executionLease')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('pages queued and ready tickets independently and keeps the held ticket visible in order', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => seed(i + 1, 'queued')));
    await Promise.all(Array.from({ length: 27 }, (_, i) => seed(40 + i, 'ready')));
    const held = await seed(31, 'printing');
    await firestore.doc('submissions/' + eventId + '-1').update({
      'validation.severity': 'warning',
      'validation.issues': [{ message: 'private warning content' }],
    });
    await seed(32, 'cancelled');
    await seed(33, 'collected');
    await seed(34, 'ready', 'other-' + eventId);
    store.insertClaimed(await verifiedClaim({ submission: held, workerId: 'dev-mac', claimedAt: held.updatedAt }));
    store.transition(held.id, 'needs_reconciliation', held.updatedAt, '/private/journal/details token=secret');
    const response = await fetch(origin + '/queue');
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.rows.map((row: {queueNumber: number}) => row.queueNumber)).toEqual([
      ...Array.from({ length: 25 }, (_, i) => i + 1), 31, ...Array.from({ length: 25 }, (_, i) => 40 + i),
    ]);
    expect(page.rows[0].notice).toMatch(/warning/i);
    expect(page.next).toEqual({ queued: 25, ready: 64 });
    const heldRow = page.rows.find((row: {queueNumber: number}) => row.queueNumber === 31);
    expect(heldRow).toEqual({
      submissionId: held.id, queueNumber: 31, publicStatus: 'printing', localState: 'needs_reconciliation',
      onHold: true, notice: expect.stringMatching(/interrupted|reconciliation/i), completionRetry: false,
    });
    expect(JSON.stringify(page)).not.toMatch(/ownerUid|idempotency|token|hash|private|lastError|jpegPath/i);
    const next = await (await fetch(origin + '/queue?queuedAfter=25&readyAfter=64')).json();
    expect(next.rows.map((row: {queueNumber: number}) => row.queueNumber)).toEqual([26,27,28,29,30,31,65,66]);
    expect(next.next).toEqual({ queued: null, ready: null });
    store.transition(held.id, 'failed', held.updatedAt, 'SENSITIVE');
    const failed = (await (await fetch(origin + '/queue')).json()).rows.find((row: {queueNumber: number}) => row.queueNumber === 31);
    expect(failed).toMatchObject({ localState: 'failed', notice: expect.stringMatching(/failed/i) });
    expect(JSON.stringify(failed)).not.toContain('SENSITIVE');
    expect((await fetch(origin + '/queue?queuedAfter=-1')).status).toBe(400);
  });

  it('keeps unexpected stored queue metadata out of the desk response', async () => {
    const ticket = await seed(1, 'ready');
    await firestore.doc('submissions/' + ticket.id).update({ queueNumber: { private: 'raw-data' } });
    const response = await fetch(origin + '/queue');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('raw-data');
  });

  it('keeps the initial queued page readable and withholds its cursor when a row has no usable number', async () => {
    const tickets = await Promise.all(Array.from({ length: 27 }, (_, i) => seed(i + 1, 'queued')));
    await firestore.doc('submissions/' + tickets[0]!.id).update({ queueNumber: 0 });
    const response = await fetch(origin + '/queue');
    const page = await response.json();
    expect(response.status).toBe(200);
    expect(page.rows).toHaveLength(25);
    expect(page.rows[0]).toMatchObject({ submissionId: tickets[0]!.id, queueNumber: null, onHold: true, notice: expect.stringMatching(/number unavailable/i) });
    expect(page.rows[1]).toMatchObject({ submissionId: tickets[1]!.id, queueNumber: 2, onHold: false });
    expect(page.next.queued).toBeNull();
  });

  it('prevents a stale desk tab from starting someone else’s claim', async () => {
    const next = await seed(2, 'queued');
    expect((await post('/claim')).status).toBe(200);
    const start = await fetch(origin + '/start', {
      method: 'POST', headers: { ...headers, 'x-natcut-submission': 'previous-ticket' },
    });
    expect(start.status).toBe(409);
    expect(store.getBySubmissionId(next.id)?.state).toBe('claimed');
  });

  it('holds an orphan Next record without a worker slot and leaves its queued follower untouched', async () => {
    const orphan = await seed(1, 'next');
    const follower = await seed(2, 'queued');

    const page = await (await fetch(origin + '/queue')).json();
    expect(page.rows.find((row: {submissionId: string}) => row.submissionId === orphan.id)).toMatchObject({
      publicStatus: 'next', onHold: true, notice: expect.stringMatching(/reconciliation|hold/i),
    });
    const claim = await post('/claim');
    expect(claim.status).toBe(409);
    expect(await claim.json()).toEqual({ error: 'JOB_NEEDS_RECONCILIATION', submissionId: orphan.id });
    expect((await post('/start')).status).toBe(409);
    expect((await firestore.doc('workerSlots/' + eventId).get()).exists).toBe(false);
    expect((await firestore.doc('submissions/' + orphan.id).get()).get('publicStatus')).toBe('next');
    expect((await firestore.doc('submissions/' + follower.id).get()).get('publicStatus')).toBe('queued');
  });

  it('collects a ready ticket once even with simultaneous tabs and leaves the active slot intact', async () => {
    const first = await seed(1, 'ready');
    const next = await seed(2, 'queued');
    expect((await post('/claim')).status).toBe(200);
    const slot = firestore.doc('workerSlots/' + eventId);
    const before = (await slot.get()).data();
    expect(before?.submissionId).toBe(next.id);
    const results = await Promise.all([post('/collect/' + first.id), post('/collect/' + first.id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const ref = firestore.doc('submissions/' + first.id);
    const picked = (await ref.get()).data();
    expect(picked?.publicStatus).toBe('collected');
    expect(picked?.updatedAt).not.toBe(first.updatedAt);
    expect((await post('/collect/' + first.id)).status).toBe(200);
    expect((await ref.get()).data()).toEqual(picked);
    expect((await slot.get()).data()).toEqual(before);
    expect(store.list().map((row) => row.submissionId)).toEqual([next.id]);
  });

  it('leaves a live executor busy while its committed execution fence response is pending', async () => {
    const ticket = await seed(1, 'queued');
    const committed = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    const cloud = createFirestoreCloudQueue(firestore, undefined, eventId);
    const owner = new JobStore(journal);
    const worker = runWorkerOnce({
      workerId: 'dev-mac', artifactReader, store: owner, executor: new SimulatedPrinter(),
      cloud: {
        ...cloud,
        async beginExecution(...args) {
          const result = await cloud.beginExecution(...args);
          committed.resolve();
          await acknowledge.promise;
          return result;
        },
      },
    });
    try {
      await committed.promise;
      const concurrent = await runWorkerOnce({ workerId: 'dev-mac', artifactReader, store, cloud, executor: new SimulatedPrinter() });
      expect(concurrent).toEqual({ kind: 'busy', submissionId: ticket.id });
      const claim = await post('/claim');
      expect(await claim.json()).toMatchObject({ error: 'SIMULATOR_BUSY' });
      const page = await (await fetch(origin + '/queue')).json();
      expect(page.rows[0]).toMatchObject({ publicStatus: 'printing', localState: 'ready_to_declare', onHold: false });
      expect(store.getBySubmissionId(ticket.id)?.state).toBe('ready_to_declare');
    } finally {
      acknowledge.resolve();
      await worker;
      owner.close();
    }
    expect(store.getBySubmissionId(ticket.id)?.state).toBe('ready');
  });

  it('serializes ready recovery behind a live executor on the same journal', async () => {
    const ticket = await seed(1, 'queued');
    const cloud = createFirestoreCloudQueue(firestore, undefined, eventId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = new JobStore(journal);
    const running = runWorkerOnce({
      workerId: 'dev-mac', artifactReader, store: owner, executor: new SimulatedPrinter(),
      cloud: {
        ...cloud,
        async completeExecution(...args) {
          entered.resolve();
          await release.promise;
          return cloud.completeExecution(...args);
        },
      },
    });
    try {
      await entered.promise;
      expect(store.getState(ticket.id)).toBe('ready');
      expect(await runWorkerOnce({
        workerId: 'stale-worker', artifactReader, store, cloud, executor: { execute: vi.fn() },
      })).toEqual({ kind: 'busy', submissionId: ticket.id });
      expect(store.getState(ticket.id)).toBe('ready');
      expect(store.listPendingPublicStatuses()).toHaveLength(1);
    } finally {
      release.resolve();
      await expect(running).resolves.toEqual({ kind: 'completed', submissionId: ticket.id });
      owner.close();
    }
    expect(store.getBySubmissionId(ticket.id)).toMatchObject({ state: 'ready', completionAcknowledgedAt: expect.any(String) });
    expect(store.listPendingPublicStatuses()).toEqual([]);
  });

  it('retries a pre-commit completion outage after restart without re-executing', async () => {
    const ticket = await seed(1, 'queued');
    const cloud = createFirestoreCloudQueue(firestore, undefined, eventId);
    const owner = new JobStore(journal);
    const execute = vi.fn(new SimulatedPrinter().execute.bind(new SimulatedPrinter()));
    try {
      expect(await runWorkerOnce({
        workerId: 'dev-mac', artifactReader, store: owner, executor: { execute },
        cloud: { ...cloud, completeExecution: vi.fn().mockRejectedValue(new Error('offline before commit')) },
      })).toEqual({ kind: 'waiting_for_cloud', submissionId: ticket.id });
      expect((await firestore.doc('submissions/' + ticket.id).get()).get('publicStatus')).toBe('printing');
      expect((await firestore.doc('workerSlots/' + eventId).get()).exists).toBe(true);
    } finally { owner.close(); }

    const reopened = new JobStore(journal);
    try {
      expect(await runWorkerOnce({
        workerId: 'dev-mac', artifactReader, store: reopened, executor: { execute }, cloud,
      })).toEqual({ kind: 'idle' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await firestore.doc('submissions/' + ticket.id).get()).get('publicStatus')).toBe('ready');
      expect((await firestore.doc('workerSlots/' + eventId).get()).exists).toBe(false);
      expect(reopened.listPendingPublicStatuses()).toEqual([]);
    } finally { reopened.close(); }
  });

  it('shows legacy, collected, and missing local blockers independently of cloud pagination', async () => {
    const collected = await seed(1, 'collected');
    const next = await seed(2, 'queued');
    store.stagePublicStatus(collected.id, 'printing', collected.updatedAt);
    store.stagePublicStatus('missing-local-intent', 'ready', collected.updatedAt);

    const initial = await (await fetch(origin + '/queue')).json();
    expect(initial.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ submissionId: collected.id, publicStatus: 'blocked', onHold: true, completionRetry: false }),
      expect.objectContaining({ submissionId: 'missing-local-intent', publicStatus: 'blocked', onHold: true }),
      expect.objectContaining({ submissionId: next.id, publicStatus: 'queued' }),
    ]));
    const claim = await post('/claim');
    expect(claim.status).toBe(409);
    expect(await claim.json()).toMatchObject({ error: 'JOB_NEEDS_RECONCILIATION', submissionId: collected.id });
    expect(store.hasArtifactHold(collected.id)).toBe(true);
    expect((await firestore.doc('submissions/' + next.id).get()).get('publicStatus')).toBe('queued');
  });

  it('never exposes legacy or mismatched completion intents as retryable acknowledgements', async () => {
    const ready = await seed(1, 'ready');
    store.stagePublicStatus(ready.id, 'ready', ready.updatedAt);
    store.stagePublicStatus('legacy-printing-intent', 'printing', ready.updatedAt);

    const page = await (await fetch(origin + '/queue')).json();
    expect(page.completionRetrySubmissionId).toBeNull();
    expect(page.rows.filter((row: {completionRetry: boolean}) => row.completionRetry)).toEqual([]);
    expect(page.rows.some((row: {onHold: boolean}) => row.onHold)).toBe(true);
    const pending = store.listPendingPublicStatuses();
    expect((await post('/retry-completion/' + ready.id)).status).toBe(409);
    expect(store.listPendingPublicStatuses()).toEqual(pending);
  });

  it('keeps a real ready journal with a legacy printing intent on reconciliation hold', async () => {
    const ready = await seed(1, 'ready');
    store.insertClaimed(await verifiedClaim({ submission: ready, workerId: 'dev-mac', claimedAt: ready.updatedAt }));
    store.transitionAndStagePublicStatus(ready.id, 'ready', ready.updatedAt, 'printing');

    const page = await (await fetch(origin + '/queue')).json();
    expect(page.completionRetrySubmissionId).toBeNull();
    expect(page.rows.find((row: {submissionId: string}) => row.submissionId === ready.id)).toMatchObject({
      localState: 'ready', completionRetry: false, onHold: true,
      notice: expect.stringMatching(/reconciliation/i),
    });
  });

  it('does not expose a ready intent whose trusted journal artifact can no longer be verified', async () => {
    const ready = await seed(1, 'ready');
    store.insertClaimed(await verifiedClaim({ submission: ready, workerId: 'dev-mac', claimedAt: ready.updatedAt }));
    store.getOrCreateExecutionToken(ready.id);
    store.transitionAndStagePublicStatus(ready.id, 'ready', ready.updatedAt, 'ready');
    const database = new Database(journal);
    database.prepare('UPDATE local_print_jobs SET artifactBytes = NULL WHERE submissionId = ?').run(ready.id);
    database.close();

    const page = await (await fetch(origin + '/queue')).json();
    expect(page.completionRetrySubmissionId).toBeNull();
    expect(page.rows.find((row: {submissionId: string}) => row.submissionId === ready.id)).toMatchObject({
      completionRetry: false, onHold: true,
    });
  });

  it('holds a recovered claim when the cloud execution fence advanced before the local phase was saved', async () => {
    const ticket = await seed(1, 'next');
    store.insertClaimed(await verifiedClaim({ submission: ticket, workerId: 'dev-mac', claimedAt: ticket.updatedAt }));
    store.transition(ticket.id, 'ready_to_declare', ticket.updatedAt);
    const token = store.getOrCreateExecutionToken(ticket.id);
    await firestore.doc('submissions/' + ticket.id).update({
      publicStatus: 'printing', executionLease: { workerId: 'dev-mac', token, startedAt: ticket.updatedAt },
    });
    await firestore.doc('workerSlots/' + eventId).set({ submissionId: ticket.id, workerId: 'dev-mac', claimedAt: ticket.updatedAt });
    const snapshot = await (await fetch(origin + '/queue')).json();
    expect(snapshot.rows[0]).toMatchObject({
      localState: 'ready_to_declare', onHold: true, notice: expect.stringMatching(/reconciliation/i),
    });
    expect(store.getBySubmissionId(ticket.id)?.state).toBe('ready_to_declare');
    expect((await post('/claim')).status).toBe(409);
    expect(store.getBySubmissionId(ticket.id)?.state).toBe('needs_reconciliation');
    expect((await post('/start')).status).toBe(409);
  });

  it('classifies every execution phase in a stopped journal while preserving completed and failed outcomes', async () => {
    const ticket = await seed(1, 'printing');
    store.insertClaimed(await verifiedClaim({ submission: ticket, workerId: 'dev-mac', claimedAt: ticket.updatedAt }));
    const outcomes: Array<[LocalJobState, boolean, RegExp]> = [
      ['declaring', true, /reconciliation/i], ['uploading_cut', true, /reconciliation/i],
      ['uploading_image', true, /reconciliation/i], ['printing', true, /reconciliation/i],
      ['cutting', true, /reconciliation/i], ['ready', false, /publish/i], ['failed', true, /failed/i],
    ];
    for (const [state, onHold, reason] of outcomes) {
      store.transition(ticket.id, state, ticket.updatedAt);
      const page = await (await fetch(origin + '/queue')).json();
      expect(page.rows[0]).toMatchObject({
        localState: state, onHold, notice: expect.stringMatching(reason),
      });
    }
  });

  it('rejects pickup before readiness, missing tickets, and tickets from another event', async () => {
    const wrong = await seed(1, 'ready', eventId + '-another');
    expect((await post('/collect/' + wrong.id)).status).toBe(404);
    expect((await post('/collect/missing')).status).toBe(404);
    for (const [i, status] of (['queued', 'next', 'printing', 'cancelled'] as const).entries()) {
      const record = await seed(i + 1, status);
      expect((await post('/collect/' + record.id)).status).toBe(409);
      expect((await firestore.doc('submissions/' + record.id).get()).data()?.publicStatus).toEqual(status);
    }
    expect((await firestore.doc('submissions/' + wrong.id).get()).data()?.publicStatus).toBe('ready');
  });
});
