import Database from 'better-sqlite3';
import { DEVFEST_SG_V1 } from '@natcut/domain';
import type { ClaimedSubmission } from './cloud-queue.ts';

export type LocalJobState =
  | 'claimed'
  | 'rendering'
  | 'validating'
  | 'ready_to_declare'
  | 'declaring'
  | 'uploading_cut'
  | 'uploading_image'
  | 'printing'
  | 'cutting'
  | 'ready'
  | 'failed'
  | 'needs_reconciliation';

export type UploadPhase = 'none' | 'cut' | 'image' | 'complete';

export type LocalPrintJob = {
  id: string;
  submissionId: string;
  queueNumber: number;
  manifestHash: string;
  rasterHash: string;
  printProfileSnapshotJson: string;
  geometryReportJson: string;
  jpegPath: string;
  jpegSha256: string;
  jpegBytes: number;
  pltPath: string;
  pltSha256: string;
  pltBytes: number;
  state: LocalJobState;
  printerJobId: number | null;
  uploadPhase: UploadPhase;
  lastPrinterState: number | null;
  lastPrinterSubState: number | null;
  lastAlertsJson: string;
  acceptedAt: string;
  stateChangedAt: string;
  lastError: string | null;
};

const columns = [
  'id', 'submissionId', 'queueNumber', 'manifestHash', 'rasterHash',
  'printProfileSnapshotJson', 'geometryReportJson', 'jpegPath', 'jpegSha256', 'jpegBytes',
  'pltPath', 'pltSha256', 'pltBytes', 'state', 'printerJobId', 'uploadPhase',
  'lastPrinterState', 'lastPrinterSubState', 'lastAlertsJson', 'acceptedAt', 'stateChangedAt', 'lastError',
] as const;

function uploadPhaseFor(state: LocalJobState): UploadPhase | null {
  if (state === 'uploading_cut') return 'cut';
  if (state === 'uploading_image') return 'image';
  if (state === 'printing' || state === 'cutting' || state === 'ready') return 'complete';
  return null;
}

export class JobStore {
  private readonly database: Database.Database;

  constructor(path: string) {
    this.database = new Database(path);
    this.initialize();
  }

  initialize() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_print_jobs (
        id TEXT PRIMARY KEY,
        submissionId TEXT NOT NULL UNIQUE,
        queueNumber INTEGER NOT NULL,
        manifestHash TEXT NOT NULL,
        rasterHash TEXT NOT NULL,
        printProfileSnapshotJson TEXT NOT NULL,
        geometryReportJson TEXT NOT NULL,
        jpegPath TEXT NOT NULL,
        jpegSha256 TEXT NOT NULL,
        jpegBytes INTEGER NOT NULL,
        pltPath TEXT NOT NULL,
        pltSha256 TEXT NOT NULL,
        pltBytes INTEGER NOT NULL,
        state TEXT NOT NULL,
        printerJobId INTEGER,
        uploadPhase TEXT NOT NULL,
        lastPrinterState INTEGER,
        lastPrinterSubState INTEGER,
        lastAlertsJson TEXT NOT NULL,
        acceptedAt TEXT NOT NULL,
        stateChangedAt TEXT NOT NULL,
        lastError TEXT
      )
    `);
  }

  insert(job: LocalPrintJob) {
    const names = columns.join(', ');
    const values = columns.map((column) => `@${column}`).join(', ');
    this.database.prepare(`INSERT INTO local_print_jobs (${names}) VALUES (${values})`).run(job);
  }

  insertClaimed(claim: ClaimedSubmission) {
    const { submission } = claim;
    this.insert({
      id: `local-${submission.id}`,
      submissionId: submission.id,
      queueNumber: submission.queueNumber,
      manifestHash: submission.manifestHash,
      rasterHash: submission.validation.rasterHash,
      printProfileSnapshotJson: JSON.stringify(DEVFEST_SG_V1),
      geometryReportJson: JSON.stringify(submission.validation),
      jpegPath: '', jpegSha256: '', jpegBytes: 0,
      pltPath: '', pltSha256: '', pltBytes: 0,
      state: 'claimed',
      printerJobId: null,
      uploadPhase: 'none',
      lastPrinterState: null,
      lastPrinterSubState: null,
      lastAlertsJson: '[]',
      acceptedAt: submission.acceptedAt,
      stateChangedAt: claim.claimedAt,
      lastError: null,
    });
  }

  transition(submissionId: string, state: LocalJobState, stateChangedAt: string, lastError: string | null = null) {
    const uploadPhase = uploadPhaseFor(state);
    const statement = uploadPhase
      ? this.database.prepare('UPDATE local_print_jobs SET state = ?, stateChangedAt = ?, lastError = ?, uploadPhase = ? WHERE submissionId = ?')
      : this.database.prepare('UPDATE local_print_jobs SET state = ?, stateChangedAt = ?, lastError = ? WHERE submissionId = ?');
    const result = uploadPhase
      ? statement.run(state, stateChangedAt, lastError, uploadPhase, submissionId)
      : statement.run(state, stateChangedAt, lastError, submissionId);
    if (result.changes !== 1) throw new Error(`Unknown local job for submission ${submissionId}`);
  }

  getBySubmissionId(submissionId: string): LocalPrintJob | null {
    return (this.database.prepare('SELECT * FROM local_print_jobs WHERE submissionId = ?').get(submissionId) as LocalPrintJob | undefined) ?? null;
  }

  list(): LocalPrintJob[] {
    return this.database.prepare('SELECT * FROM local_print_jobs ORDER BY queueNumber, acceptedAt').all() as LocalPrintJob[];
  }

  close() {
    this.database.close();
  }
}
