import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  journalDigest, journalIdentity, journalJobId, openTransportJournalDatabase, parseStoredJournalJson, parseTransportAttemptRow,
  type TransportAttemptRecord,
} from './transport-journal-read.ts';

const timestamp = z.iso.datetime({ precision: 3 }).refine(value => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}, 'Expected a canonical UTC timestamp.');
const channel = z.enum(['pass', 'fail', 'uncertain']);
const channelResults = z.strictObject({ cyan: channel, magenta: channel, yellow: channel });

const completedAttempt = z.strictObject({
  recordVersion: z.literal(1), evidenceHash: journalDigest, submissionId: journalIdentity, printerJobId: journalJobId,
  observedAt: timestamp,
  transport: z.literal('passed'), cutAlignment: z.literal('passed'), kissCut: z.literal('passed'),
  printQuality: z.strictObject({ status: z.literal('failed'), cause: z.literal('printer_ribbon_registration') }),
  disposition: z.literal('locked_no_resend'),
});

const ribbonQc = z.strictObject({
  recordVersion: z.literal(1), evidenceHash: journalDigest, recordedAt: timestamp,
  channels: channelResults,
  evidence: z.array(z.strictObject({
    kind: z.enum(['photo_reference', 'operator_note']),
    reference: z.string().max(512).refine(value => value.trim().length > 0, 'Expected a nonempty evidence reference.'),
  })).max(8),
  notes: z.string().max(2000).nullable(),
});

export type PhysicalAttemptOutcome = z.infer<typeof completedAttempt>;
export type RibbonRegistrationQc = z.infer<typeof ribbonQc>;
export type PhysicalQcStatus = z.infer<typeof channel>;

export class ObservationConflict extends Error {}
export class InvalidObservation extends Error {}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidObservation('Invalid physical observation fields.');
  return parsed.data;
}

function fullyUploaded(row: TransportAttemptRecord, expectedFrames: number) {
  return row.phase === 'needs_reconciliation' && row.reason === 'physical_observation_required' &&
    row.printerJobId !== null && row.pendingKind === null && row.pendingIndex === null &&
    row.acknowledgedFrames === expectedFrames;
}

function publicCheckpoint(row: TransportAttemptRecord, expectedFrames: number) {
  return Object.freeze({
    fullyUploaded: fullyUploaded(row, expectedFrames),
    submissionId: row.submissionId,
    evidenceHash: row.evidenceHash,
    phase: row.phase,
    printerJobId: row.printerJobId,
    acknowledgedFrames: row.acknowledgedFrames,
    pendingKind: row.pendingKind,
    pendingIndex: row.pendingIndex,
    reason: row.reason,
  });
}

export type PhysicalAttemptEvidence = {
  readonly attempt: ReturnType<typeof publicCheckpoint>;
  outcome: PhysicalAttemptOutcome | null;
  ribbonRegistrationQc: RibbonRegistrationQc | null;
};

export function deriveRibbonRegistrationStatus(channels: RibbonRegistrationQc['channels']): PhysicalQcStatus {
  const values = Object.values(channelResults.parse(channels));
  if (values.includes('fail')) return 'fail';
  if (values.includes('uncertain')) return 'uncertain';
  return 'pass';
}

function singleRow(rows: unknown[]) {
  if (rows.length > 1) throw new Error('Conflicting records in the single-attempt journal.');
  return rows[0];
}

const storedRow = z.strictObject({ submissionId: journalIdentity, recordJson: z.string() });
function parseObservation<T>(rows: unknown[], submissionId: string | undefined, schema: z.ZodType<T>): T | null {
  const row = singleRow(rows);
  if (row === undefined) return null;
  const stored = storedRow.parse(row);
  if (stored.submissionId !== submissionId) throw new Error('Observation has no matching transport attempt.');
  return schema.parse(parseStoredJournalJson(stored.recordJson));
}

function matchesIdentity(record: PhysicalAttemptOutcome, attempt: PhysicalAttemptEvidence['attempt']) {
  return record.evidenceHash === attempt.evidenceHash && record.submissionId === attempt.submissionId &&
    record.printerJobId === attempt.printerJobId;
}

function identicalRetry<T>(stored: T, incoming: T): T {
  if (!isDeepStrictEqual(stored, incoming)) throw new ObservationConflict('A different immutable observation already exists.');
  return stored;
}

function initializeQcTables(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS physical_attempt_outcomes (
      submissionId TEXT PRIMARY KEY NOT NULL REFERENCES transport_attempts(submissionId),
      recordJson TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ribbon_registration_qc (
      submissionId TEXT PRIMARY KEY NOT NULL REFERENCES physical_attempt_outcomes(submissionId),
      recordJson TEXT NOT NULL
    )
  `);

  // An outcome seals its transport row even for already-open legacy connections.
  // The INSERT guard also covers SQLite REPLACE with an explicit rowid.
  for (const [table, seal] of [
    ['transport_attempts', 'physical_attempt_outcomes'],
    ['physical_attempt_outcomes', 'physical_attempt_outcomes'],
    ['ribbon_registration_qc', 'ribbon_registration_qc'],
  ] as const) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const matchingRow = operation === 'INSERT' ? '' : 'WHERE submissionId = OLD.submissionId';
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS lock_${table}_${operation}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (SELECT 1 FROM ${seal} ${matchingRow})
        BEGIN SELECT RAISE(ABORT, 'Observed physical record is locked'); END
      `);
    }
  }
}

export class SqlitePhysicalQcJournal {
  private readonly database: Database.Database;

  constructor(file: string) {
    this.database = openTransportJournalDatabase(file, true);
    try {
      // QC only attaches to an existing transport journal.
      this.database.prepare('SELECT submissionId FROM transport_attempts LIMIT 0').all();
      this.database.transaction(() => initializeQcTables(this.database)).immediate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private readSnapshot() {
    const raw = singleRow(this.database.prepare('SELECT * FROM transport_attempts LIMIT 2').all());
    const transport = raw === undefined ? null : parseTransportAttemptRow(raw);
    const submissionId = transport?.attempt.submissionId;
    const outcome = parseObservation(this.database.prepare('SELECT * FROM physical_attempt_outcomes LIMIT 2').all(),
      submissionId, completedAttempt);
    const ribbonRegistrationQc = parseObservation(this.database.prepare('SELECT * FROM ribbon_registration_qc LIMIT 2').all(),
      submissionId, ribbonQc);
    if (!transport) return null;
    const { attempt, expectedFrames } = transport;
    const checkpoint = publicCheckpoint(attempt, expectedFrames);
    if (outcome && (!checkpoint.fullyUploaded || !matchesIdentity(outcome, checkpoint))) {
      throw new Error('Stored observation does not match a completed upload.');
    }
    if (ribbonRegistrationQc && (!outcome || ribbonRegistrationQc.evidenceHash !== attempt.evidenceHash)) {
      throw new Error('Ribbon registration QC has no matching completed observation.');
    }
    return { attempt: checkpoint, outcome, ribbonRegistrationQc };
  }

  getPhysicalAttemptEvidence(): PhysicalAttemptEvidence | null {
    return this.database.transaction(() => this.readSnapshot())();
  }

  recordCompletedAttempt(input: unknown): PhysicalAttemptOutcome {
    const record = parseInput(completedAttempt, input);
    return this.database.transaction(() => {
      const snapshot = this.readSnapshot();
      if (!snapshot) throw new ObservationConflict('Transport attempt is missing.');
      const { attempt, outcome } = snapshot;
      if (!attempt.fullyUploaded || !matchesIdentity(record, attempt)) {
        throw new ObservationConflict('Observation requires the exact fully acknowledged attempt.');
      }
      if (outcome) return identicalRetry(outcome, record);
      this.database.prepare('INSERT INTO physical_attempt_outcomes (submissionId, recordJson) VALUES (?, ?)')
        .run(attempt.submissionId, JSON.stringify(record));
      return record;
    }).immediate();
  }

  recordRibbonRegistrationQc(input: unknown): RibbonRegistrationQc {
    const record = parseInput(ribbonQc, input);
    return this.database.transaction(() => {
      const evidence = this.readSnapshot();
      if (!evidence?.outcome || evidence.attempt.evidenceHash !== record.evidenceHash) {
        throw new ObservationConflict('Ribbon registration QC requires the exact completed observation.');
      }
      if (evidence.ribbonRegistrationQc) return identicalRetry(evidence.ribbonRegistrationQc, record);
      this.database.prepare('INSERT INTO ribbon_registration_qc (submissionId, recordJson) VALUES (?, ?)')
        .run(evidence.attempt.submissionId, JSON.stringify(record));
      return record;
    }).immediate();
  }

  close(): void {
    this.database.close();
  }
}
