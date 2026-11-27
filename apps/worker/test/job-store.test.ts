import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobStore, prepareNextWorkerJob, runLocalJob, runWorkerOnce, type LocalPrintJob } from '../src/index.ts';
import { artifactReader, bundle, claimFixture, verifiedClaim } from './fixtures/submission.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryJournal() {
  const directory = mkdtempSync(path.join(tmpdir(), 'natcut-store-'));
  directories.push(directory);
  return path.join(directory, 'worker.sqlite');
}

function job(overrides: Partial<LocalPrintJob> = {}): LocalPrintJob {
  return {
    id: 'local-1',
    submissionId: 'submission-1',
    eventId: null,
    queueNumber: 1,
    manifestHash: 'a'.repeat(64),
    rasterHash: 'b'.repeat(64),
    artifactReceiptJson: null, artifactBytes: null, artifactVerifiedAt: null,
    colorSha256: null, cutMaskSha256: null, bundleSha256: null,
    completionAcknowledgedAt: null,
    printProfileSnapshotJson: JSON.stringify({ id: 'devfest-sg-v1', knifePressure: 42 }),
    geometryReportJson: JSON.stringify({ valid: true, severity: 'ok' }),
    jpegPath: '/tmp/submission-1.jpg',
    jpegSha256: 'c'.repeat(64),
    jpegBytes: 123_456,
    pltPath: '/tmp/submission-1.plt',
    pltSha256: 'd'.repeat(64),
    pltBytes: 8_765,
    state: 'claimed',
    printerJobId: null,
    uploadPhase: 'none',
    lastPrinterState: null,
    lastPrinterSubState: null,
    lastAlertsJson: '[]',
    acceptedAt: '2026-11-23T12:00:00.000Z',
    stateChangedAt: '2026-11-23T12:00:01.000Z',
    lastError: null,
    ...overrides,
  };
}

describe('JobStore', () => {
  it('creates its schema idempotently and enforces one row per submission', async () => {
    const store = new JobStore(':memory:');
    store.initialize();
    store.initialize();
    const verified = await verifiedClaim(claimFixture('submission-1'));
    store.insertClaimed(verified);
    expect(() => store.insertClaimed(verified)).toThrow(/unique/i);
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it('updates stateChangedAt while retaining artifact, profile, and geometry data', async () => {
    const store = new JobStore(':memory:');
    const verified = await verifiedClaim(claimFixture('submission-1'));
    store.insertClaimed(verified);
    store.transition('submission-1', 'rendering', '2026-11-23T12:00:05.000Z');
    const stored = store.getBySubmissionId('submission-1')!;
    expect(stored.state).toBe('rendering');
    expect(stored.stateChangedAt).toBe('2026-11-23T12:00:05.000Z');
    expect(stored.eventId).toBe(verified.submission.eventId);
    expect(stored.completionAcknowledgedAt).toBeNull();
    expect(stored.printProfileSnapshotJson).toContain('knifePressure');
    expect(stored.geometryReportJson).toContain('severity');
    expect(stored.jpegBytes).toBe(0);
    expect(stored.pltBytes).toBe(0);
    expect(stored.artifactReceiptJson).toBe(JSON.stringify(verified.artifact.receipt));
    expect(stored.artifactVerifiedAt).toBe(verified.verifiedAt);
    expect(stored.colorSha256).toBe(bundle.descriptor.colorSha256);
    expect(stored.cutMaskSha256).toBe(bundle.descriptor.maskSha256);
    expect(stored.bundleSha256).toBe(bundle.descriptor.bundleSha256);
    expect(Buffer.from(stored.artifactBytes!).equals(bundle.bytes)).toBe(true);
    store.close();
  });

  it('migrates and reopens a pre-artifact journal, preserving historical fields and refusing to execute its row', async () => {
    const databasePath = temporaryJournal();
    const legacy = new Database(databasePath);
    legacy.exec(`CREATE TABLE local_print_jobs (
      id TEXT PRIMARY KEY, submissionId TEXT NOT NULL UNIQUE, queueNumber INTEGER NOT NULL,
      manifestHash TEXT NOT NULL, rasterHash TEXT NOT NULL, printProfileSnapshotJson TEXT NOT NULL,
      geometryReportJson TEXT NOT NULL, jpegPath TEXT NOT NULL, jpegSha256 TEXT NOT NULL, jpegBytes INTEGER NOT NULL,
      pltPath TEXT NOT NULL, pltSha256 TEXT NOT NULL, pltBytes INTEGER NOT NULL, state TEXT NOT NULL, printerJobId INTEGER,
      uploadPhase TEXT NOT NULL, lastPrinterState INTEGER, lastPrinterSubState INTEGER, lastAlertsJson TEXT NOT NULL,
      acceptedAt TEXT NOT NULL, stateChangedAt TEXT NOT NULL, lastError TEXT
    )`);
    const oldColumns = legacy.pragma('table_info(local_print_jobs)') as {name: string}[];
    legacy.prepare('INSERT INTO local_print_jobs VALUES (' + oldColumns.map(c => '@' + c.name).join(',') + ')').run(job());
    legacy.close();
    new JobStore(databasePath).close();
    const store = new JobStore(databasePath);
    try {
      const migrated = store.getBySubmissionId('submission-1')!;
      expect(migrated).toEqual(job());
      const claim = claimFixture('submission-1');
      const cloud = { recoverClaim: vi.fn().mockResolvedValue(claim), claimNextSubmission: vi.fn(), beginExecution: vi.fn(), completeExecution: vi.fn() };
      const executor = { execute: vi.fn() };
      const deps = { store, cloud, artifactReader, workerId: 'mac-1', executor };
      expect(await runLocalJob(deps, migrated)).toEqual({ kind: 'needs_reconciliation', submissionId: 'submission-1' });
      expect((await runWorkerOnce(deps)).kind).toBe('needs_reconciliation');
      expect(store.getBySubmissionId('submission-1')).toMatchObject({ artifactBytes: null, colorSha256: null, rasterHash: 'b'.repeat(64) });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(cloud.beginExecution).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it.each(['blob', 'generation', 'profile', 'color', 'event'] as const)('holds a changed persisted %s after preparation and restart', async variant => {
    const databasePath = temporaryJournal();
    const claim = claimFixture('submission-1');
    const cloud = { recoverClaim: vi.fn().mockResolvedValue(claim), claimNextSubmission: vi.fn(), beginExecution: vi.fn(), completeExecution: vi.fn() };
    const executor = { execute: vi.fn() };
    const original = new JobStore(databasePath);
    const deps = { store: original, cloud, artifactReader, workerId: 'mac-1', executor };
    const prepared = await prepareNextWorkerJob(deps);
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw Error('missing prepared fixture');
    original.close();
    const disk = new Database(databasePath);
    if (variant === 'blob') {
      const damaged = bundle.bytes.slice();
      damaged[0] = 1;
      disk.prepare('UPDATE local_print_jobs SET artifactBytes = ?').run(damaged);
    } else if (variant === 'generation') {
      disk.prepare('UPDATE local_print_jobs SET artifactReceiptJson = ?').run(JSON.stringify({ ...claim.submission.artifact, generation: '2' }));
    } else if (variant === 'profile') {
      disk.exec("UPDATE local_print_jobs SET printProfileSnapshotJson = '{}'");
    } else if (variant === 'color') {
      disk.exec("UPDATE local_print_jobs SET colorSha256 = rasterHash");
    } else {
      disk.exec("UPDATE local_print_jobs SET eventId = 'different-event'");
    }
    disk.close();
    const store = new JobStore(databasePath);
    try {
      expect(await runLocalJob({ ...deps, store }, prepared.job)).toEqual({ kind: 'needs_reconciliation', submissionId: claim.submission.id });
      expect(store.getState(claim.submission.id)).toBe('needs_reconciliation');
      expect((await runWorkerOnce({ ...deps, store })).kind).toBe('needs_reconciliation');
      expect(executor.execute).not.toHaveBeenCalled();
      expect(cloud.beginExecution).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it('serializes execution guards across two connections without throwing SQLITE_BUSY', () => {
    const databasePath = temporaryJournal();
    const first = new JobStore(databasePath);
    const second = new JobStore(databasePath);
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      expect(first.tryAcquireExecutionGuard('first', process.pid)).toBe(true);
      process.env.TZ = 'Asia/Singapore';
      expect(() => second.tryAcquireExecutionGuard('second', process.pid)).not.toThrow();
      expect(second.tryAcquireExecutionGuard('second', process.pid)).toBe(false);
      first.releaseExecutionGuard('first');
      expect(second.tryAcquireExecutionGuard('second', process.pid)).toBe(true);
      second.releaseExecutionGuard('second');
    } finally {
      process.env.TZ = originalTimezone;
      first.close();
      second.close();
    }
  });
});
