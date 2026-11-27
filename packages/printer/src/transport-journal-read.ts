import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { ArtifactReceiptSchema } from '@natcut/domain';
import { uploadFramePayloadBytes } from './upload-frame-size.ts';

export const journalIdentity = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const journalDigest = z.string().regex(/^[0-9a-f]{64}$/u).length(64);
export const journalJobId = z.int().positive().max(0xffff_ffff);
const payload = z.strictObject({ byteLength: z.int().positive(), sha256: journalDigest });
const transportEvidence = z.strictObject({
  submissionId: journalIdentity, eventId: journalIdentity, workerId: journalIdentity, executionToken: journalIdentity,
  manifestHash: journalDigest, receipt: ArtifactReceiptSchema, jpeg: payload, plt: payload,
});

const rowSchema = z.strictObject({
  submissionId: journalIdentity, evidenceHash: journalDigest, evidenceJson: z.string(),
  phase: z.enum(['declaring', 'declared', 'frame_pending', 'frame_acknowledged', 'needs_reconciliation']),
  printerJobId: journalJobId.nullable(), acknowledgedFrames: z.int().nonnegative(),
  pendingKind: z.enum(['plt', 'jpeg']).nullable(), pendingIndex: z.int().nonnegative().nullable(),
  reason: z.enum([
    'attempt_already_reserved', 'declaration_outcome_unknown', 'printer_job_id_invalid',
    'job_id_persistence_failed', 'frame_checkpoint_failed', 'frame_acknowledgement_unknown',
    'acknowledgement_checkpoint_failed', 'pacing_outcome_unknown', 'physical_observation_required',
  ]).nullable(),
});

export type TransportAttemptEvidence = z.infer<typeof transportEvidence>;
export type TransportAttemptRecord = z.infer<typeof rowSchema>;
export type TransportAttemptPhase = TransportAttemptRecord['phase'];
export type TransportAttemptReason = NonNullable<TransportAttemptRecord['reason']>;

function matchesPhase(row: TransportAttemptRecord) {
  const pending = row.pendingKind !== null;
  if (row.phase === 'needs_reconciliation') return row.reason !== null;
  if (row.reason !== null) return false;
  switch (row.phase) {
    case 'declaring': return row.printerJobId === null && !pending && row.acknowledgedFrames === 0;
    case 'declared': return row.printerJobId !== null && !pending && row.acknowledgedFrames === 0;
    case 'frame_pending': return row.printerJobId !== null && pending;
    case 'frame_acknowledged': return row.printerJobId !== null && !pending && row.acknowledgedFrames > 0;
  }
}

export function parseTransportAttemptRow(input: unknown) {
  const attempt = rowSchema.parse(input);
  const { evidenceJson, printerJobId, acknowledgedFrames, pendingKind, pendingIndex } = attempt;
  const evidence = transportEvidence.parse(JSON.parse(evidenceJson));
  if (createHash('sha256').update(evidenceJson).digest('hex') !== attempt.evidenceHash ||
      evidence.submissionId !== attempt.submissionId || evidence.jpeg.byteLength > evidence.receipt.descriptor.profile.jpegMaxBytes) {
    throw new Error('Transport attempt does not match its stored evidence.');
  }
  const pltFrames = Math.ceil(evidence.plt.byteLength / uploadFramePayloadBytes);
  const expectedFrames = pltFrames + Math.ceil(evidence.jpeg.byteLength / uploadFramePayloadBytes);
  const pending = pendingKind !== null;
  const expectedKind = acknowledgedFrames < pltFrames ? 'plt' : 'jpeg';
  const expectedIndex = expectedKind === 'plt' ? acknowledgedFrames : acknowledgedFrames - pltFrames;
  if (acknowledgedFrames > expectedFrames || pending !== (pendingIndex !== null) ||
      (pending && (pendingKind !== expectedKind || pendingIndex !== expectedIndex || acknowledgedFrames === expectedFrames)) ||
      (printerJobId === null && (pending || acknowledgedFrames !== 0)) ||
      !matchesPhase(attempt)) {
    throw new Error('Transport attempt has inconsistent frame checkpoints.');
  }
  return { attempt, expectedFrames };
}

export function openTransportJournalDatabase(file: string, fileMustExist: boolean) {
  if (typeof file !== 'string' || !isAbsolute(file) || file !== file.trim() || file.includes('\0')) {
    throw new Error('The transport attempt journal requires an absolute file path.');
  }
  const database = new Database(file, { fileMustExist });
  try {
    database.pragma('busy_timeout = 5000');
    if (database.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
      throw new Error('The transport attempt journal requires SQLite WAL mode.');
    }
    database.pragma('synchronous = FULL');
    if (process.platform === 'darwin') database.pragma('fullfsync = ON');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
