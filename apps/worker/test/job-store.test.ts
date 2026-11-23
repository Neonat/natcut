import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobStore, type LocalPrintJob } from '../src/index.ts';

function job(overrides: Partial<LocalPrintJob> = {}): LocalPrintJob {
  return {
    id: 'local-1',
    submissionId: 'submission-1',
    queueNumber: 1,
    manifestHash: 'a'.repeat(64),
    rasterHash: 'b'.repeat(64),
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
  it('creates its schema idempotently and enforces one row per submission', () => {
    const store = new JobStore(':memory:');
    store.initialize();
    store.initialize();
    store.insert(job());
    expect(() => store.insert(job({ id: 'local-2' }))).toThrow(/unique/i);
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it('updates stateChangedAt while retaining artifact, profile, and geometry data', () => {
    const store = new JobStore(':memory:');
    store.insert(job());
    store.transition('submission-1', 'rendering', '2026-11-23T12:00:05.000Z');
    const stored = store.getBySubmissionId('submission-1')!;
    expect(stored.state).toBe('rendering');
    expect(stored.stateChangedAt).toBe('2026-11-23T12:00:05.000Z');
    expect(stored.printProfileSnapshotJson).toContain('knifePressure');
    expect(stored.geometryReportJson).toContain('severity');
    expect(stored.jpegSha256).toBe('c'.repeat(64));
    expect(stored.pltSha256).toBe('d'.repeat(64));
    store.close();
  });

  it('preserves jobs after closing and reopening the SQLite file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'natcut-store-'));
    const databasePath = path.join(directory, 'worker.sqlite');
    const first = new JobStore(databasePath);
    first.insert(job());
    first.close();

    const reopened = new JobStore(databasePath);
    expect(reopened.getBySubmissionId('submission-1')).toEqual(job());
    reopened.close();
  });
});
