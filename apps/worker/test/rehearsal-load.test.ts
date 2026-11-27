import { LocalArtifactStore } from '@natcut/artifacts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createFirestoreCloudQueue, JobStore, runWorkerOnce, SimulatedPrinter } from '../src/index.ts';
import { createOperatorQueue } from '../src/operator-queue.ts';
import type { PhysicalExecutor, PhaseTransition } from '../src/simulated-printer.ts';
import type { LocalPrintJob } from '../src/job-store.ts';
import { operatorEmulator } from './fixtures/operator-emulator.ts';
import { bundle, submission } from './fixtures/submission.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'serially completes and collects 30 fenced tickets across the operator pagination boundary',
  async () => {
    const firestore = operatorEmulator();
    const eventId = `rehearsal-${randomUUID()}`;
    const workerId = 'rehearsal-mac';
    const directory = await mkdtemp(path.join(tmpdir(), 'natcut-rehearsal-load-'));
    const artifacts = new LocalArtifactStore(path.join(directory, 'artifacts'));
    const store = new JobStore(path.join(directory, 'worker.sqlite'));
    let clock = Date.parse('2026-11-28T00:00:00.000Z');
    const now = () => new Date(clock++).toISOString();
    let activeExecutors = 0;
    let peakExecutors = 0;
    const executionOrder: string[] = [];
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const simulator = new SimulatedPrinter({ delayMs: 0, now });
    const executor: PhysicalExecutor = {
      async execute(job: LocalPrintJob, transition: PhaseTransition) {
        activeExecutors += 1;
        peakExecutors = Math.max(peakExecutors, activeExecutors);
        executionOrder.push(job.submissionId);
        try {
          if (executionOrder.length === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          }
          await simulator.execute(job, transition);
        } finally {
          activeExecutors -= 1;
        }
      },
    };

    try {
      const receipt = await artifacts.publish(bundle);
      const tickets = Array.from({ length: 30 }, (_, index) => ({
        ...submission(`${eventId}-${index + 1}`, index + 1),
        eventId,
        artifact: structuredClone(receipt),
      }));
      await Promise.all(tickets.map((ticket) => firestore.doc(`submissions/${ticket.id}`).set(ticket)));

      const operator = createOperatorQueue(firestore, eventId, store);
      const firstPage = await operator.list({ queued: 0, ready: 0 });
      expect(firstPage.rows.filter((row) => row.publicStatus === 'queued').map((row) => row.queueNumber))
        .toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
      expect(firstPage.next).toEqual({ queued: 25, ready: null });
      const secondPage = await operator.list({ queued: firstPage.next.queued ?? 0, ready: 0 });
      expect(secondPage.rows.filter((row) => row.publicStatus === 'queued').map((row) => row.queueNumber))
        .toEqual([26, 27, 28, 29, 30]);
      expect(secondPage.next).toEqual({ queued: null, ready: null });

      const cloud = createFirestoreCloudQueue(firestore, now, eventId);
      const slot = firestore.doc(`workerSlots/${eventId}`);
      for (const [index, ticket] of tickets.entries()) {
        expect((await slot.get()).exists).toBe(false);
        expect((await firestore.doc(`submissions/${ticket.id}`).get()).get('publicStatus')).toBe('queued');
        const follower = tickets[index + 1];
        if (follower) {
          expect((await firestore.doc(`submissions/${follower.id}`).get()).get('publicStatus')).toBe('queued');
        }

        const run = runWorkerOnce({ workerId, cloud, store, executor, artifactReader: artifacts, now });
        if (index === 0) {
          if (!follower) throw new Error('The concurrency probe requires a follower');
          await firstEntered.promise;
          expect(executionOrder).toEqual([ticket.id]);
          expect((await firestore.doc(`submissions/${follower.id}`).get()).get('publicStatus')).toBe('queued');
          expect(await runWorkerOnce({ workerId, cloud, store, executor, artifactReader: artifacts, now }))
            .toEqual({ kind: 'busy', submissionId: ticket.id });
          expect(executionOrder).toEqual([ticket.id]);
          expect(peakExecutors).toBe(1);
          releaseFirst.resolve();
        }
        expect(await run).toEqual({ kind: 'completed', submissionId: ticket.id });

        const completed = await firestore.doc(`submissions/${ticket.id}`).get();
        const executionLease: unknown = completed.get('executionLease');
        if (!isRecord(executionLease) || !isRecord(executionLease.evidence) ||
            typeof executionLease.token !== 'string') {
          throw new Error(`Ticket ${ticket.id} is missing its exact execution lease`);
        }
        const executionToken = store.getExecutionToken(ticket.id);
        if (!executionToken) throw new Error(`Ticket ${ticket.id} is missing its durable execution token`);
        expect(executionLease).toMatchObject({
          workerId,
          token: executionToken,
          evidence: { receipt: ticket.artifact, manifestHash: ticket.manifestHash, validation: ticket.validation },
        });
        expect(completed.get('publicStatus')).toBe('ready');
        expect(completed.get('completionFence')).toEqual({
          submissionId: ticket.id,
          eventId,
          workerId,
          executionToken,
          receipt: ticket.artifact,
          manifestHash: ticket.manifestHash,
          validation: ticket.validation,
          completedAt: completed.get('updatedAt'),
        });
        expect((await slot.get()).exists).toBe(false);
        if (follower) {
          expect((await firestore.doc(`submissions/${follower.id}`).get()).get('publicStatus')).toBe('queued');
        }
        expect(store.listPendingPublicStatuses()).toEqual([]);
        expect(store.listBlockingSubmissionIds()).toEqual([]);

        expect(await operator.collect(ticket.id)).toBe('collected');
        expect((await firestore.doc(`submissions/${ticket.id}`).get()).get('publicStatus')).toBe('collected');
      }

      expect(executionOrder).toEqual(tickets.map((ticket) => ticket.id));
      expect(peakExecutors).toBe(1);
      expect(activeExecutors).toBe(0);
      expect(store.listPendingPublicStatuses()).toEqual([]);
      expect(store.listBlockingSubmissionIds()).toEqual([]);
      expect(store.listStates()).toEqual(tickets.map((ticket) => ({ submissionId: ticket.id, state: 'ready' })));
      expect((await operator.list({ queued: 0, ready: 0 })).rows).toEqual([]);
      const final = await Promise.all(tickets.map((ticket) => firestore.doc(`submissions/${ticket.id}`).get()));
      expect(final.map((snapshot) => snapshot.get('publicStatus'))).toEqual(Array(30).fill('collected'));
    } finally {
      store.close();
      await firestore.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
