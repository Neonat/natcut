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

export type PendingPublicStatus = {
  id: number;
  submissionId: string;
  status: 'printing' | 'ready';
  updatedAt: string;
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
      );
      CREATE TABLE IF NOT EXISTS public_status_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submissionId TEXT NOT NULL,
        status TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(submissionId, status)
      );
      CREATE TABLE IF NOT EXISTS execution_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        ownerToken TEXT NOT NULL,
        processId INTEGER NOT NULL
      );
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

  ensureClaimed(claim: ClaimedSubmission): boolean {
    const existing = this.getBySubmissionId(claim.submission.id);
    if (!existing) {
      this.insertClaimed(claim);
      if (claim.submission.publicStatus !== 'next') {
        this.transition(
          claim.submission.id,
          'needs_reconciliation',
          claim.claimedAt,
          `Local journal was missing while cloud status was ${claim.submission.publicStatus}.`,
        );
        return false;
      }
      return true;
    }
    if (existing.manifestHash !== claim.submission.manifestHash || existing.queueNumber !== claim.submission.queueNumber) {
      throw new Error(`Cloud lease for ${claim.submission.id} does not match the local journal`);
    }
    if (claim.submission.publicStatus === 'printing' && ![
      'declaring', 'uploading_cut', 'uploading_image', 'printing', 'cutting', 'ready', 'needs_reconciliation',
    ].includes(existing.state)) {
      this.transition(
        existing.submissionId,
        'needs_reconciliation',
        claim.claimedAt,
        'Cloud status is ahead of the local journal.',
      );
      return false;
    }
    return true;
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

  stagePublicStatus(submissionId: string, status: 'printing' | 'ready', updatedAt: string) {
    this.database.prepare(`
      INSERT INTO public_status_outbox (submissionId, status, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(submissionId, status) DO UPDATE SET updatedAt = excluded.updatedAt
    `).run(submissionId, status, updatedAt);
  }

  listPendingPublicStatuses(): PendingPublicStatus[] {
    return this.database.prepare('SELECT * FROM public_status_outbox ORDER BY id').all() as PendingPublicStatus[];
  }

  clearPendingPublicStatus(id: number) {
    this.database.prepare('DELETE FROM public_status_outbox WHERE id = ?').run(id);
  }

  transitionAndStagePublicStatus(
    submissionId: string,
    state: LocalJobState,
    stateChangedAt: string,
    status: 'printing' | 'ready',
  ) {
    this.database.transaction(() => {
      this.transition(submissionId, state, stateChangedAt);
      this.stagePublicStatus(submissionId, status, stateChangedAt);
    })();
  }

  tryAcquireExecutionGuard(ownerToken: string, processId: number): boolean {
    return this.database.transaction(() => {
      const existing = this.database.prepare(
        'SELECT ownerToken, processId FROM execution_guard WHERE singleton = 1',
      ).get() as { ownerToken: string; processId: number } | undefined;
      if (existing) {
        let alive = existing.processId === processId;
        if (!alive) {
          try {
            process.kill(existing.processId, 0);
            alive = true;
          } catch (cause) {
            alive = (cause as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }
        if (alive) return false;
        this.database.prepare('DELETE FROM execution_guard WHERE singleton = 1 AND ownerToken = ?')
          .run(existing.ownerToken);
      }
      this.database.prepare(
        'INSERT INTO execution_guard (singleton, ownerToken, processId) VALUES (1, ?, ?)',
      ).run(ownerToken, processId);
      return true;
    })();
  }

  releaseExecutionGuard(ownerToken: string) {
    this.database.prepare('DELETE FROM execution_guard WHERE singleton = 1 AND ownerToken = ?').run(ownerToken);
  }

  close() {
    this.database.close();
  }
}
