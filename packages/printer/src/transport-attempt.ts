import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { parseArtifactReceipt } from '@natcut/artifacts/reader';
import type { ArtifactReceipt } from '@natcut/domain';
import type { PreparedPhysicalArtifacts } from './artifacts.ts';
import { frameUploadPayload, planComboJob, planUploadPayloads, type UploadPayload } from './protocol-plan.ts';
import {
  openTransportJournalDatabase, parseTransportAttemptRow,
  type TransportAttemptEvidence, type TransportAttemptReason, type TransportAttemptRecord,
} from './transport-journal-read.ts';

export type { TransportAttemptEvidence, TransportAttemptPhase, TransportAttemptReason, TransportAttemptRecord } from './transport-journal-read.ts';

export type TransportAttemptBinding = {
  submissionId: string;
  eventId: string;
  workerId: string;
  executionToken: string;
  manifestHash: string;
  receipt: ArtifactReceipt;
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

export class SqliteTransportAttemptJournal implements TransportAttemptJournal {
  private readonly database: Database.Database;

  constructor(file: string) {
    this.database = openTransportJournalDatabase(file, false);
    try {
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
    const row = this.database.prepare(`
      SELECT submissionId, evidenceHash, evidenceJson, phase, printerJobId,
        acknowledgedFrames, pendingKind, pendingIndex, reason
      FROM transport_attempts WHERE submissionId = ?
    `).get(submissionId);
    return row === undefined ? null : parseTransportAttemptRow(row).attempt;
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

export function prepareTransportAttempt(
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
    if (!isDeepStrictEqual(receipt, artifacts.receipt)) return null;
    const payloads = planUploadPayloads(artifacts);
    const declaration = planComboJob(artifacts);
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
  const prepared = prepareTransportAttempt(artifacts, binding);
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
