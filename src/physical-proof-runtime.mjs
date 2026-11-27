import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildPhysicalProof, buildPhysicalProofFromPng } from '../packages/printer/src/physical-proof.ts';
import {
  runTransportAttempt,
  SqliteTransportAttemptJournal,
} from '../packages/printer/src/transport-attempt.ts';
import { createUsbTransportMutationPort } from './printer-mutation-port.mjs';

export function createPhysicalProofRuntime({
  approvalFingerprint,
  journalPath,
  openSession,
  proofImagePath,
  buildProof = buildPhysicalProof,
  readProofImage = readFile,
  buildPngProof = buildPhysicalProofFromPng,
  createJournal = (file) => new SqliteTransportAttemptJournal(file),
  createTransport = createUsbTransportMutationPort,
  runAttempt = runTransportAttempt,
}) {
  const physicalSendEnabled = typeof approvalFingerprint === 'string' && /^[a-f0-9]{64}$/.test(approvalFingerprint);
  const preparePhysicalProof = proofImagePath
    ? async () => buildPngProof(new Uint8Array(await readProofImage(proofImagePath)), { label: 'Moth orchid example' })
    : buildProof;

  return {
    physicalSendEnabled,
    preparePhysicalProof,
    async sendPhysicalProof(input, proof) {
      if (!physicalSendEnabled) throw new Error('The exact printer write still requires separate approval.');
      if (input?.approvalFingerprint !== approvalFingerprint ||
          proof?.summary?.approvalFingerprint !== approvalFingerprint ||
          input?.confirmation !== 'SEND ONE SHEET') {
        throw new Error('The approved fingerprint does not match this exact physical proof.');
      }
      if (typeof journalPath !== 'string' || !isAbsolute(journalPath)) {
        throw new Error('An absolute transport journal path is required.');
      }
      if (typeof openSession !== 'function') throw new Error('The USB session opener is unavailable.');

      const journal = createJournal(journalPath);
      let session;
      try {
        session = await openSession();
        const transport = createTransport(session.io);
        return await runAttempt(proof.artifacts, proof.binding, { journal, transport });
      } finally {
        if (session) await session.close();
        journal.close();
      }
    },
  };
}
