import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVFEST_SG_V1, printProfileHashSync } from '@natcut/domain';
import type { PreparedPhysicalArtifacts } from '../src/artifacts.ts';
import {
  SqliteTransportAttemptJournal,
  runTransportAttempt,
  type TransportAttemptBinding,
  type TransportAttemptEvidence,
  type TransportMutationPort,
} from '../src/transport-attempt.ts';

const temporaryDirectories: string[] = [];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function prepared(): PreparedPhysicalArtifacts {
  const jpeg = new Uint8Array([255, 216, 1, 2, 255, 217]);
  const plt = new TextEncoder().encode('IN VER0.1.0 KP42 U1,1 D1,1 D2,2 U6476,0  @ ');
  return {
    receipt: {
      generation: '7',
      descriptor: {
        formatVersion: 1,
        profile: DEVFEST_SG_V1,
        width: 1200,
        height: 2100,
        renderVersion: 'server-raster-v1',
        geometryVersion: 'geometry-v1',
        colorByteLength: 10_080_000,
        colorSha256: 'a'.repeat(64),
        maskByteLength: 2_520_000,
        maskSha256: 'c'.repeat(64),
        byteLength: 12_600_000,
        bundleSha256: 'b'.repeat(64),
        profileSha256: printProfileHashSync(DEVFEST_SG_V1),
      },
    },
    profile: DEVFEST_SG_V1,
    jpeg,
    jpegSha256: sha256(jpeg),
    jpegQuality: 95,
    plt,
    pltSha256: sha256(plt),
    sourceMaskSha256: 'c'.repeat(64),
    cutStats: { pathCount: 1, pointCount: 2, cutLengthMm: 1, travelLengthMm: 0 },
  };
}

function multiFramePrepared(): PreparedPhysicalArtifacts {
  const artifact = prepared();
  artifact.plt = new TextEncoder().encode(
    `IN VER0.1.0 KP42 U1,1 ${'D2,2 '.repeat(900)}U6476,0  @ `,
  );
  artifact.pltSha256 = sha256(artifact.plt);
  return artifact;
}

function binding(artifact = prepared()): TransportAttemptBinding {
  return {
    submissionId: 'submission-1',
    eventId: 'event-1',
    workerId: 'worker-1',
    executionToken: 'execution-token-1',
    manifestHash: 'd'.repeat(64),
    receipt: artifact.receipt,
  };
}

async function journalPath() {
  const directory = await mkdtemp(path.join(tmpdir(), 'natcut-transport-attempt-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'attempt.sqlite');
}

function scriptedTransport(options: {
  jobId?: unknown;
  declareError?: Error;
  failFrame?: { kind: 'plt' | 'jpeg'; index: number };
  onFrame?: (kind: 'plt' | 'jpeg', index: number, frame: Uint8Array) => void;
} = {}) {
  const events: string[] = [];
  const frames: Array<{ kind: 'plt' | 'jpeg'; index: number; frame: Uint8Array }> = [];
  const transport: TransportMutationPort = {
    async declareCombo() {
      events.push('declare');
      if (options.declareError) throw options.declareError;
      return { jobId: Object.hasOwn(options, 'jobId') ? options.jobId : 23 };
    },
    async sendFrameAndWaitForAck(input) {
      events.push(`frame:${input.kind}:${input.index}`);
      frames.push({ kind: input.kind, index: input.index, frame: new Uint8Array(input.frame) });
      options.onFrame?.(input.kind, input.index, input.frame);
      if (options.failFrame?.kind === input.kind && options.failFrame.index === input.index) {
        throw new Error('private device response');
      }
    },
  };
  return { transport, events, frames };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SqliteTransportAttemptJournal', () => {
  it.each([
    ['empty', () => ''],
    ['whitespace-only', () => '   '],
    ['in-memory', () => ':memory:'],
    ['padded in-memory', () => ' :memory: '],
    ['relative', (file: string) => path.relative(process.cwd(), file)],
    ['SQLite memory URI', (file: string) => `file:${file}?mode=memory&cache=shared`],
    ['SQLite file URI', (file: string) => `file:${file}?mode=rwc`],
  ] as const)('rejects a %s database path before it can reserve an attempt', async (_label, candidate) => {
    const file = await journalPath();
    expect(() => new SqliteTransportAttemptJournal(candidate(file)).close()).toThrow(/absolute file path/);
  });

  it('opens the same absolute file in WAL mode across a reopen', async () => {
    const file = await journalPath();
    new SqliteTransportAttemptJournal(file).close();
    const reopened = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(reopened.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      reopened.close();
    }
  });
});

describe('runTransportAttempt', () => {
  it('preflights exact receipt evidence before reserving or touching transport', async () => {
    const artifact = prepared();
    const input = binding(artifact);
    input.receipt = { ...input.receipt, generation: '8' };
    const file = await journalPath();
    const journal = new SqliteTransportAttemptJournal(file);
    const scripted = scriptedTransport();
    const result = await runTransportAttempt(artifact, input, { journal, transport: scripted.transport });
    expect(result).toEqual({ kind: 'preflight_failed', reason: 'evidence_mismatch' });
    expect(scripted.events).toEqual([]);
    expect(journal.get('submission-1')).toBeNull();
    journal.close();
  });

  it.each(['jpeg', 'plt'] as const)('rejects empty %s bytes with a matching digest before reservation', async (kind) => {
    const artifact = prepared();
    artifact[kind] = new Uint8Array();
    artifact[`${kind}Sha256`] = sha256(artifact[kind]);
    const journal = new SqliteTransportAttemptJournal(await journalPath());
    const scripted = scriptedTransport();
    try {
      await expect(runTransportAttempt(artifact, binding(artifact), { journal, transport: scripted.transport }))
        .resolves.toEqual({ kind: 'preflight_failed', reason: 'evidence_mismatch' });
      expect(scripted.events).toEqual([]);
      expect(journal.get('submission-1')).toBeNull();
    } finally {
      journal.close();
    }
  });

  it.each(['missing ID', 'primitive ID', 'null ID', 'hostile binding getter'] as const)(
    'rejects a malformed binding with %s before reservation',
    async (caseName) => {
      const artifact = prepared();
      const input: Record<string, unknown> = binding(artifact);
      if (caseName === 'missing ID') delete input.submissionId;
      if (caseName === 'primitive ID') input.submissionId = 23;
      if (caseName === 'null ID') input.submissionId = null;
      if (caseName === 'hostile binding getter') {
        Object.defineProperty(input, 'submissionId', { get() { throw new Error('private binding diagnostic'); } });
      }
      const journal = new SqliteTransportAttemptJournal(await journalPath());
      const scripted = scriptedTransport();
      try {
        await expect(runTransportAttempt(artifact, input as TransportAttemptBinding, { journal, transport: scripted.transport }))
          .resolves.toEqual({ kind: 'preflight_failed', reason: 'evidence_mismatch' });
        expect(scripted.events).toEqual([]);
        expect(journal.get('submission-1')).toBeNull();
      } finally {
        journal.close();
      }
    },
  );

  it('persists a positive job ID before the first PLT frame and ends held after both payloads', async () => {
    const artifact = prepared();
    const file = await journalPath();
    const journal = new SqliteTransportAttemptJournal(file);
    const events: string[] = [];
    const scripted = scriptedTransport({
      onFrame(kind) {
        const reopened = new SqliteTransportAttemptJournal(file);
        const row = reopened.get('submission-1');
        reopened.close();
        expect(row?.printerJobId).toBe(23);
        expect(row?.phase).toBe('frame_pending');
        expect(row?.acknowledgedFrames).toBe(kind === 'plt' ? 0 : 1);
        events.push(`observed:${kind}`);
      },
    });
    const result = await runTransportAttempt(artifact, binding(artifact), {
      journal,
      transport: scripted.transport,
      pace: async (milliseconds) => { events.push(`pace:${milliseconds}`); },
    });
    expect(result).toEqual({ kind: 'needs_reconciliation', reason: 'physical_observation_required' });
    expect(scripted.events).toEqual(['declare', 'frame:plt:0', 'frame:jpeg:0']);
    expect(events).toEqual(['observed:plt', 'pace:120', 'observed:jpeg', 'pace:120']);
    expect(journal.get('submission-1')).toMatchObject({
      phase: 'needs_reconciliation', printerJobId: 23, acknowledgedFrames: 2,
      reason: 'physical_observation_required',
    });
    const evidence = JSON.parse(journal.get('submission-1')!.evidenceJson);
    expect(evidence).toMatchObject({
      submissionId: 'submission-1', eventId: 'event-1', workerId: 'worker-1',
      executionToken: 'execution-token-1', manifestHash: 'd'.repeat(64),
      receipt: artifact.receipt,
      jpeg: { byteLength: artifact.jpeg.byteLength, sha256: artifact.jpegSha256 },
      plt: { byteLength: artifact.plt.byteLength, sha256: artifact.pltSha256 },
    });
    journal.close();
  });

  it('holds a lost declaration response and never declares again after restart', async () => {
    const artifact = prepared();
    const file = await journalPath();
    const first = new SqliteTransportAttemptJournal(file);
    const lost = scriptedTransport({ declareError: new Error('timeout after write') });
    expect(await runTransportAttempt(artifact, binding(artifact), { journal: first, transport: lost.transport }))
      .toEqual({ kind: 'needs_reconciliation', reason: 'declaration_outcome_unknown' });
    first.close();
    const reopened = new SqliteTransportAttemptJournal(file);
    const retry = scriptedTransport();
    expect(await runTransportAttempt(artifact, binding(artifact), { journal: reopened, transport: retry.transport }))
      .toEqual({ kind: 'needs_reconciliation', reason: 'attempt_already_reserved' });
    expect(retry.events).toEqual([]);
    reopened.close();
  });

  it('uses the reserved identity even when the caller changes the binding during declaration', async () => {
    const artifact = prepared();
    const input = binding(artifact);
    const journal = new SqliteTransportAttemptJournal(await journalPath());
    const scripted = scriptedTransport();
    const declaration = Promise.withResolvers<unknown>();
    const transport: TransportMutationPort = {
      ...scripted.transport,
      declareCombo() {
        scripted.events.push('declare');
        return declaration.promise;
      },
    };
    try {
      const pending = runTransportAttempt(artifact, input, { journal, transport, pace: async () => undefined });
      expect(journal.get('submission-1')).toMatchObject({ phase: 'declaring' });
      input.submissionId = 'submission-2';
      declaration.resolve({ jobId: 23 });
      await expect(pending).resolves.toEqual({ kind: 'needs_reconciliation', reason: 'physical_observation_required' });
      expect(scripted.events).toEqual(['declare', 'frame:plt:0', 'frame:jpeg:0']);
      expect(journal.get('submission-1')).toMatchObject({ printerJobId: 23, acknowledgedFrames: 2, phase: 'needs_reconciliation' });
      expect(journal.get('submission-2')).toBeNull();
    } finally {
      journal.close();
    }
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, Number.NaN, '23', null, {}, { jobId: 23 }])(
    'holds invalid declaration job ID %j without sending data',
    async (jobId) => {
      const artifact = prepared();
      const journal = new SqliteTransportAttemptJournal(await journalPath());
      const scripted = scriptedTransport({ jobId });
      expect(await runTransportAttempt(artifact, binding(artifact), { journal, transport: scripted.transport }))
        .toEqual({ kind: 'needs_reconciliation', reason: 'printer_job_id_invalid' });
      expect(scripted.events).toEqual(['declare']);
      expect(journal.get('submission-1')).toMatchObject({ phase: 'needs_reconciliation', printerJobId: null });
      journal.close();
    },
  );

  it.each(['throwing getter', 'throwing enumeration'] as const)(
    'holds a malformed declaration reply with %s without exposing its diagnostic',
    async (caseName) => {
      const artifact = prepared();
      const journal = new SqliteTransportAttemptJournal(await journalPath());
      const scripted = scriptedTransport();
      const reply = caseName === 'throwing getter'
        ? { get jobId() { throw new Error('private device response'); } }
        : new Proxy({ jobId: 23 }, { ownKeys() { throw new Error('private device response'); } });
      const transport: TransportMutationPort = {
        ...scripted.transport,
        async declareCombo() {
          scripted.events.push('declare');
          return reply;
        },
      };
      try {
        await expect(runTransportAttempt(artifact, binding(artifact), { journal, transport }))
          .resolves.toEqual({ kind: 'needs_reconciliation', reason: 'printer_job_id_invalid' });
        expect(journal.get('submission-1')).toMatchObject({ phase: 'needs_reconciliation', reason: 'printer_job_id_invalid' });
        expect(scripted.events).toEqual(['declare']);
      } finally {
        journal.close();
      }
    },
  );

  it('stops before upload when the job ID checkpoint cannot commit', async () => {
    const artifact = prepared();
    const durable = new SqliteTransportAttemptJournal(await journalPath());
    const journal = {
      ...durable,
      reserve: durable.reserve.bind(durable),
      markReconciliation: durable.markReconciliation.bind(durable),
      recordPrinterJobId() { throw new Error('disk unavailable'); },
      recordFrameIntent: durable.recordFrameIntent.bind(durable),
      recordFrameAcknowledged: durable.recordFrameAcknowledged.bind(durable),
    };
    const scripted = scriptedTransport();
    expect(await runTransportAttempt(artifact, binding(artifact), { journal, transport: scripted.transport }))
      .toEqual({ kind: 'needs_reconciliation', reason: 'job_id_persistence_failed' });
    expect(scripted.events).toEqual(['declare']);
    durable.close();
  });

  it('holds an acknowledgement loss, records only prior acknowledgements, and never resumes', async () => {
    const artifact = prepared();
    const file = await journalPath();
    const journal = new SqliteTransportAttemptJournal(file);
    const scripted = scriptedTransport({ failFrame: { kind: 'jpeg', index: 0 } });
    expect(await runTransportAttempt(artifact, binding(artifact), { journal, transport: scripted.transport }))
      .toEqual({ kind: 'needs_reconciliation', reason: 'frame_acknowledgement_unknown' });
    expect(journal.get('submission-1')).toMatchObject({
      phase: 'needs_reconciliation', acknowledgedFrames: 1, pendingKind: 'jpeg', pendingIndex: 0,
    });
    journal.close();
    const reopened = new SqliteTransportAttemptJournal(file);
    const retry = scriptedTransport();
    await runTransportAttempt(artifact, binding(artifact), { journal: reopened, transport: retry.transport });
    expect(retry.events).toEqual([]);
    reopened.close();
  });

  it.each([
    ['recordFrameIntent', 'frame_checkpoint_failed', []],
    ['recordFrameAcknowledged', 'acknowledgement_checkpoint_failed', ['frame:plt:0']],
  ] as const)('holds a failed %s checkpoint without advancing', async (method, reason, expectedFrames) => {
    const artifact = prepared();
    const durable = new SqliteTransportAttemptJournal(await journalPath());
    const journal = {
      reserve: durable.reserve.bind(durable),
      recordPrinterJobId: durable.recordPrinterJobId.bind(durable),
      recordFrameIntent: method === 'recordFrameIntent'
        ? () => { throw new Error('checkpoint unavailable'); }
        : durable.recordFrameIntent.bind(durable),
      recordFrameAcknowledged: method === 'recordFrameAcknowledged'
        ? () => { throw new Error('checkpoint unavailable'); }
        : durable.recordFrameAcknowledged.bind(durable),
      markReconciliation: durable.markReconciliation.bind(durable),
    };
    const scripted = scriptedTransport();
    expect(await runTransportAttempt(artifact, binding(artifact), { journal, transport: scripted.transport }))
      .toEqual({ kind: 'needs_reconciliation', reason });
    expect(scripted.events.filter((event) => event.startsWith('frame:'))).toEqual(expectedFrames);
    durable.close();
  });

  it('holds a pacing failure after the acknowledged frame and sends no next frame', async () => {
    const artifact = prepared();
    const journal = new SqliteTransportAttemptJournal(await journalPath());
    const scripted = scriptedTransport();
    expect(await runTransportAttempt(artifact, binding(artifact), {
      journal,
      transport: scripted.transport,
      pace: async () => { throw new Error('interrupted wait'); },
    })).toEqual({ kind: 'needs_reconciliation', reason: 'pacing_outcome_unknown' });
    expect(scripted.events).toEqual(['declare', 'frame:plt:0']);
    expect(journal.get('submission-1')).toMatchObject({ acknowledgedFrames: 1, reason: 'pacing_outcome_unknown' });
    journal.close();
  });

  it('copies payloads before declaration so later caller mutation cannot change framed bytes', async () => {
    const artifact = prepared();
    const original = { plt: new Uint8Array(artifact.plt), jpeg: new Uint8Array(artifact.jpeg) };
    const journal = new SqliteTransportAttemptJournal(await journalPath());
    const scripted = scriptedTransport({ jobId: 31 });
    const transport: TransportMutationPort = {
      ...scripted.transport,
      declareCombo(declaration) {
        artifact.plt.fill(0);
        artifact.jpeg.fill(0);
        return scripted.transport.declareCombo(declaration);
      },
    };
    try {
      await expect(runTransportAttempt(artifact, binding(artifact), { journal, transport, pace: async () => undefined }))
        .resolves.toEqual({ kind: 'needs_reconciliation', reason: 'physical_observation_required' });
      expect(scripted.events).toEqual(['declare', 'frame:plt:0', 'frame:jpeg:0']);
      for (const { kind, frame } of scripted.frames) {
        const newline = frame.indexOf(10);
        expect(frame.subarray(newline + 5)).toEqual(original[kind]);
      }
    } finally {
      journal.close();
    }
  });

  it.each(['declaring', 'declared', 'frame_pending', 'frame_acknowledged'] as const)(
    'preserves raw %s across reopen and blocks all later transport calls',
    async (phase) => {
      const artifact = prepared();
      const evidence = {
        ...binding(artifact),
        jpeg: { byteLength: artifact.jpeg.byteLength, sha256: artifact.jpegSha256 },
        plt: { byteLength: artifact.plt.byteLength, sha256: artifact.pltSha256 },
      } satisfies TransportAttemptEvidence;
      const evidenceHash = sha256(new TextEncoder().encode(JSON.stringify(evidence)));
      const { submissionId } = evidence;
      const file = await journalPath();
      const first = new SqliteTransportAttemptJournal(file);
      try {
        expect(first.reserve(evidence, evidenceHash)).toBe(true);
        if (phase !== 'declaring') first.recordPrinterJobId(submissionId, evidenceHash, 23);
        if (phase === 'frame_pending' || phase === 'frame_acknowledged') {
          first.recordFrameIntent(submissionId, evidenceHash, 0, 'plt', 0);
        }
        if (phase === 'frame_acknowledged') first.recordFrameAcknowledged(submissionId, evidenceHash, 0);
      } finally {
        first.close();
      }

      const reopened = new SqliteTransportAttemptJournal(file);
      const scripted = scriptedTransport();
      try {
        const saved = reopened.get(submissionId);
        expect(saved?.phase).toBe(phase);
        const inputs = [binding(artifact), { ...binding(artifact), submissionId: 'submission-2' }];
        for (const input of inputs) {
          await expect(runTransportAttempt(artifact, input, { journal: reopened, transport: scripted.transport }))
            .resolves.toEqual({ kind: 'needs_reconciliation', reason: 'attempt_already_reserved' });
        }
        expect(scripted.events).toEqual([]);
        expect(reopened.get(submissionId)).toEqual(saved);
        expect(reopened.get('submission-2')).toBeNull();
      } finally {
        reopened.close();
      }
    },
  );

  it('allows only one concurrent reservation and one declaration', async () => {
    const artifact = prepared();
    const file = await journalPath();
    const first = new SqliteTransportAttemptJournal(file);
    const second = new SqliteTransportAttemptJournal(file);
    const scripted = scriptedTransport({ declareError: new Error('stop') });
    const results = await Promise.all([
      runTransportAttempt(artifact, binding(artifact), { journal: first, transport: scripted.transport }),
      runTransportAttempt(artifact, binding(artifact), { journal: second, transport: scripted.transport }),
    ]);
    expect(scripted.events).toEqual(['declare']);
    expect(results.map((result) => result.kind)).toEqual(['needs_reconciliation', 'needs_reconciliation']);
    first.close();
    second.close();
  });

  it('serializes different submissions behind the one reserved printer attempt', async () => {
    const artifact = prepared();
    const file = await journalPath();
    const first = new SqliteTransportAttemptJournal(file);
    const second = new SqliteTransportAttemptJournal(file);
    const next = binding(artifact);
    next.submissionId = 'submission-2';
    const scripted = scriptedTransport({ declareError: new Error('stop') });
    const results = await Promise.all([
      runTransportAttempt(artifact, binding(artifact), { journal: first, transport: scripted.transport }),
      runTransportAttempt(artifact, next, { journal: second, transport: scripted.transport }),
    ]);
    expect(scripted.events).toEqual(['declare']);
    expect(results.map((result) => result.kind)).toEqual(['needs_reconciliation', 'needs_reconciliation']);
    expect([first.get('submission-1'), first.get('submission-2')].filter(Boolean)).toHaveLength(1);
    first.close();
    second.close();
  });

  it('persists acknowledgement of one PLT frame before sending the next PLT frame', async () => {
    const artifact = multiFramePrepared();
    const file = await journalPath();
    const journal = new SqliteTransportAttemptJournal(file);
    const observations: number[] = [];
    const scripted = scriptedTransport({
      onFrame(kind, index) {
        if (kind !== 'plt') return;
        const reopened = new SqliteTransportAttemptJournal(file);
        observations.push(reopened.get('submission-1')!.acknowledgedFrames);
        reopened.close();
        expect(index).toBe(observations.length - 1);
      },
    });
    await runTransportAttempt(artifact, binding(artifact), {
      journal,
      transport: scripted.transport,
      pace: async () => undefined,
    });
    expect(scripted.events.slice(0, 3)).toEqual(['declare', 'frame:plt:0', 'frame:plt:1']);
    expect(observations).toEqual([0, 1]);
    journal.close();
  });

  it('does no I/O when the reserved submission is presented with stale evidence', async () => {
    const artifact = prepared();
    const file = await journalPath();
    const first = new SqliteTransportAttemptJournal(file);
    await runTransportAttempt(artifact, binding(artifact), {
      journal: first,
      transport: scriptedTransport({ declareError: new Error('lost') }).transport,
    });
    first.close();
    const stale = binding(artifact);
    stale.workerId = 'stale-worker';
    const reopened = new SqliteTransportAttemptJournal(file);
    const scripted = scriptedTransport();
    expect(await runTransportAttempt(artifact, stale, { journal: reopened, transport: scripted.transport }))
      .toEqual({ kind: 'needs_reconciliation', reason: 'attempt_already_reserved' });
    expect(scripted.events).toEqual([]);
    reopened.close();
  });
});
