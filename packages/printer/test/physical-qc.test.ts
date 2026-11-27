import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { DEVFEST_SG_V1 as profile, printProfileHashSync } from '@natcut/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveRibbonRegistrationStatus, SqlitePhysicalQcJournal,
  type PhysicalAttemptOutcome, type RibbonRegistrationQc,
} from '@natcut/printer/physical-qc';
import { SqliteTransportAttemptJournal, type TransportAttemptEvidence } from '../src/transport-attempt.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const submissionId = 'fixture-submission';
const printerJobId = 37;
const timestamp = '2026-01-15T13:01:02.345Z';
const width = profile.sheetWidthPx;
const height = profile.sheetHeightPx;
const pixels = width * height;
const evidence: TransportAttemptEvidence = {
  submissionId, eventId: 'fixture-event', workerId: 'fixture-worker',
  executionToken: 'fixture-token', manifestHash: hash('manifest'),
  receipt: {
    generation: '7',
    descriptor: {
      formatVersion: 1, width, height, profile, renderVersion: 'server-raster-v1', geometryVersion: 'geometry-v1',
      colorByteLength: pixels * 4, maskByteLength: pixels, byteLength: pixels * 5,
      colorSha256: hash('color'), maskSha256: hash('mask'), bundleSha256: hash('bundle'),
      profileSha256: printProfileHashSync(profile),
    },
  },
  plt: { byteLength: 4072, sha256: hash('plot') },
  jpeg: { byteLength: 8142, sha256: hash('jpeg') },
};
const evidenceHash = hash(JSON.stringify(evidence));
const outcome: PhysicalAttemptOutcome = {
  recordVersion: 1, submissionId, evidenceHash, printerJobId, observedAt: timestamp,
  transport: 'passed', cutAlignment: 'passed', kissCut: 'passed',
  printQuality: { status: 'failed', cause: 'printer_ribbon_registration' }, disposition: 'locked_no_resend',
};
const qc: RibbonRegistrationQc = {
  recordVersion: 1, evidenceHash, recordedAt: timestamp,
  channels: { cyan: 'uncertain', magenta: 'fail', yellow: 'pass' },
  evidence: [{ kind: 'operator_note', reference: 'Synthetic journal test' }], notes: null,
};

const directories: string[] = [];
const journals: { close(): void }[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function journalFile(completed = true) {
  const directory = await mkdtemp(join(tmpdir(), 'natcut-physical-qc-test-'));
  directories.push(directory);
  const file = join(directory, 'synthetic.sqlite');
  const journal = new SqliteTransportAttemptJournal(file);
  try {
    if (completed) {
      expect(journal.reserve(evidence, evidenceHash)).toBe(true);
      journal.recordPrinterJobId(submissionId, evidenceHash, printerJobId);
      for (const [sequence, kind] of (['plt', 'plt', 'jpeg', 'jpeg'] as const).entries()) {
        journal.recordFrameIntent(submissionId, evidenceHash, sequence, kind, sequence % 2);
        journal.recordFrameAcknowledged(submissionId, evidenceHash, sequence);
      }
      journal.markReconciliation(submissionId, evidenceHash, 'physical_observation_required');
    }
  } finally {
    journal.close();
  }
  return file;
}

function openQc(file: string) {
  const journal = new SqlitePhysicalQcJournal(file);
  journals.push(journal);
  return journal;
}

function editFixture(file: string, sql: string, ...values: (string | number | null)[]) {
  const db = new Database(file);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

function expectLocked(file: string) {
  const journal = new SqliteTransportAttemptJournal(file);
  try {
    expect(journal.reserve(evidence, evidenceHash)).toBe(false);
    const next = { ...evidence, submissionId: 'other-submission' };
    expect(journal.reserve(next, hash(JSON.stringify(next)))).toBe(false);
  } finally {
    journal.close();
  }
}

describe('physical observations on the durable, one-attempt journal', () => {
  it('requires an existing journal and never fabricates an observation for an empty one', async () => {
    const file = await journalFile(false);
    expect(() => openQc(file + '.missing')).toThrow();
    const journal = openQc(file);
    expect(journal.getPhysicalAttemptEvidence()).toBeNull();
    expect(() => journal.recordCompletedAttempt(outcome)).toThrow();
    expect(() => journal.recordRibbonRegistrationQc(qc)).toThrow();
    expect(journal.getPhysicalAttemptEvidence()).toBeNull();
  });

  it('retains only the public transport checkpoint, completed observation, and first CMY record across restart and replay', async () => {
    const file = await journalFile();
    const first = new SqlitePhysicalQcJournal(file);
    const original = first.getPhysicalAttemptEvidence();
    try {
      expect(original).toEqual({
        attempt: {
          evidenceHash, submissionId, printerJobId, acknowledgedFrames: 4,
          phase: 'needs_reconciliation', pendingKind: null, pendingIndex: null, reason: 'physical_observation_required',
        },
        outcome: null, ribbonRegistrationQc: null,
      });
      expect(Object.isFrozen(original!.attempt)).toBe(true);
      expect(() => first.recordRibbonRegistrationQc(qc)).toThrow();
      expect(first.recordCompletedAttempt(outcome)).toEqual(outcome);
      expect(first.recordRibbonRegistrationQc(qc)).toEqual(qc);
    } finally {
      first.close();
    }
    const reopened = openQc(file);
    expect(reopened.recordCompletedAttempt(structuredClone(outcome))).toEqual(outcome);
    expect(reopened.recordRibbonRegistrationQc(structuredClone(qc))).toEqual(qc);
    expect(() => reopened.recordCompletedAttempt({ ...outcome, observedAt: '2026-01-16T13:01:02.345Z' })).toThrow();
    expect(() => reopened.recordRibbonRegistrationQc({ ...qc, notes: 'different' })).toThrow();
    expect(reopened.getPhysicalAttemptEvidence()).toEqual({ ...original, outcome, ribbonRegistrationQc: qc });
    expect(JSON.stringify(reopened.getPhysicalAttemptEvidence())).not.toContain(evidence.executionToken);
    expectLocked(file);
  });

  it('seals the completed transport checkpoint against stale processes and direct SQLite mutations', async () => {
    const file = await journalFile();
    const legacy = new SqliteTransportAttemptJournal(file);
    journals.push(legacy);
    const journal = openQc(file);
    journal.recordCompletedAttempt(outcome);
    const original = journal.getPhysicalAttemptEvidence();
    expect(() => legacy.markReconciliation(submissionId, evidenceHash, 'pacing_outcome_unknown')).toThrow();
    expect(() => legacy.markReconciliation(submissionId, evidenceHash, 'physical_observation_required')).toThrow();
    expect(() => legacy.recordPrinterJobId(submissionId, evidenceHash, printerJobId)).toThrow();
    expect(() => legacy.recordFrameIntent(submissionId, evidenceHash, 4, 'jpeg', 2)).toThrow();
    expect(() => legacy.recordFrameAcknowledged(submissionId, evidenceHash, 4)).toThrow();
    expect(() => editFixture(file, 'UPDATE transport_attempts SET acknowledgedFrames = 3')).toThrow();
    expect(() => editFixture(file, 'DELETE FROM transport_attempts')).toThrow();
    expect(() => editFixture(file,
      'INSERT OR REPLACE INTO transport_attempts SELECT * FROM transport_attempts')).toThrow();
    expect(journal.getPhysicalAttemptEvidence()).toEqual(original);
    expectLocked(file);
    expect(journal.recordRibbonRegistrationQc(qc)).toEqual(qc);
  });

  it('preserves both observations and the fence against direct changes to their tables', async () => {
    const file = await journalFile();
    const journal = openQc(file);
    journal.recordCompletedAttempt(outcome);
    journal.recordRibbonRegistrationQc(qc);
    const original = journal.getPhysicalAttemptEvidence();
    for (const table of ['physical_attempt_outcomes', 'ribbon_registration_qc']) {
      expect(() => editFixture(file, 'UPDATE ' + table + " SET recordJson = '{}'")).toThrow();
      expect(() => editFixture(file, 'DELETE FROM ' + table)).toThrow();
      expect(() => editFixture(file, 'INSERT OR REPLACE INTO ' + table + ' SELECT * FROM ' + table)).toThrow();
    }
    expect(() => editFixture(file, 'INSERT OR REPLACE INTO transport_attempts ' +
      '(rowid, submissionId, evidenceHash, evidenceJson, phase, printerJobId, acknowledgedFrames, pendingKind, pendingIndex, reason) ' +
      "SELECT rowid, 'other', evidenceHash, evidenceJson, phase, printerJobId, acknowledgedFrames, pendingKind, pendingIndex, reason " +
      'FROM transport_attempts')).toThrow();
    expect(journal.getPhysicalAttemptEvidence()).toEqual(original);
    expectLocked(file);
  });

  it('allows earlier journal checkpoints after migration until an outcome is recorded', async () => {
    const file = await journalFile(false);
    const journal = openQc(file);
    const legacy = new SqliteTransportAttemptJournal(file);
    journals.push(legacy);
    expect(legacy.reserve(evidence, evidenceHash)).toBe(true);
    legacy.recordPrinterJobId(submissionId, evidenceHash, printerJobId);
    legacy.recordFrameIntent(submissionId, evidenceHash, 0, 'plt', 0);
    legacy.recordFrameAcknowledged(submissionId, evidenceHash, 0);
    legacy.markReconciliation(submissionId, evidenceHash, 'pacing_outcome_unknown');
    expect(journal.getPhysicalAttemptEvidence()).toMatchObject({
      attempt: { phase: 'needs_reconciliation', acknowledgedFrames: 1, reason: 'pacing_outcome_unknown' },
      outcome: null, ribbonRegistrationQc: null,
    });
  });

  it.each([
    ['job ID', 'printerJobId = 38'],
    ['absent job ID', 'printerJobId = NULL'],
    ['incomplete upload', 'acknowledgedFrames = 3'],
    ['excess frames', 'acknowledgedFrames = 5'],
    ['pending frame', "pendingIndex = 0, pendingKind = 'jpeg'"],
    ['wrong phase', "phase = 'frame_acknowledged', reason = NULL"],
    ['other reconciliation', "reason = 'pacing_outcome_unknown'"],
  ])('cannot record completion over a %s', async (_label, changes) => {
    const file = await journalFile();
    editFixture(file, 'UPDATE transport_attempts SET ' + changes);
    const journal = openQc(file);
    expect(() => journal.recordCompletedAttempt(outcome)).toThrow();
    expect(() => journal.recordRibbonRegistrationQc(qc)).toThrow();
    expectLocked(file);
  });

  it('checks every claimed identity and rejects unknown or noncanonical fields', async () => {
    const file = await journalFile();
    const journal = openQc(file);
    const badOutcomes = [
      { ...outcome, submissionId: 'other' }, { ...outcome, printerJobId: printerJobId + 1 },
      { ...outcome, evidenceHash: hash('other') }, { ...outcome, observedAt: '2026-01-15T13:01:02Z' },
      { ...outcome, observedAt: '2026-02-30T13:01:02.345Z' },
      { ...outcome, acknowledgedFrames: 4 }, { ...outcome, disposition: 'retry' },
      { ...outcome, printQuality: { status: 'failed', cause: 'generation_failure' } },
    ];
    for (const record of badOutcomes) expect(() => journal.recordCompletedAttempt(record)).toThrow();
    expect(journal.getPhysicalAttemptEvidence()?.outcome).toBeNull();
    journal.recordCompletedAttempt(outcome);
    const badQcs = [
      { ...qc, channels: { ...qc.channels, cyan: 'passed' } },
      { ...qc, channels: { cyan: 'pass', magenta: 'fail' } },
      { ...qc, overall: 'pass' }, { ...qc, evidenceHash: hash('other') },
      { ...qc, recordedAt: '2026-01-15' }, { ...qc, notes: 'x'.repeat(2001) },
      { ...qc, evidence: Array(9).fill(qc.evidence[0]) },
      { ...qc, evidence: [{ kind: 'photo_reference', reference: 'x'.repeat(513) }] },
      { ...qc, evidence: [{ kind: 'upload_bytes', reference: 'test' }] },
    ];
    for (const record of badQcs) expect(() => journal.recordRibbonRegistrationQc(record)).toThrow();
    expect(journal.getPhysicalAttemptEvidence()?.ribbonRegistrationQc).toBeNull();
    expectLocked(file);
  });

  it.each([
    ['digest', false, { ...evidence, workerId: 'different' }],
    ['foreign submission', true, { ...evidence, submissionId: 'other' }],
    ['zero length', true, { ...evidence, plt: { ...evidence.plt, byteLength: 0 } }],
    ['invalid digest', true, { ...evidence, jpeg: { ...evidence.jpeg, sha256: 'abc' } }],
    ['empty token', true, { ...evidence, executionToken: '' }],
    ['invalid receipt', true, { ...evidence, receipt: { ...evidence.receipt, generation: '0' } }],
    ['unexpected field', true, { ...evidence, ready: true }],
  ] as const)('rejects malformed stored transport evidence (%s) on reads and writes', async (_label, rehash, change) => {
    const file = await journalFile();
    const json = JSON.stringify(change);
    const storedHash = rehash ? hash(json) : evidenceHash;
    editFixture(file, 'UPDATE transport_attempts SET evidenceJson = ?, evidenceHash = ?', json, storedHash);
    const journal = openQc(file);
    expect(() => journal.getPhysicalAttemptEvidence()).toThrow();
    expect(() => journal.recordCompletedAttempt({ ...outcome, evidenceHash: storedHash })).toThrow();
    expectLocked(file);
  });

  it.each([
    ['nested duplicate JPEG lengths', '"jpeg":{"byteLength":8142', '"jpeg":{"byteLength":1,"byteLength":8142'],
    ['alternate number encoding', '"byteLength":8142', '"byteLength":8142.0'],
    ['alternate escape', '"fixture-token"', '"fixture-\\u0074oken"'],
    ['extraneous whitespace', '"submissionId":', '"submissionId": '],
  ] as const)('rejects stored transport JSON with %s, even with a matching raw digest', async (_case, before, after) => {
    const file = await journalFile();
    const journal = openQc(file);
    const raw = JSON.stringify(evidence).replace(before, after);
    expect(raw).not.toEqual(JSON.stringify(evidence));
    const storedHash = hash(raw);
    const matchingOutcome = { ...outcome, evidenceHash: storedHash };
    editFixture(file, 'UPDATE transport_attempts SET evidenceJson = ?, evidenceHash = ?', raw, storedHash);
    editFixture(file, 'INSERT INTO physical_attempt_outcomes (submissionId, recordJson) VALUES (?, ?)',
      submissionId, JSON.stringify(matchingOutcome));
    expect(() => journal.getPhysicalAttemptEvidence()).toThrow();
    expect(() => journal.recordCompletedAttempt(matchingOutcome)).toThrow();
    expect(() => journal.recordRibbonRegistrationQc({ ...qc, evidenceHash: storedHash })).toThrow();
    expectLocked(file);
  });

  it('verifies the pinned digest of the original bytes when unique transport fields are reordered', async () => {
    const file = await journalFile();
    const journal = openQc(file);
    const { submissionId: id, ...rest } = evidence;
    const reordered = JSON.stringify({ ...rest, submissionId: id });
    expect(JSON.parse(reordered)).toEqual(evidence);
    expect(hash(reordered)).not.toBe(evidenceHash);
    editFixture(file, 'UPDATE transport_attempts SET evidenceJson = ?', reordered);
    expect(() => journal.getPhysicalAttemptEvidence()).toThrow(/digest mismatch/);
    expect(() => journal.recordCompletedAttempt(outcome)).toThrow(/digest mismatch/);
    expect(() => journal.recordRibbonRegistrationQc(qc)).toThrow(/digest mismatch/);
    expectLocked(file);
  });

  it.each([
    ['physical_attempt_outcomes', '"printerJobId":37', '"printerJobId":12,"printerJobId":37'],
    ['ribbon_registration_qc', '"evidenceHash":', '"evidenceHash":"' + hash('stale') + '","evidenceHash":'],
    ['ribbon_registration_qc', '"magenta":"fail"', '"magenta":"pass","magenta":"fail"'],
  ] as const)('rejects conflicting observation fields in %s (%s) for reads and both appends', async (table, before, after) => {
    const file = await journalFile();
    const journal = openQc(file);
    if (table === 'ribbon_registration_qc') journal.recordCompletedAttempt(outcome);
    const json = JSON.stringify(table === 'physical_attempt_outcomes' ? outcome : qc);
    const raw = json.replace(before, after);
    expect(raw).not.toEqual(json);
    editFixture(file, 'INSERT INTO ' + table + ' (submissionId, recordJson) VALUES (?, ?)', submissionId, raw);
    expect(() => journal.getPhysicalAttemptEvidence()).toThrow();
    expect(() => journal.recordCompletedAttempt(outcome)).toThrow();
    expect(() => journal.recordRibbonRegistrationQc(qc)).toThrow();
    expectLocked(file);
  });

  it.each(['physical_attempt_outcomes', 'ribbon_registration_qc'])('rejects a corrupt %s row even on retries', async table => {
    const file = await journalFile();
    const journal = openQc(file);
    if (table === 'ribbon_registration_qc') journal.recordCompletedAttempt(outcome);
    editFixture(file, 'INSERT INTO ' + table + ' (submissionId, recordJson) VALUES (?, ?)', submissionId, '{"recordVersion":10}');
    expect(() => journal.getPhysicalAttemptEvidence()).toThrow();
    expect(() => journal.recordCompletedAttempt(outcome)).toThrow();
    expect(() => journal.recordRibbonRegistrationQc(qc)).toThrow();
    expectLocked(file);
  });

  it('derives fail, uncertain, and pass from all three channels', () => {
    expect(deriveRibbonRegistrationStatus(qc.channels)).toBe('fail');
    expect(deriveRibbonRegistrationStatus({ cyan: 'pass', magenta: 'pass', yellow: 'uncertain' })).toBe('uncertain');
    expect(deriveRibbonRegistrationStatus({ cyan: 'pass', magenta: 'pass', yellow: 'pass' })).toBe('pass');
  });

  it('converges identical and competing inserts from concurrent, independent SQLite connections', async () => {
    const file = await journalFile();
    const script = `
      import { SqlitePhysicalQcJournal } from '@natcut/printer/physical-qc';
      const [file, method, json] = process.argv.slice(1);
      const journal = new SqlitePhysicalQcJournal(file);
      try { console.log(JSON.stringify(journal[method](JSON.parse(json)))); }
      catch { console.log('null'); }
      finally { journal.close(); }
    `;
    async function race(method: string, records: (PhysicalAttemptOutcome | RibbonRegistrationQc)[]) {
      return Promise.all(records.map(async record => {
        const { stdout } = await promisify(execFile)(process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, file, method, JSON.stringify(record)]);
        return JSON.parse(stdout);
      }));
    }
    const secondOutcome = { ...outcome, observedAt: '2026-01-20T13:01:02.345Z' };
    const competing = [outcome, secondOutcome, outcome, secondOutcome];
    const writes = await race('recordCompletedAttempt', competing);
    const journal = openQc(file);
    const stored = journal.getPhysicalAttemptEvidence()!.outcome;
    expect(competing).toContainEqual(stored);
    expect(writes).toEqual(competing.map(record => record.observedAt === stored!.observedAt ? stored : null));
    const secondQc = { ...qc, notes: 'different evidence' };
    const qcRecords = [qc, qc, secondQc, secondQc];
    const qcWrites = await race('recordRibbonRegistrationQc', qcRecords);
    const storedQc = journal.getPhysicalAttemptEvidence()!.ribbonRegistrationQc;
    expect(qcRecords).toContainEqual(storedQc);
    expect(qcWrites).toEqual(qcRecords.map(record => record.notes === storedQc!.notes ? storedQc : null));
    expectLocked(file);
  });
});
