import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { parseArtifactReceipt } from '@natcut/artifacts/reader';
import type { ArtifactReceipt } from '@natcut/domain';
import type { PreparedPhysicalArtifacts } from './artifacts.ts';
import { frameUploadPayload, planComboJob, planUploadPayloads, type UploadPayload } from './protocol-plan.ts';

export type TransportAttemptBinding = {
  submissionId: string;
  eventId: string;
  workerId: string;
  executionToken: string;
  manifestHash: string;
  receipt: ArtifactReceipt;
};

export type TransportAttemptEvidence = {
  submissionId: string;
  eventId: string;
  workerId: string;
  executionToken: string;
  manifestHash: string;
  receipt: ArtifactReceipt;
  jpeg: { byteLength: number; sha256: string };
  plt: { byteLength: number; sha256: string };
};

export type TransportAttemptPhase =
  | 'declaring'
  | 'declared'
  | 'frame_pending'
  | 'frame_acknowledged'
  | 'needs_reconciliation';

export type TransportAttemptReason =
  | 'attempt_already_reserved'
  | 'declaration_outcome_unknown'
  | 'printer_job_id_invalid'
  | 'job_id_persistence_failed'
  | 'frame_checkpoint_failed'
  | 'frame_acknowledgement_unknown'
  | 'acknowledgement_checkpoint_failed'
  | 'pacing_outcome_unknown'
  | 'physical_observation_required';

export type TransportAttemptRecord = {
  submissionId: string;
  evidenceHash: string;
  evidenceJson: string;
  phase: TransportAttemptPhase;
  printerJobId: number | null;
  acknowledgedFrames: number;
  pendingKind: 'plt' | 'jpeg' | null;
  pendingIndex: number | null;
  reason: TransportAttemptReason | null;
};

export interface TransportAttemptJournal {
  reserve(evidence: TransportAttemptEvidence, evidenceHash: string): boolean;
  recordPrinterJobId(submissionId: string, evidenceHash: string, jobId: number): void;
  recordFrameIntent(
    submissionId: string,
    evidenceHash: string,
    sequence: number,
    kind: 'plt' | 'jpeg',
    index: number,
  ): void;
  recordFrameAcknowledged(submissionId: string, evidenceHash: string, sequence: number): void;
  markReconciliation(submissionId: string, evidenceHash: string, reason: TransportAttemptReason): void;
}

export interface TransportMutationPort {
  declareCombo(declaration: ReturnType<typeof planComboJob>): Promise<unknown>;
  sendFrameAndWaitForAck(input: {
    jobId: number;
    kind: 'plt' | 'jpeg';
    index: number;
    frame: Uint8Array;
  }): Promise<void>;
}

export type TransportAttemptResult =
  | { kind: 'preflight_failed'; reason: 'evidence_mismatch' | 'journal_unavailable' }
  | { kind: 'needs_reconciliation'; reason: TransportAttemptReason };

const phases: ReadonlySet<string> = new Set([
  'declaring', 'declared', 'frame_pending', 'frame_acknowledged', 'needs_reconciliation',
]);
const reasons: ReadonlySet<string> = new Set([
  'attempt_already_reserved', 'declaration_outcome_unknown', 'printer_job_id_invalid',
  'job_id_persistence_failed', 'frame_checkpoint_failed', 'frame_acknowledgement_unknown',
  'acknowledgement_checkpoint_failed', 'pacing_outcome_unknown', 'physical_observation_required',
]);

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

function isPhase(input: unknown): input is TransportAttemptPhase {
  return typeof input === 'string' && phases.has(input);
}

function isReason(input: unknown): input is TransportAttemptReason {
  return typeof input === 'string' && reasons.has(input);
}

function parseRecord(input: unknown): TransportAttemptRecord | null {
  if (!isRecord(input)) return null;
  const row = input;
  if (typeof row.submissionId !== 'string' || typeof row.evidenceHash !== 'string' ||
      typeof row.evidenceJson !== 'string' || !isPhase(row.phase) ||
      (row.printerJobId !== null && typeof row.printerJobId !== 'number') ||
      typeof row.acknowledgedFrames !== 'number' ||
      (row.pendingKind !== null && row.pendingKind !== 'plt' && row.pendingKind !== 'jpeg') ||
      (row.pendingIndex !== null && typeof row.pendingIndex !== 'number') ||
      (row.reason !== null && !isReason(row.reason))) {
    throw new Error('Invalid transport attempt journal row.');
  }
  return {
    submissionId: row.submissionId,
    evidenceHash: row.evidenceHash,
    evidenceJson: row.evidenceJson,
    phase: row.phase,
    printerJobId: row.printerJobId,
    acknowledgedFrames: row.acknowledgedFrames,
    pendingKind: row.pendingKind,
    pendingIndex: row.pendingIndex,
    reason: row.reason,
  };
}

export class SqliteTransportAttemptJournal implements TransportAttemptJournal {
  private readonly database: Database.Database;

  constructor(file: string) {
    if (typeof file !== 'string' || !isAbsolute(file) || file !== file.trim() || file.includes('\0')) {
      throw new Error('The transport attempt journal requires an absolute file path.');
    }
    this.database = new Database(file);
    try {
      this.database.pragma('busy_timeout = 5000');
      if (this.database.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
        throw new Error('The transport attempt journal requires SQLite WAL mode.');
      }
      this.database.pragma('synchronous = FULL');
      if (process.platform === 'darwin') this.database.pragma('fullfsync = ON');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS transport_attempts (
          submissionId TEXT PRIMARY KEY,
          evidenceHash TEXT NOT NULL,
          evidenceJson TEXT NOT NULL,
          phase TEXT NOT NULL,
          printerJobId INTEGER,
          acknowledgedFrames INTEGER NOT NULL,
          pendingKind TEXT,
          pendingIndex INTEGER,
          reason TEXT
        )
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  reserve(evidence: TransportAttemptEvidence, evidenceHash: string): boolean {
    const result = this.database.prepare(`
      INSERT INTO transport_attempts
        (submissionId, evidenceHash, evidenceJson, phase, printerJobId, acknowledgedFrames, pendingKind, pendingIndex, reason)
      SELECT ?, ?, ?, 'declaring', NULL, 0, NULL, NULL, NULL
      WHERE NOT EXISTS (SELECT 1 FROM transport_attempts)
      ON CONFLICT(submissionId) DO NOTHING
    `).run(evidence.submissionId, evidenceHash, JSON.stringify(evidence));
    return result.changes === 1;
  }

  recordPrinterJobId(submissionId: string, evidenceHash: string, jobId: number): void {
    const result = this.database.prepare(`
      UPDATE transport_attempts SET phase = 'declared', printerJobId = ?
      WHERE submissionId = ? AND evidenceHash = ? AND phase = 'declaring' AND printerJobId IS NULL
    `).run(jobId, submissionId, evidenceHash);
    if (result.changes !== 1) throw new Error('Transport attempt job ID checkpoint did not match.');
  }

  recordFrameIntent(
    submissionId: string,
    evidenceHash: string,
    sequence: number,
    kind: 'plt' | 'jpeg',
    index: number,
  ): void {
    const result = this.database.prepare(`
      UPDATE transport_attempts
      SET phase = 'frame_pending', pendingKind = ?, pendingIndex = ?, reason = NULL
      WHERE submissionId = ? AND evidenceHash = ? AND acknowledgedFrames = ?
        AND printerJobId IS NOT NULL AND phase IN ('declared', 'frame_acknowledged')
    `).run(kind, index, submissionId, evidenceHash, sequence);
    if (result.changes !== 1) throw new Error('Transport attempt frame intent checkpoint did not match.');
  }

  recordFrameAcknowledged(submissionId: string, evidenceHash: string, sequence: number): void {
    const result = this.database.prepare(`
      UPDATE transport_attempts
      SET phase = 'frame_acknowledged', acknowledgedFrames = ?, pendingKind = NULL, pendingIndex = NULL
      WHERE submissionId = ? AND evidenceHash = ? AND phase = 'frame_pending' AND acknowledgedFrames = ?
    `).run(sequence + 1, submissionId, evidenceHash, sequence);
    if (result.changes !== 1) throw new Error('Transport attempt acknowledgement checkpoint did not match.');
  }

  markReconciliation(submissionId: string, evidenceHash: string, reason: TransportAttemptReason): void {
    const result = this.database.prepare(`
      UPDATE transport_attempts SET phase = 'needs_reconciliation', reason = ?
      WHERE submissionId = ? AND evidenceHash = ?
    `).run(reason, submissionId, evidenceHash);
    if (result.changes !== 1) throw new Error('Transport attempt reconciliation checkpoint did not match.');
  }

  get(submissionId: string): TransportAttemptRecord | null {
    return parseRecord(this.database.prepare(`
      SELECT submissionId, evidenceHash, evidenceJson, phase, printerJobId,
        acknowledgedFrames, pendingKind, pendingIndex, reason
      FROM transport_attempts WHERE submissionId = ?
    `).get(submissionId));
  }

  close(): void {
    this.database.close();
  }
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function prepareAttempt(
  artifacts: PreparedPhysicalArtifacts,
  binding: unknown,
): { declaration: ReturnType<typeof planComboJob>; payloads: UploadPayload[]; evidence: TransportAttemptEvidence; evidenceHash: string } | null {
  try {
    if (!isRecord(binding)) return null;
    const { submissionId, eventId, workerId, executionToken, manifestHash } = binding;
    if (!validIdentity(submissionId) || !validIdentity(eventId) || !validIdentity(workerId) ||
        !validIdentity(executionToken) || typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifestHash)) {
      return null;
    }
    const receipt = parseArtifactReceipt(binding.receipt);
    const snapshot = { ...artifacts };
    if (!isDeepStrictEqual(receipt, snapshot.receipt) || !isDeepStrictEqual(receipt.descriptor.profile, snapshot.profile) ||
        !(snapshot.jpeg instanceof Uint8Array) || !(snapshot.plt instanceof Uint8Array)) return null;
    snapshot.receipt = receipt;
    snapshot.profile = receipt.descriptor.profile;
    snapshot.jpeg = new Uint8Array(snapshot.jpeg);
    snapshot.plt = new Uint8Array(snapshot.plt);
    if (snapshot.jpeg.byteLength === 0 || snapshot.plt.byteLength === 0) return null;

    const payloads = planUploadPayloads(snapshot);
    const declaration = planComboJob(snapshot);
    const jpeg = payloads.find((payload) => payload.kind === 'jpeg');
    const plt = payloads.find((payload) => payload.kind === 'plt');
    if (!jpeg || !plt) return null;
    const evidence: TransportAttemptEvidence = {
      submissionId,
      eventId,
      workerId,
      executionToken,
      manifestHash,
      receipt,
      jpeg: { byteLength: jpeg.byteLength, sha256: jpeg.sha256 },
      plt: { byteLength: plt.byteLength, sha256: plt.sha256 },
    };
    return { declaration, payloads, evidence, evidenceHash: digestText(JSON.stringify(evidence)) };
  } catch {
    return null;
  }
}

function parsePrinterJobId(input: unknown): number | null {
  try {
    if (!isRecord(input)) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 1 || keys[0] !== 'jobId') return null;
    const property = Object.getOwnPropertyDescriptor(input, 'jobId');
    const value: unknown = property?.enumerable ? property.value : undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff
      ? value
      : null;
  } catch {
    return null;
  }
}

function requireReconciliation(
  journal: TransportAttemptJournal,
  submissionId: string,
  evidenceHash: string,
  reason: TransportAttemptReason,
): TransportAttemptResult {
  try {
    journal.markReconciliation(submissionId, evidenceHash, reason);
  } catch {
  }
  return { kind: 'needs_reconciliation', reason };
}

export async function runTransportAttempt(
  artifacts: PreparedPhysicalArtifacts,
  binding: TransportAttemptBinding,
  dependencies: {
    journal: TransportAttemptJournal;
    transport: TransportMutationPort;
    pace?: (milliseconds: number) => Promise<void>;
  },
): Promise<TransportAttemptResult> {
  const prepared = prepareAttempt(artifacts, binding);
  if (!prepared) return { kind: 'preflight_failed', reason: 'evidence_mismatch' };
  const { declaration, payloads, evidence, evidenceHash } = prepared;
  const { submissionId } = evidence;
  const { journal, transport } = dependencies;
  const pace = dependencies.pace ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  try {
    if (!journal.reserve(evidence, evidenceHash)) {
      return { kind: 'needs_reconciliation', reason: 'attempt_already_reserved' };
    }
  } catch {
    return { kind: 'preflight_failed', reason: 'journal_unavailable' };
  }

  let declarationReply: unknown;
  try {
    declarationReply = await transport.declareCombo(declaration);
  } catch {
    return requireReconciliation(journal, submissionId, evidenceHash, 'declaration_outcome_unknown');
  }
  const jobId = parsePrinterJobId(declarationReply);
  if (jobId === null) return requireReconciliation(journal, submissionId, evidenceHash, 'printer_job_id_invalid');
  try {
    journal.recordPrinterJobId(submissionId, evidenceHash, jobId);
  } catch {
    return requireReconciliation(journal, submissionId, evidenceHash, 'job_id_persistence_failed');
  }

  let sequence = 0;
  for (const payload of payloads) {
    const frames = frameUploadPayload(payload, jobId);
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]!;
      try {
        journal.recordFrameIntent(submissionId, evidenceHash, sequence, payload.kind, index);
      } catch {
        return requireReconciliation(journal, submissionId, evidenceHash, 'frame_checkpoint_failed');
      }
      try {
        await transport.sendFrameAndWaitForAck({ jobId, kind: payload.kind, index, frame: new Uint8Array(frame) });
      } catch {
        return requireReconciliation(journal, submissionId, evidenceHash, 'frame_acknowledgement_unknown');
      }
      try {
        journal.recordFrameAcknowledged(submissionId, evidenceHash, sequence);
      } catch {
        return requireReconciliation(journal, submissionId, evidenceHash, 'acknowledgement_checkpoint_failed');
      }
      try {
        await pace(120);
      } catch {
        return requireReconciliation(journal, submissionId, evidenceHash, 'pacing_outcome_unknown');
      }
      sequence += 1;
    }
  }
  return requireReconciliation(journal, submissionId, evidenceHash, 'physical_observation_required');
}
