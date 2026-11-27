import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { test } from 'node:test';

import { createServer } from '../src/server.mjs';

async function withServer(getSnapshot, run, options = {}) {
  const server = createServer({ getSnapshot, ...options });
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
    preparePhysicalProof: async () => ({ summary: proofSummary, jpeg, cutPreviewSvg }),
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
    preparePhysicalProof: async () => ({ summary: proofSummary, jpeg: new Uint8Array() }),
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
    preparePhysicalProof: async () => ({ summary: proofSummary, jpeg: new Uint8Array() }),
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
    preparePhysicalProof: async () => ({ summary: proofSummary, jpeg: new Uint8Array() }),
    browserPhysicalCoordinator,
    physicalSendEnabled: true,
  });
  assert.deepEqual(calls.map(([name]) => name), ['begin', 'job-id', 'frame', 'ack', 'finish']);
});
