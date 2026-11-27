import {
  prepareTransportAttempt,
  SqliteTransportAttemptJournal,
} from '../packages/printer/src/transport-attempt.ts';
import { createPhysicalEvidenceRuntime, requireMutableAttempt } from './physical-evidence.mjs';
import { frameUploadPayload } from '../packages/printer/src/protocol-plan.ts';

export function createBrowserPhysicalCoordinator({
  approvalFingerprint,
  journalPath,
  getPhysicalAttemptEvidence = createPhysicalEvidenceRuntime({ journalPath }).getPhysicalAttemptEvidence,
  createJournal = (file) => new SqliteTransportAttemptJournal(file),
}) {
  let state = null;
  let started = false;

  function activeAttempt(attemptId) {
    requireMutableAttempt(getPhysicalAttemptEvidence, false);
    if (!state || attemptId !== state.evidenceHash) throw new Error('Browser physical attempt does not match.');
    return state;
  }

  return {
    get enabled() {
      return typeof approvalFingerprint === 'string' && /^[a-f0-9]{64}$/.test(approvalFingerprint);
    },

    begin(input, proof) {
      if (!this.enabled || input?.approvalFingerprint !== approvalFingerprint ||
          proof?.summary?.approvalFingerprint !== approvalFingerprint || input?.confirmation !== 'SEND ONE SHEET') {
        throw new Error('The browser physical approval does not match this exact job.');
      }
      requireMutableAttempt(getPhysicalAttemptEvidence, true);
      if (started) throw new Error('A browser physical attempt has already started.');
      const prepared = prepareTransportAttempt(proof.artifacts, proof.binding);
      if (!prepared) throw new Error('Physical proof evidence mismatch.');
      const journal = createJournal(journalPath);
      if (!journal.reserve(prepared.evidence, prepared.evidenceHash)) {
        journal.close?.();
        throw new Error('A physical attempt is already reserved.');
      }
      const descriptors = prepared.payloads.map((payload) => ({
        payload,
        frames: null,
      }));
      state = {
        ...prepared,
        journal,
        descriptors,
        jobId: null,
        sequence: 0,
        pending: null,
        totalFrames: prepared.payloads.reduce(
          (count, payload) => count + Math.ceil(payload.byteLength / 4071),
          0,
        ),
      };
      started = true;
      return {
        attemptId: prepared.evidenceHash,
        declaration: prepared.declaration,
        totalFrames: state.totalFrames,
      };
    },

    recordJobId({ attemptId, jobId }) {
      const current = activeAttempt(attemptId);
      if (!Number.isSafeInteger(jobId) || jobId <= 0 || jobId > 0xffff_ffff) {
        current.journal.markReconciliation(current.evidence.submissionId, current.evidenceHash, 'printer_job_id_invalid');
        throw new Error('Printer job ID is invalid.');
      }
      if (current.jobId !== null) throw new Error('Printer job ID is already recorded.');
      current.journal.recordPrinterJobId(current.evidence.submissionId, current.evidenceHash, jobId);
      current.jobId = jobId;
      for (const descriptor of current.descriptors) descriptor.frames = frameUploadPayload(descriptor.payload, jobId);
      return { ok: true };
    },

    nextFrame({ attemptId, sequence }) {
      const current = activeAttempt(attemptId);
      if (current.jobId === null) throw new Error('Printer job ID must be durable before upload.');
      if (current.pending !== null) throw new Error('The pending frame acknowledgement is not durable.');
      if (sequence !== current.sequence || sequence >= current.totalFrames) throw new Error('Frame sequence mismatch.');
      let offset = sequence;
      let selected;
      for (const descriptor of current.descriptors) {
        if (offset < descriptor.frames.length) {
          selected = { descriptor, index: offset, frame: descriptor.frames[offset] };
          break;
        }
        offset -= descriptor.frames.length;
      }
      if (!selected) throw new Error('Frame sequence is unavailable.');
      current.journal.recordFrameIntent(
        current.evidence.submissionId,
        current.evidenceHash,
        sequence,
        selected.descriptor.payload.kind,
        selected.index,
      );
      current.pending = sequence;
      return { sequence, kind: selected.descriptor.payload.kind, index: selected.index, frame: new Uint8Array(selected.frame) };
    },

    acknowledgeFrame({ attemptId, sequence }) {
      const current = activeAttempt(attemptId);
      if (sequence !== current.sequence || current.pending !== sequence) throw new Error('Frame acknowledgement sequence mismatch.');
      current.journal.recordFrameAcknowledged(current.evidence.submissionId, current.evidenceHash, sequence);
      current.pending = null;
      current.sequence += 1;
      return { ok: true, acknowledgedFrames: current.sequence };
    },

    finish({ attemptId }) {
      const current = activeAttempt(attemptId);
      if (current.pending !== null || current.sequence !== current.totalFrames) throw new Error('Physical upload is incomplete.');
      current.journal.markReconciliation(
        current.evidence.submissionId,
        current.evidenceHash,
        'physical_observation_required',
      );
      return { kind: 'needs_reconciliation', reason: 'physical_observation_required' };
    },

    hold({ attemptId, reason }) {
      const current = activeAttempt(attemptId);
      const allowed = new Set([
        'declaration_outcome_unknown', 'printer_job_id_invalid', 'frame_acknowledgement_unknown',
        'pacing_outcome_unknown', 'physical_observation_required',
      ]);
      if (!allowed.has(reason)) throw new Error('Unsupported reconciliation reason.');
      current.journal.markReconciliation(current.evidence.submissionId, current.evidenceHash, reason);
      return { kind: 'needs_reconciliation', reason };
    },
  };
}
