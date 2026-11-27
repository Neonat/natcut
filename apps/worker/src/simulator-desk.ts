import { once } from 'node:events';
import type { Firestore } from 'firebase-admin/firestore';
import { createFirestoreCloudQueue } from './cloud-queue.ts';
import type { JobStore } from './job-store.ts';
import { createOperatorQueue } from './operator-queue.ts';
import { createOperatorServer } from './operator-server.ts';
import { SimulatedPrinter } from './simulated-printer.ts';
import { flushPublicStatusOutbox, recoverInterruptedJobs } from './worker.ts';

export async function startSimulatorDesk(options: {
  firestore: Firestore; store: JobStore; eventId: string; port?: number; delayMs?: number;
}) {
  const { firestore, store, eventId } = options;
  const cloud = createFirestoreCloudQueue(firestore, undefined, eventId);
  recoverInterruptedJobs(store, new Date().toISOString());
  await flushPublicStatusOutbox(store, cloud);
  const control = createOperatorServer({
    workerId: 'dev-mac', cloud, store, executor: new SimulatedPrinter({ delayMs: options.delayMs ?? 260 }),
  }, createOperatorQueue(firestore, eventId, store));
  control.listen(options.port ?? 8090, '127.0.0.1');
  await once(control, 'listening');
  return control;
}
