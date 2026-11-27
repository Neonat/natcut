import { parentPort, workerData } from 'node:worker_threads';
import { buildPhysicalProof } from '../../packages/printer/src/physical-proof.ts';
import { SqliteTransportAttemptJournal } from '@natcut/printer/transport-attempt';
import { createBrowserPhysicalCoordinator } from '../../src/browser-physical-coordinator.mjs';
import { createPhysicalProofRuntime } from '../../src/physical-proof-runtime.mjs';

const { gate, journalPath, mode, preferredWinner } = workerData;
const barrier = new Int32Array(gate);
const proof = await buildPhysicalProof();
const approvalFingerprint = proof.summary.approvalFingerprint;
const approval = { approvalFingerprint, confirmation: 'SEND ONE SHEET' };
const hardware = [];
let reserved = false;

class CompetingJournal extends SqliteTransportAttemptJournal {
  reserve(evidence, hash) {
    Atomics.add(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    while (Atomics.load(barrier, 0) < 2) {
      if (Atomics.wait(barrier, 0, 1, 10_000) === 'timed-out') throw new Error('Missing race contender.');
    }
    if (preferredWinner && preferredWinner !== mode && Atomics.wait(barrier, 1, 0, 10_000) === 'timed-out') {
      throw new Error('Expected winner never reserved.');
    }
    reserved = super.reserve(evidence, hash);
    if (reserved) {
      Atomics.store(barrier, 1, 1);
      Atomics.notify(barrier, 1);
    }
    return reserved;
  }
}

const options = { journalPath, approvalFingerprint, createJournal: file => new CompetingJournal(file) };
try {
  let result;
  if (mode === 'browser') {
    const coordinator = createBrowserPhysicalCoordinator(options);
    result = coordinator.begin(approval, proof);
  } else {
    const runtime = createPhysicalProofRuntime({
      ...options,
      openSession() {
        hardware.push({ call: 'open', reserved });
        return { io: {}, close() {} };
      },
      createTransport() {
        hardware.push({ call: 'create', reserved });
        return {
          async declareCombo() {
            hardware.push({ call: 'declare', reserved });
            throw new Error('Synthetic declaration stop');
          },
        };
      },
    });
    result = await runtime.sendPhysicalProof(approval, proof);
  }
  parentPort.postMessage({ mode, reserved, hardware, result });
} catch (error) {
  parentPort.postMessage({ mode, reserved, hardware, code: error.code, message: error.message });
}
