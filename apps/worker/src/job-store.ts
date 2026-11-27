import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { VerifiedClaim } from './artifact-verification.ts';

export const localJobStates = [
  'claimed', 'rendering', 'validating', 'ready_to_declare', 'declaring', 'uploading_cut',
  'uploading_image', 'printing', 'cutting', 'ready', 'failed', 'needs_reconciliation',
] as const;
export type LocalJobState = (typeof localJobStates)[number];

export const safelyExecutableStates: ReadonlySet<LocalJobState> = new Set([
  'claimed', 'rendering', 'validating', 'ready_to_declare',
]);

export type UploadPhase = 'none' | 'cut' | 'image' | 'complete';

export type LocalPrintJob = {
  id: string;
  submissionId: string;
  eventId: string | null;
  queueNumber: number;
  manifestHash: string;
  rasterHash: string;
  artifactReceiptJson: string | null;
  artifactBytes: Uint8Array | null;
  artifactVerifiedAt: string | null;
  colorSha256: string | null;
  cutMaskSha256: string | null;
  bundleSha256: string | null;
  completionAcknowledgedAt: string | null;
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
  'id', 'submissionId', 'eventId', 'queueNumber', 'manifestHash', 'rasterHash',
  'artifactReceiptJson', 'artifactBytes', 'artifactVerifiedAt', 'colorSha256', 'cutMaskSha256', 'bundleSha256',
  'completionAcknowledgedAt',
  'printProfileSnapshotJson', 'geometryReportJson', 'jpegPath', 'jpegSha256', 'jpegBytes',
  'pltPath', 'pltSha256', 'pltBytes', 'state', 'printerJobId', 'uploadPhase',
  'lastPrinterState', 'lastPrinterSubState', 'lastAlertsJson', 'acceptedAt', 'stateChangedAt', 'lastError',
] as const;

const fallbackProcessIdentity = randomUUID();

function processIdentity(processId: number): string | null {
  try {
    const startedAt = execFileSync('/bin/ps', ['-p', String(processId), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
    }).trim();
    return startedAt || null;
  } catch {
    return processId === process.pid ? fallbackProcessIdentity : null;
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

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
    this.database.pragma('busy_timeout = 5000');
    this.initialize();
  }

  initialize() {
    this.database.transaction(() => this.migrate()).immediate();
  }

  private migrate() {
    let version = this.database.pragma('user_version', { simple: true }) as number;
    if (version === 3) return;
    if (version !== 0 && version !== 1 && version !== 2) throw new Error('Unsupported worker journal version.');
    if (version === 0) this.database.exec(`
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
        processId INTEGER NOT NULL,
        processIdentity TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_execution_identity (
        submissionId TEXT PRIMARY KEY,
        executionToken TEXT NOT NULL
      );
      ALTER TABLE local_print_jobs ADD COLUMN artifactReceiptJson TEXT;
      ALTER TABLE local_print_jobs ADD COLUMN artifactBytes BLOB;
      ALTER TABLE local_print_jobs ADD COLUMN artifactVerifiedAt TEXT;
      ALTER TABLE local_print_jobs ADD COLUMN colorSha256 TEXT;
      ALTER TABLE local_print_jobs ADD COLUMN cutMaskSha256 TEXT;
      ALTER TABLE local_print_jobs ADD COLUMN bundleSha256 TEXT;
      CREATE TABLE artifact_holds (submissionId TEXT PRIMARY KEY, heldAt TEXT NOT NULL, reason TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    if (version === 0) version = 1;
    const guardColumns = this.database.pragma('table_info(execution_guard)') as Array<{ name: string }>;
    if (!guardColumns.some((column) => column.name === 'processIdentity')) {
      this.database.exec("ALTER TABLE execution_guard ADD COLUMN processIdentity TEXT NOT NULL DEFAULT ''");
    }
    if (version === 1) this.database.exec(`
      ALTER TABLE local_print_jobs ADD COLUMN eventId TEXT;
      PRAGMA user_version = 2;
    `);
    if (version === 1) version = 2;
    if (version === 2) this.database.exec(`
      ALTER TABLE local_print_jobs ADD COLUMN completionAcknowledgedAt TEXT;
      PRAGMA user_version = 3;
    `);
  }

  private insert(job: LocalPrintJob) {
    const names = columns.join(', ');
    const values = columns.map((column) => `@${column}`).join(', ');
    this.database.prepare(`INSERT INTO local_print_jobs (${names}) VALUES (${values})`).run(job);
  }

  insertClaimed(claim: VerifiedClaim) {
    const { submission, artifact } = claim;
    const { descriptor } = artifact.receipt;
    this.insert({
      id: `local-${submission.id}`,
      submissionId: submission.id,
      eventId: submission.eventId,
      queueNumber: submission.queueNumber,
      manifestHash: submission.manifestHash,
      rasterHash: submission.validation.rasterHash,
      artifactReceiptJson: JSON.stringify(artifact.receipt),
      artifactBytes: artifact.bytes,
      artifactVerifiedAt: claim.verifiedAt,
      colorSha256: descriptor.colorSha256,
      cutMaskSha256: descriptor.maskSha256,
      bundleSha256: descriptor.bundleSha256,
      completionAcknowledgedAt: null,
      printProfileSnapshotJson: JSON.stringify(descriptor.profile),
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

  hasArtifactHold(submissionId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM artifact_holds WHERE submissionId = ?').get(submissionId));
  }

  holdArtifact(submissionId: string, heldAt: string, reason: string): 'busy' | 'needs_reconciliation' {
    return this.database.transaction(() => {
      if (this.hasLiveExecutionGuard()) return 'busy';
      this.database.prepare('INSERT OR IGNORE INTO artifact_holds VALUES (?, ?, ?)').run(submissionId, heldAt, reason);
      if (this.getState(submissionId)) this.transition(submissionId, 'needs_reconciliation', heldAt, reason);
      return 'needs_reconciliation';
    }).immediate();
  }

  holdArtifactWhileGuarded(submissionId: string, heldAt: string, reason: string, ownerToken: string): 'needs_reconciliation' {
    return this.database.transaction(() => {
      const ownsGuard = this.database.prepare(
        'SELECT 1 FROM execution_guard WHERE singleton = 1 AND ownerToken = ?',
      ).get(ownerToken);
      if (!ownsGuard) throw new Error('Completion recovery no longer owns the execution guard.');
      this.database.prepare('INSERT OR IGNORE INTO artifact_holds VALUES (?, ?, ?)').run(submissionId, heldAt, reason);
      if (this.getState(submissionId)) this.transition(submissionId, 'needs_reconciliation', heldAt, reason);
      return 'needs_reconciliation' as const;
    }).immediate();
  }

  ensureClaimed(claim: VerifiedClaim): 'available' | 'busy' | 'needs_reconciliation' {
    return this.database.transaction(() => {
      // Observe ownership and classify the journal in the same SQLite transaction.
      if (this.hasLiveExecutionGuard()) return 'busy';
      if (this.hasArtifactHold(claim.submission.id)) return 'needs_reconciliation';
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
          return 'needs_reconciliation';
        }
        return 'available';
      }
      const { receipt, bytes } = claim.artifact;
      if (existing.eventId !== claim.submission.eventId || existing.manifestHash !== claim.submission.manifestHash ||
          existing.queueNumber !== claim.submission.queueNumber ||
          existing.artifactReceiptJson !== JSON.stringify(receipt) || !existing.artifactVerifiedAt ||
          !Buffer.isBuffer(existing.artifactBytes) || !existing.artifactBytes.equals(bytes) ||
          existing.colorSha256 !== receipt.descriptor.colorSha256 || existing.cutMaskSha256 !== receipt.descriptor.maskSha256 ||
          existing.bundleSha256 !== receipt.descriptor.bundleSha256 || existing.printProfileSnapshotJson !== JSON.stringify(receipt.descriptor.profile) ||
          existing.geometryReportJson !== JSON.stringify(claim.submission.validation) || existing.rasterHash !== claim.submission.validation.rasterHash) {
        this.transition(existing.submissionId, 'needs_reconciliation', claim.verifiedAt, 'Cloud evidence differs from the local journal.');
        return 'needs_reconciliation';
      }
      if (safelyExecutableStates.has(existing.state) && claim.submission.publicStatus !== 'next') {
        this.transition(existing.submissionId, 'needs_reconciliation', claim.verifiedAt,
          'Cloud status is inconsistent with the local pre-execution phase.');
        return 'needs_reconciliation';
      }
      if (claim.submission.publicStatus === 'printing' && existing.state !== 'needs_reconciliation') {
        const localExecutionToken = this.getExecutionToken(existing.submissionId);
        if (!claim.executionToken || claim.executionToken !== localExecutionToken) {
          this.transition(
            existing.submissionId,
            'needs_reconciliation',
            claim.claimedAt,
            'Cloud execution belongs to a different or missing local journal generation.',
          );
          return 'needs_reconciliation';
        }
      } else if (existing.state === 'ready') {
        this.transition(existing.submissionId, 'needs_reconciliation', claim.verifiedAt,
          'Completed journal has no matching cloud printing fence.');
        return 'needs_reconciliation';
      }
      return 'available';
    }).immediate();
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

  transitionIfCurrentState(
    submissionId: string,
    expectedState: LocalJobState,
    state: LocalJobState,
    stateChangedAt: string,
    lastError: string | null = null,
  ): boolean {
    const result = this.database.prepare(
      'UPDATE local_print_jobs SET state = ?, stateChangedAt = ?, lastError = ? WHERE submissionId = ? AND state = ?',
    ).run(state, stateChangedAt, lastError, submissionId, expectedState);
    return result.changes === 1;
  }

  getBySubmissionId(submissionId: string): LocalPrintJob | null {
    return (this.database.prepare('SELECT * FROM local_print_jobs WHERE submissionId = ?').get(submissionId) as LocalPrintJob | undefined) ?? null;
  }

  getState(submissionId: string): LocalJobState | undefined {
    return this.database.prepare('SELECT state FROM local_print_jobs WHERE submissionId = ?').pluck().get(submissionId) as LocalJobState | undefined;
  }

  listStates(): Pick<LocalPrintJob, 'submissionId' | 'state'>[] {
    return this.database.prepare('SELECT submissionId, state FROM local_print_jobs ORDER BY queueNumber, acceptedAt').all() as Pick<LocalPrintJob, 'submissionId' | 'state'>[];
  }

  list(): LocalPrintJob[] {
    return this.database.prepare('SELECT * FROM local_print_jobs ORDER BY queueNumber, acceptedAt').all() as LocalPrintJob[];
  }

  firstUnresolvedLocalJob(): LocalPrintJob | null {
    return (this.database.prepare(`SELECT * FROM local_print_jobs
      WHERE NOT (state = 'ready' AND completionAcknowledgedAt IS NOT NULL)
      ORDER BY queueNumber, acceptedAt LIMIT 1`).get() as LocalPrintJob | undefined) ?? null;
  }

  listBlockingSubmissionIds(): string[] {
    return this.database.prepare(`
      SELECT submissionId FROM artifact_holds
      UNION
      SELECT submissionId FROM public_status_outbox
      UNION
      SELECT submissionId FROM local_print_jobs WHERE state IN ('failed', 'needs_reconciliation')
      ORDER BY submissionId
    `).pluck().all() as string[];
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

  acknowledgeCompletion(pending: PendingPublicStatus): boolean {
    return this.database.transaction(() => {
      const job = this.getBySubmissionId(pending.submissionId);
      if (!job || job.state !== 'ready' || job.stateChangedAt !== pending.updatedAt || job.completionAcknowledgedAt) return false;
      const cleared = this.database.prepare(`DELETE FROM public_status_outbox
        WHERE id = @id AND submissionId = @submissionId AND status = 'ready' AND updatedAt = @updatedAt`).run(pending);
      if (cleared.changes !== 1) return false;
      const acknowledged = this.database.prepare(`UPDATE local_print_jobs SET completionAcknowledgedAt = ?
        WHERE submissionId = ? AND state = 'ready' AND stateChangedAt = ? AND completionAcknowledgedAt IS NULL`
      ).run(pending.updatedAt, pending.submissionId, pending.updatedAt);
      if (acknowledged.changes !== 1) throw new Error('Completion acknowledgement lost its journal transition.');
      return true;
    }).immediate();
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

  hasLiveExecutionGuard(): boolean {
    const owner = this.database.prepare(
      'SELECT processId, processIdentity FROM execution_guard WHERE singleton = 1',
    ).get() as { processId: number; processIdentity: string } | undefined;
    if (!owner) return false;
    const observed = processIdentity(owner.processId);
    return observed === null
      ? processExists(owner.processId)
      : owner.processIdentity !== '' && observed === owner.processIdentity;
  }

  tryAcquireExecutionGuard(ownerToken: string, processId: number): boolean {
    return this.database.transaction(() => {
      if (this.hasLiveExecutionGuard()) return false;
      this.database.prepare(
        'INSERT OR REPLACE INTO execution_guard (singleton, ownerToken, processId, processIdentity) VALUES (1, ?, ?, ?)',
      ).run(ownerToken, processId, processIdentity(processId) ?? fallbackProcessIdentity);
      return true;
    }).immediate();
  }

  releaseExecutionGuard(ownerToken: string) {
    this.database.prepare('DELETE FROM execution_guard WHERE singleton = 1 AND ownerToken = ?').run(ownerToken);
  }

  getExecutionToken(submissionId: string): string | undefined {
    return this.database.prepare('SELECT executionToken FROM job_execution_identity WHERE submissionId = ?').pluck().get(submissionId) as string | undefined;
  }

  getOrCreateExecutionToken(submissionId: string): string {
    return this.database.transaction(() => {
      const existing = this.getExecutionToken(submissionId);
      if (existing) return existing;
      const executionToken = randomUUID();
      this.database.prepare(
        'INSERT INTO job_execution_identity (submissionId, executionToken) VALUES (?, ?)',
      ).run(submissionId, executionToken);
      return executionToken;
    }).immediate();
  }

  close() {
    this.database.close();
  }
}
