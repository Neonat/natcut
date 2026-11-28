import type Database from 'better-sqlite3';
import { openTransportJournalDatabase, parseStoredJournalJson, parseTransportAttemptRow } from './transport-journal-read.ts';

export type QueuePhysicalPass = {
  recordVersion: 1;
  submissionId: string;
  evidenceHash: string;
  printerJobId: number;
  observedAt: string;
  transport: 'passed';
  cutAlignment: 'passed';
  kissCut: 'passed';
  printQuality: 'passed';
  ribbonRegistration: 'passed';
};

export class QueuePhysicalQcJournal {
  private readonly database: Database.Database;

  constructor(file: string) {
    this.database = openTransportJournalDatabase(file, true);
    try {
      this.database.prepare('SELECT submissionId FROM transport_attempts LIMIT 0').all();
      this.database.exec(`CREATE TABLE IF NOT EXISTS queue_physical_pass (
        submissionId TEXT PRIMARY KEY NOT NULL REFERENCES transport_attempts(submissionId),
        recordJson TEXT NOT NULL
      )`);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private requireCompleteAttempt(submissionId: string, evidenceHash: string) {
    const raw = this.database.prepare('SELECT * FROM transport_attempts WHERE submissionId = ?').get(submissionId);
    if (!raw) throw new Error('The exact transport attempt is missing.');
    const { attempt, expectedFrames } = parseTransportAttemptRow(raw);
    if (attempt.evidenceHash !== evidenceHash || attempt.phase !== 'needs_reconciliation' ||
        attempt.reason !== 'physical_observation_required' || attempt.printerJobId === null ||
        attempt.pendingKind !== null || attempt.pendingIndex !== null ||
        attempt.acknowledgedFrames !== expectedFrames) {
      throw new Error('Physical pass requires the exact fully acknowledged transport attempt.');
    }
    return attempt;
  }

  private readPass(submissionId: string, evidenceHash: string, printerJobId: number): QueuePhysicalPass | null {
    const existing = this.database.prepare('SELECT recordJson FROM queue_physical_pass WHERE submissionId = ?')
      .get(submissionId) as { recordJson: string } | undefined;
    if (!existing) return null;
    const parsed = parseStoredJournalJson(existing.recordJson) as QueuePhysicalPass;
    if (Object.keys(parsed).length !== 10 || parsed.evidenceHash !== evidenceHash ||
        parsed.printerJobId !== printerJobId || parsed.submissionId !== submissionId ||
        parsed.recordVersion !== 1 || parsed.transport !== 'passed' || parsed.cutAlignment !== 'passed' ||
        parsed.kissCut !== 'passed' || parsed.printQuality !== 'passed' || parsed.ribbonRegistration !== 'passed' ||
        typeof parsed.observedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.observedAt) ||
        new Date(parsed.observedAt).toISOString() !== parsed.observedAt) {
      throw new Error('A conflicting physical observation is already recorded.');
    }
    return parsed;
  }

  getPass(submissionId: string, evidenceHash: string): QueuePhysicalPass | null {
    const attempt = this.requireCompleteAttempt(submissionId, evidenceHash);
    return this.readPass(submissionId, evidenceHash, attempt.printerJobId!);
  }

  recordPass(submissionId: string, evidenceHash: string, observedAt: string): QueuePhysicalPass {
    return this.database.transaction(() => {
      const attempt = this.requireCompleteAttempt(submissionId, evidenceHash);
      const existing = this.readPass(submissionId, evidenceHash, attempt.printerJobId!);
      if (existing) return existing;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
          new Date(observedAt).toISOString() !== observedAt) throw new Error('Invalid observation time.');
      const pass: QueuePhysicalPass = {
        recordVersion: 1, submissionId, evidenceHash, printerJobId: attempt.printerJobId!, observedAt,
        transport: 'passed', cutAlignment: 'passed', kissCut: 'passed',
        printQuality: 'passed', ribbonRegistration: 'passed',
      };
      this.database.prepare('INSERT INTO queue_physical_pass (submissionId, recordJson) VALUES (?, ?)')
        .run(submissionId, JSON.stringify(pass));
      return pass;
    }).immediate();
  }

  close(): void {
    this.database.close();
  }
}
