import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { operatorEmulator } from './fixtures/operator-emulator.ts';
import { submission } from './fixtures/submission.ts';

async function interrupt(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exit = once(worker, 'exit');
  worker.kill('SIGKILL');
  await exit;
}

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('recovers only a pre-execution claim after restarting the desk process with its original emulator and SQLite journal', async () => {
  const firestore = operatorEmulator();
  const directory = await mkdtemp(path.join(tmpdir(), 'natcut-desk-drill-'));
  const journal = path.join(directory, 'worker.sqlite');
  const eventId = randomUUID();
  const ticket = { ...submission(eventId + '-1', 1), eventId };
  const next = { ...submission(eventId + '-2', 2), eventId };
  let worker: ChildProcess | undefined;

  async function start() {
    worker = fork(new URL('./fixtures/desk-process.ts', import.meta.url), [journal, eventId], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const [port] = await Promise.race([
      once(worker, 'message'),
      once(worker, 'exit').then(() => { throw Error('Worker exited before opening its desk'); }),
    ]);
    const origin = 'http://127.0.0.1:' + port;
    const { capability } = await (await fetch(origin + '/session')).json();
    return {
      post: (route: string) => fetch(origin + route, {
        method: 'POST', headers: { 'x-natcut-control': capability, 'content-type': 'application/json' },
      }),
      rows: async () => (await (await fetch(origin + '/queue')).json()).rows,
    };
  }

  try {
    const ref = firestore.doc('submissions/' + ticket.id);
    await ref.set(ticket);
    await firestore.doc('submissions/' + next.id).set(next);
    const first = await start();
    expect((await first.post('/claim')).status).toBe(200);
    await interrupt(worker!);
    const second = await start();
    expect((await second.post('/claim')).status).toBe(200);
    expect((await second.rows())[0]).toMatchObject({ submissionId: ticket.id, localState: 'claimed' });
    expect((await second.post('/start')).status).toBe(202);
    const overlapping = await Promise.all([second.post('/start'), second.post('/claim')]);
    expect(overlapping.map((response) => response.status)).toEqual([409, 409]);
    await expect.poll(async () => (await second.rows())[0].localState, { interval: 30, timeout: 8000 })
      .toMatch(/^(declaring|uploading_cut|uploading_image|printing|cutting)$/);
    await interrupt(worker!);
    const original = (await ref.get()).data();
    expect(original?.publicStatus).toBe('printing');
    const recovered = await start();
    expect((await recovered.rows())[0]).toMatchObject({
      queueNumber: 1, publicStatus: 'printing', localState: 'needs_reconciliation', notice: expect.stringMatching(/hold/i),
    });
    expect((await recovered.post('/claim')).status).toBe(409);
    expect((await recovered.post('/start')).status).toBe(409);
    expect((await recovered.post('/collect/' + ticket.id)).status).toBe(409);
    expect((await ref.get()).data()).toEqual(original);
    expect((await firestore.doc('submissions/' + next.id).get()).data()?.publicStatus).toBe('queued');
    expect((await firestore.doc('workerSlots/' + eventId).get()).data()?.submissionId).toBe(ticket.id);
  } finally {
    if (worker) await interrupt(worker);
    await firestore.terminate();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
