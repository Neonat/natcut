// Separate simulator process so the recovery drill can interrupt only the worker.
import type { AddressInfo } from 'node:net';
import { JobStore } from '../../src/job-store.ts';
import { startSimulatorDesk } from '../../src/simulator-desk.ts';
import { operatorEmulator } from './operator-emulator.ts';

const [journal, eventId] = process.argv.slice(2);
if (!journal || !eventId || !process.send) throw Error('Start this worker from the recovery drill.');
const control = await startSimulatorDesk({
  firestore: operatorEmulator(), store: new JobStore(journal), eventId, port: 0, delayMs: 400,
});
process.send((control.address() as AddressInfo).port);
