import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { PublicStatus } from '@natcut/domain';
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/job-store.ts';
import { startSimulatorDesk } from '../src/simulator-desk.ts';
import { operatorEmulator } from './fixtures/operator-emulator.ts';
import { submission } from './fixtures/submission.ts';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulator)('operator desk with Firestore and its journal', () => {
  let firestore: Firestore;
  let store: JobStore;
  let server: Awaited<ReturnType<typeof startSimulatorDesk>>;
  let origin: string;
  let headers: Record<string, string>;
  let eventId: string;
  beforeAll(() => { firestore = operatorEmulator(); });
  beforeEach(async () => {
    eventId = randomUUID();
    store = new JobStore(':memory:');
    server = await startSimulatorDesk({ firestore, eventId, store, port: 0, delayMs: 0 });
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const { capability } = await (await fetch(origin + '/session')).json();
    headers = { 'x-natcut-control': capability, 'content-type': 'application/json' };
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
  });
  afterAll(async () => { await firestore.terminate(); });

  async function seed(queueNumber: number, publicStatus: PublicStatus, event = eventId) {
    const record = { ...submission(event + '-' + queueNumber, queueNumber), publicStatus, eventId: event };
    await firestore.collection('submissions').doc(record.id).set(record);
    return record;
  }
  const post = (path: string) => fetch(origin + path, { method: 'POST', headers });

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
    store.insertClaimed({ submission: held, workerId: 'dev-mac', claimedAt: held.updatedAt });
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
      notice: expect.stringMatching(/interrupted|reconciliation/i),
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
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('raw-data');
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

  it('holds a recovered claim when the cloud execution fence advanced before the local phase was saved', async () => {
    const ticket = await seed(1, 'next');
    store.insertClaimed({ submission: ticket, workerId: 'dev-mac', claimedAt: ticket.updatedAt });
    store.transition(ticket.id, 'ready_to_declare', ticket.updatedAt);
    const token = store.getOrCreateExecutionToken(ticket.id);
    await firestore.doc('submissions/' + ticket.id).update({
      publicStatus: 'printing', executionLease: { workerId: 'dev-mac', token, startedAt: ticket.updatedAt },
    });
    await firestore.doc('workerSlots/' + eventId).set({ submissionId: ticket.id, workerId: 'dev-mac', claimedAt: ticket.updatedAt });
    expect((await post('/claim')).status).toBe(409);
    expect(store.getBySubmissionId(ticket.id)?.state).toBe('needs_reconciliation');
    expect((await post('/start')).status).toBe(409);
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
