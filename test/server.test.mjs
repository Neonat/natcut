import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { SqlitePhysicalQcJournal } from '@natcut/printer/physical-qc';
import { buildPhysicalProof } from '../packages/printer/src/physical-proof.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { DEVFEST_SG_V1 as profile, printProfileHashSync } from '@natcut/domain';
import { SqliteTransportAttemptJournal } from '@natcut/printer/transport-attempt';
import { createPhysicalProofRuntime } from '../src/physical-proof-runtime.mjs';
import { test } from 'node:test';

import { createServer } from '../src/server.mjs';

async function withServer(getSnapshot, run, options = {}) {
  const server = createServer({ getSnapshot, getPhysicalAttemptEvidence: () => null, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const proofSummary = {
  approvalFingerprint: 'a'.repeat(64),
  media: '4x7 Liene adhesive photo paper',
  profileId: 'devfest-sg-v1',
  knifePressure: 42,
  copies: 1,
  stickerCount: 6,
  raster: { width: 1216, height: 2128 },
  jpeg: { byteLength: 1234, sha256: 'b'.repeat(64) },
  plt: { byteLength: 567, sha256: 'c'.repeat(64) },
};

const snapshot = {
  identity: {
    model: 'DHP700',
    sku: 'DHP700W#EU1',
    'firmware-revision': '1.0.15_0054',
    'hardware-revision': 'x05',
    'media-size': 5009,
  },
  status: { state: 20, sub: 2000, alerts: [], label: 'idle', subLabel: 'idle' },
  activeJobs: [],
};

test('serves health and a successful read-only printer snapshot', async () => {
  await withServer(async () => snapshot, async (baseUrl) => {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, service: 'natcut', mode: 'read-only' });

    const printerResponse = await fetch(`${baseUrl}/api/printer`);
    assert.equal(printerResponse.status, 200);
    assert.deepEqual(await printerResponse.json(), { ok: true, snapshot });
  });
});

test('maps known printer errors to actionable HTTP responses', async (t) => {
  const cases = [
    ['PRINTER_NOT_FOUND', 503, 'not connected'],
    ['PRINTER_BUSY', 409, 'Close Chrome'],
    ['PRINTER_TIMEOUT', 504, 'The printer did not reply before the status request timed out.'],
  ];
  for (const [code, status, message] of cases) {
    await t.test(code, async () => {
      const failure = Object.assign(new Error(message), { code });
      await withServer(async () => { throw failure; }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/printer`);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { ok: false, error: { code, message } });
      });
    });
  }
});

test('rejects mutations and unknown routes', async () => {
  await withServer(async () => snapshot, async (baseUrl) => {
    const mutation = await fetch(`${baseUrl}/api/printer`, { method: 'POST' });
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get('allow'), 'GET');

    const missing = await fetch(`${baseUrl}/api/missing`);
    assert.equal(missing.status, 404);
  });
});

test('serializes concurrent printer snapshots', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const getSnapshot = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return snapshot;
  };

  await withServer(getSnapshot, async (baseUrl) => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/printer`),
      fetch(`${baseUrl}/api/printer`),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
  });
  assert.equal(calls, 1);
  assert.equal(maxActive, 1);
});

test('returns a client error for a malformed absolute request target and remains healthy', async () => {
  await withServer(async () => snapshot, async (baseUrl) => {
    const port = Number(new URL(baseUrl).port);
    const socket = connect({ host: '127.0.0.1', port });
    socket.write('GET http://[::1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { response += chunk; });
    await once(socket, 'end');
    assert.match(response, /HTTP\/1\.1 400/);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
  });
});

test('contains operator page read failures and keeps health online', async () => {
  await withServer(
    async () => snapshot,
    async (baseUrl) => {
      const page = await fetch(baseUrl);
      assert.equal(page.status, 500);
      const health = await fetch(`${baseUrl}/api/health`);
      assert.equal(health.status, 200);
    },
    { readOperatorPage: async () => { throw new Error('disk failure'); } },
  );
});

test('serves the operator page with status, proof preparation, and a disabled-by-default send action', async () => {
  await withServer(async () => snapshot, async (baseUrl) => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(html, /<button[^>]+id="refresh"/);
    assert.match(html, /<button[^>]+id="connect-webusb"/);
    assert.match(html, /<button[^>]+id="prepare-proof"/);
    assert.match(html, /<button[^>]+id="send-proof"[^>]+disabled/);
    assert.match(html, /id="cut-overlay"/);
    assert.match(html, /alt="Preview of the exact prepared 4 by 7 physical proof sheet"/);
    assert.doesNotMatch(html, /Cancel job/i);
  });
});

test('serves the same-origin Chrome WebUSB client module', async () => {
  const module = 'export const marker = "webusb";';
  await withServer(async () => snapshot, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/webusb-client.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.equal(await response.text(), module);
  }, { readWebUsbClient: async () => module });
});

test('prepares and previews one physical proof without invoking the send dependency', async () => {
  let sends = 0;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const cutPreviewSvg = '<svg><path/></svg>';
  await withServer(async () => snapshot, async (baseUrl) => {
    const prepared = await fetch(`${baseUrl}/api/physical-proof/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(prepared.status, 200);
    assert.deepEqual(await prepared.json(), { ok: true, proof: proofSummary, sendEnabled: false });

    const preview = await fetch(`${baseUrl}/api/physical-proof/preview.jpg`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), jpeg);
    const cutPreview = await fetch(`${baseUrl}/api/physical-proof/cut-preview.svg`);
    assert.equal(cutPreview.status, 200);
    assert.equal(cutPreview.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.equal(await cutPreview.text(), cutPreviewSvg);
    assert.equal(sends, 0);
  }, {
    preparePhysicalProof: async () => ({ summary: proofSummary, artifacts: { print: { bytes: jpeg } }, cutPreviewSvg }),
    sendPhysicalProof: async () => { sends += 1; },
    physicalSendEnabled: false,
  });
});

test('keeps physical send disabled until the exact approved fingerprint is configured', async () => {
  let sends = 0;
  await withServer(async () => snapshot, async (baseUrl) => {
    await fetch(`${baseUrl}/api/physical-proof/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const response = await fetch(`${baseUrl}/api/physical-proof/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalFingerprint: proofSummary.approvalFingerprint, confirmation: 'SEND ONE SHEET' }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error.message, /separate approval/i);
    assert.equal(sends, 0);
  }, {
    preparePhysicalProof: async () => ({ summary: proofSummary, artifacts: { print: { bytes: new Uint8Array() } } }),
    sendPhysicalProof: async () => { sends += 1; },
    physicalSendEnabled: false,
  });
});

test('sends one prepared proof only for the exact fingerprint and confirmation phrase', async () => {
  const inputs = [];
  await withServer(async () => snapshot, async (baseUrl) => {
    await fetch(`${baseUrl}/api/physical-proof/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const response = await fetch(`${baseUrl}/api/physical-proof/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalFingerprint: proofSummary.approvalFingerprint, confirmation: 'SEND ONE SHEET' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      result: { kind: 'needs_reconciliation', reason: 'physical_observation_required' },
    });
    assert.deepEqual(inputs, [{ approvalFingerprint: proofSummary.approvalFingerprint, confirmation: 'SEND ONE SHEET' }]);
  }, {
    preparePhysicalProof: async () => ({ summary: proofSummary, artifacts: { print: { bytes: new Uint8Array() } } }),
    sendPhysicalProof: async (input) => {
      inputs.push(input);
      return { kind: 'needs_reconciliation', reason: 'physical_observation_required' };
    },
    physicalSendEnabled: true,
  });
});

test('checkpoints a browser WebUSB attempt through begin, job id, frame, acknowledgement, and finish', async () => {
  const calls = [];
  const browserPhysicalCoordinator = {
    begin(input, proof) {
      calls.push(['begin', input, proof.summary.approvalFingerprint]);
      return { attemptId: 'attempt-1', declaration: { method: 'combo-job', params: [] }, totalFrames: 1 };
    },
    recordJobId(input) { calls.push(['job-id', input]); return { ok: true }; },
    nextFrame(input) { calls.push(['frame', input]); return { sequence: 0, kind: 'plt', index: 0, frame: new Uint8Array([1, 2, 3]) }; },
    acknowledgeFrame(input) { calls.push(['ack', input]); return { ok: true, acknowledgedFrames: 1 }; },
    finish(input) { calls.push(['finish', input]); return { kind: 'needs_reconciliation', reason: 'physical_observation_required' }; },
  };
  await withServer(async () => snapshot, async (baseUrl) => {
    await fetch(`${baseUrl}/api/physical-proof/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const post = (path, body) => fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const begun = await post('/api/physical-proof/browser/begin', {
      approvalFingerprint: proofSummary.approvalFingerprint, confirmation: 'SEND ONE SHEET',
    });
    assert.equal(begun.status, 200);
    assert.equal((await begun.json()).attempt.totalFrames, 1);
    assert.equal((await post('/api/physical-proof/browser/job-id', { attemptId: 'attempt-1', jobId: 44 })).status, 200);
    const frame = await post('/api/physical-proof/browser/frame', { attemptId: 'attempt-1', sequence: 0 });
    assert.deepEqual(await frame.json(), {
      ok: true, frame: { sequence: 0, kind: 'plt', index: 0, base64: 'AQID' },
    });
    assert.equal((await post('/api/physical-proof/browser/ack', { attemptId: 'attempt-1', sequence: 0 })).status, 200);
    const finished = await post('/api/physical-proof/browser/finish', { attemptId: 'attempt-1' });
    assert.equal(finished.status, 409);
    assert.deepEqual((await finished.json()).result, {
      kind: 'needs_reconciliation', reason: 'physical_observation_required',
    });
  }, {
    preparePhysicalProof: async () => ({ summary: proofSummary, artifacts: { print: { bytes: new Uint8Array() } } }),
    browserPhysicalCoordinator,
    physicalSendEnabled: true,
  });
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'job-id', 'frame', 'ack', 'finish']);
});

const stamp = '2026-03-04T05:06:07.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
const submissionId = 'synthetic-proof';
const printerJobId = 32;
const width = profile.sheetWidthPx;
const height = profile.sheetHeightPx;
const pixels = width * height;
const fixtureEvidence = {
  submissionId, eventId: 'synthetic-event', workerId: 'synthetic-worker', executionToken: 'private-test-token',
  manifestHash: digest('manifest'), receipt: { generation: '1', descriptor: {
    formatVersion: 1, width, height, profile, renderVersion: 'test', geometryVersion: 'test',
    colorByteLength: pixels * 4, maskByteLength: pixels, byteLength: pixels * 5,
    colorSha256: digest('color'), maskSha256: digest('mask'), bundleSha256: digest('bundle'),
    profileSha256: printProfileHashSync(profile),
  } }, plt: { byteLength: 100, sha256: digest('plot') }, jpeg: { byteLength: 200, sha256: digest('jpeg') },
};
const evidenceHash = digest(JSON.stringify(fixtureEvidence));
const completed = {
  recordVersion: 1, evidenceHash, submissionId, printerJobId, observedAt: stamp,
  transport: 'passed', cutAlignment: 'passed', kissCut: 'passed',
  printQuality: { status: 'failed', cause: 'printer_ribbon_registration' }, disposition: 'locked_no_resend',
};
const registration = {
  recordVersion: 1, evidenceHash, recordedAt: stamp,
  channels: { cyan: 'uncertain', magenta: 'fail', yellow: 'pass' },
  evidence: [{ kind: 'photo_reference', reference: 'fixture-receipt' }], notes: 'Synthetic inspection',
};

function populatePhysicalFixture(legacy, frames) {
  assert.equal(legacy.reserve(fixtureEvidence, evidenceHash), true);
  legacy.recordPrinterJobId(submissionId, evidenceHash, printerJobId);
  for (let i = 0; i < frames; i++) {
    legacy.recordFrameIntent(submissionId, evidenceHash, i, i === 0 ? 'plt' : 'jpeg', 0);
    legacy.recordFrameAcknowledged(submissionId, evidenceHash, i);
  }
  legacy.markReconciliation(submissionId, evidenceHash, 'physical_observation_required');
}

async function physicalFixture(t, frames = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'natcut-http-qc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'synthetic.sqlite');
  const legacy = new SqliteTransportAttemptJournal(journalPath);
  try {
    populatePhysicalFixture(legacy, frames);
  } finally { legacy.close(); }
  return journalPath;
}

const post = (base, path, input) => fetch(base + '/api/physical-proof/' + path, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: typeof input === 'string' ? input : JSON.stringify(input),
});
const readEvidence = base => fetch(base + '/api/physical-proof/evidence');

test('QC routes retain exact private-journal evidence across server restarts and block every mutation before dependencies', async t => {
  const journalPath = await physicalFixture(t);
  const calls = [];
  const forbidden = () => { calls.push('printer'); throw new Error('Unexpected printer dependency'); };
  const options = () => ({
    ...createPhysicalProofRuntime({ journalPath, approvalFingerprint: 'b'.repeat(64), buildProof: forbidden, openSession: forbidden }),
    browserPhysicalCoordinator: new Proxy({}, { get: () => forbidden }),
  });
  await withServer(forbidden, async base => {
    const original = await readEvidence(base);
    assert.equal(original.status, 200);
    const { evidence } = await original.json();
    assert.equal(evidence.outcome, null);
    assert.equal(evidence.attempt.fullyUploaded, true);
    assert.equal((await post(base, 'physical-qc', registration)).status, 409);
    assert.equal((await post(base, 'record-completed', { ...completed, printerJobId: 33 })).status, 409);
    assert.equal((await post(base, 'record-completed', { ...completed, transport: 'failed' })).status, 400);
    assert.equal((await post(base, 'record-completed', { ...completed, executionToken: 'extra' })).status, 400);
    assert.equal((await post(base, 'record-completed', '{"invalid"')).status, 400);
    assert.equal((await post(base, 'record-completed', JSON.stringify(completed).replace('"printerJobId":32', '"printerJobId":31,"printerJobId":32'))).status, 400);
    // A stale tab may try to replace the completed upload reason before the owner records it.
    assert.equal((await post(base, 'browser/hold', { attemptId: evidenceHash, reason: 'pacing_outcome_unknown' })).status, 409);
    const uploaded = await post(base, 'record-completed', completed);
    assert.equal(uploaded.status, 200);
    assert.deepEqual((await uploaded.json()).record, completed);
    assert.equal((await post(base, 'physical-qc', { ...registration, channels: { ...registration.channels, cyan: 'other' } })).status, 400);
    assert.equal((await post(base, 'physical-qc', { ...registration, notes: 'X'.repeat(2001) })).status, 400);
    assert.equal((await post(base, 'physical-qc', { ...registration, notes: 'X'.repeat(70000) })).status, 400);
    assert.equal((await post(base, 'physical-qc', { ...registration, evidenceHash: digest('stale') })).status, 409);
    assert.equal((await post(base, 'physical-qc', registration)).status, 200);
  }, options());
  await withServer(forbidden, async base => {
    assert.deepEqual((await (await post(base, 'record-completed', completed)).json()).record, completed);
    assert.deepEqual((await (await post(base, 'physical-qc', registration)).json()).record, registration);
    assert.equal((await post(base, 'record-completed', { ...completed, observedAt: '2026-05-06T00:00:00.000Z' })).status, 409);
    assert.equal((await post(base, 'physical-qc', { ...registration, notes: null })).status, 409);
    for (const path of ['send', ...['begin','job-id','frame','ack','finish','hold'].map(action => 'browser/' + action)]) {
      const response = await post(base, path, {});
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).error.code, 'ATTEMPT_LOCKED', path);
    }
    const body = await (await readEvidence(base)).json();
    assert.deepEqual(body.evidence.outcome, completed);
    assert.deepEqual(body.evidence.ribbonRegistrationQc, registration);
    assert.equal(body.ribbonOverall, 'fail');
    assert.doesNotMatch(JSON.stringify(body), /executionToken|private-test-token|evidenceJson/);
  }, options());
  assert.deepEqual(calls, []);
});

test('unavailable journals fail closed and incomplete uploads stay visible without a completion action', async t => {
  const journalPath = await physicalFixture(t, 1);
  for (const file of [undefined, 'relative.sqlite', journalPath + '.missing']) {
    await withServer(assert.fail, async base => {
      for (const response of [await readEvidence(base), await post(base, 'record-completed', completed),
        await post(base, 'physical-qc', registration), await post(base, 'send', {}), await post(base, 'browser/begin', {})]) {
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, 'JOURNAL_UNAVAILABLE');
      }
    }, createPhysicalProofRuntime({ journalPath: file, approvalFingerprint: 'b'.repeat(64), buildProof: assert.fail, openSession: assert.fail }));
  }
  await withServer(assert.fail, async base => {
    assert.equal((await (await readEvidence(base)).json()).evidence.attempt.fullyUploaded, false);
    assert.equal((await post(base, 'record-completed', completed)).status, 409);
  }, createPhysicalProofRuntime({ journalPath }));
});

test('operator records a known observation, reloads the locked UI, and records CMY without printer calls', async t => {
  const journalPath = await physicalFixture(t);
  const requests = [];
  const usbCalls = [];
  const unexpectedUsb = () => { usbCalls.push('webusb'); assert.fail('Unexpected WebUSB call'); };
  const mount = async base => {
    const dom = new JSDOM(await (await fetch(base)).text(), { url: base, runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    const { window } = dom;
    window.fetch = async (path, init) => {
      requests.push(path);
      assert.ok(['/api/physical-proof/evidence','/api/physical-proof/record-completed','/api/physical-proof/physical-qc'].includes(path), path);
      return fetch(base + path, init);
    };
    window.connectWebUsbPrinter = window.supportsWebUsb = unexpectedUsb;
    const script = window.document.querySelector('script[type="module"]').textContent;
    window.eval(script.replace(/^\s*import .*?from '\/webusb-client\.js';/m, ''));
    const byId = id => window.document.getElementById(id);
    const wait = async predicate => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate(), 'expected UI state');
    };
    return { byId, wait, window };
  };
  const options = () => createPhysicalProofRuntime({ journalPath, buildProof: assert.fail, openSession: unexpectedUsb });
  await withServer(assert.fail, async base => {
    const { byId, wait } = await mount(base);
    await wait(() => byId('record-outcome')?.hidden === false);
    byId('observed-at').value = stamp;
    byId('record-completed').click();
    await wait(() => byId('locked-heading')?.textContent === 'Attempt locked. No resend.' && !byId('locked-result').hidden);
    assert.equal(byId('proof-controls').hidden, true);
    assert.equal(byId('connect-webusb').disabled, true);
    assert.equal(byId('send-proof').disabled, true);
    assert.equal(byId('record-outcome').hidden, true);
  }, options());
  await withServer(assert.fail, async base => {
    const { byId, wait } = await mount(base);
    await wait(() => byId('physical-qc-form')?.hidden === false);
    const result = byId('locked-result').textContent;
    for (const field of [/Transport\s*passed/i, /Cut alignment\s*passed/i, /Kiss cut\s*passed/i, /Print quality\s*failed.*ribbon registration/i]) {
      assert.match(result, field);
    }
    byId('magenta').value = 'fail';
    byId('qc-reference').value = 'synthetic physical inspection';
    byId('qc-notes').value = 'slight magenta offset';
    byId('record-qc').click();
    await wait(() => byId('qc-history')?.hidden === false);
    assert.match(byId('qc-history').textContent, /magenta.*fail/i);
    assert.match(byId('qc-history').textContent, /overall.*fail/i);
    assert.match(byId('qc-history').textContent, /slight magenta offset/);
    assert.equal(byId('physical-qc-form').hidden, true);
    assert.equal(byId('send-proof').disabled, true);
  }, options());
  assert.deepEqual(usbCalls, []);
  assert.deepEqual(requests, ['evidence','record-completed','evidence','evidence','physical-qc','evidence'].map(path => '/api/physical-proof/' + path));
});

test('a completed outcome between the HTTP check and direct reservation wins without hardware', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'natcut-final-reserve-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalPath = join(directory, 'synthetic.sqlite');
  new SqliteTransportAttemptJournal(journalPath).close();
  const proof = await buildPhysicalProof();
  const approvalFingerprint = proof.summary.approvalFingerprint;
  const calls = [];
  const options = createPhysicalProofRuntime({
    journalPath, approvalFingerprint, buildProof: () => proof,
    createJournal(file) {
      const rival = new SqliteTransportAttemptJournal(file);
      try { populatePhysicalFixture(rival, 2); } finally { rival.close(); }
      const qc = new SqlitePhysicalQcJournal(file);
      try { qc.recordCompletedAttempt(completed); } finally { qc.close(); }
      return new SqliteTransportAttemptJournal(file);
    },
    openSession() { calls.push('open'); return { io: {}, close() {} }; },
    createTransport() { calls.push('create'); return {}; },
  });
  await withServer(assert.fail, async base => {
    const response = await post(base, 'send', { approvalFingerprint, confirmation: 'SEND ONE SHEET' });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.deepEqual(calls, []);
    assert.equal(body.error.code, 'ATTEMPT_LOCKED');
    assert.deepEqual((await (await readEvidence(base)).json()).evidence.outcome, completed);
  }, options);
});
