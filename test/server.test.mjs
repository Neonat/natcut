import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createServer } from '../src/server.mjs';

async function withServer(getSnapshot, run) {
  const server = createServer({ getSnapshot });
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
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test('serves the operator page with one read-only refresh action', async () => {
  await withServer(async () => snapshot, async (baseUrl) => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(html, /<button[^>]+id="refresh"/);
    assert.doesNotMatch(html, /Print\s*&?\s*Cut|Start job|Cancel job/i);
  });
});
