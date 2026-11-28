import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CTRL,
  ReadOnlyPixCut,
  alertCodes,
  frameJson,
  takeJson,
} from '../src/protocol.mjs';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function scriptedIo(respond) {
  const replies = [];
  const requests = [];

  return {
    requests,
    io: {
      async write(endpoint, bytes) {
        assert.equal(endpoint, CTRL.out);
        const text = decoder.decode(bytes);
        const request = JSON.parse(text.slice('cmd json\n'.length));
        requests.push(request);
        const response = respond(request, requests.length);
        if (response !== undefined) {
          const parts = Array.isArray(response) ? response : [response];
          replies.push(...parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)));
        }
      },
      async read(endpoint) {
        assert.equal(endpoint, CTRL.in);
        return encoder.encode(replies.shift() ?? '');
      },
    },
  };
}

test('frames compact JSON after the command line without a trailing newline', () => {
  const framed = frameJson({ id: 7, method: 'get-prop', params: ['model'] });
  assert.equal(decoder.decode(framed), 'cmd json\n{"id":7,"method":"get-prop","params":["model"]}');
});

test('parses split replies with NUL noise and braces inside strings', () => {
  const [first, remainder] = takeJson('noise\0{"id":1,"result":["{x}"]}\0{"id":2,"res');
  assert.deepEqual(first, [{ id: 1, result: ['{x}'] }]);
  const [second, tail] = takeJson(`${remainder}ult":[1]}`);
  assert.deepEqual(second, [{ id: 2, result: [1] }]);
  assert.equal(tail, '');
});

test('parses real device replies whose result precedes the request id', () => {
  const [objects, remainder] = takeJson('{"result":["DHP700"],"id":15824}');
  assert.deepEqual(objects, [{ result: ['DHP700'], id: 15824 }]);
  assert.equal(remainder, '');
});

test('extracts non-zero printer alert codes', () => {
  assert.deepEqual(alertCodes('::0'), []);
  assert.deepEqual(alertCodes(['::5401', '::8102']), [5401, 8102]);
});

test('maps identity, status, alerts and active jobs into one snapshot', async () => {
  const { io, requests } = scriptedIo((request) => {
    if (request.method === 'get-prop' && request.params.includes('model')) {
      return { id: request.id, result: [
        { model: 'DHP700' },
        { sku: 'DHP700W#EU1' },
        { 'firmware-revision': '1.0.15_0054' },
        { 'hardware-revision': 'x05' },
        { 'media-size': 5009 },
      ] };
    }
    if (request.method === 'get-prop') {
      return { id: request.id, result: [
        { 'printer-state': 20 },
        { 'printer-sub-state': 2000 },
        { 'printer-state-alerts': ['::0'] },
      ] };
    }
    return { id: request.id, result: [{ 'job-id': 12 }, 19, 0] };
  });

  const client = new ReadOnlyPixCut(io, { startingId: 100 });
  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot, {
    identity: {
      model: 'DHP700',
      sku: 'DHP700W#EU1',
      'firmware-revision': '1.0.15_0054',
      'hardware-revision': 'x05',
      'media-size': 5009,
    },
    status: {
      state: 20,
      sub: 2000,
      alerts: [],
      label: 'idle',
      subLabel: 'idle',
    },
    activeJobs: [12, 19],
  });
  assert.deepEqual(requests.map(({ id, method }) => ({ id, method })), [
    { id: 100, method: 'get-prop' },
    { id: 101, method: 'get-prop' },
    { id: 102, method: 'get-job-id-list' },
  ]);
});

test('physical idle proof recognizes this PixCut firmware empty job-list shape', async () => {
  const { io } = scriptedIo((request) => {
    if (request.method === 'get-job-id-list') return { id: request.id, result: { 'job-id-list': '' } };
    if (request.params.includes('model')) return { id: request.id, result: ['DHP700', 'DHP700W#EU1', '1.0.31_0074', 'x05', 5009] };
    return { id: request.id, result: ['30', '2000', '::0'] };
  });
  const proof = await new ReadOnlyPixCut(io).physicalIdleProof();
  assert.deepEqual(proof, {
    firmwareShapeVerified: true,
    status: { state: 30, sub: 2000, alerts: [] },
    activeJobs: [],
  });
});

test('physical idle proof rejects malformed job and alert replies instead of treating them as empty', async () => {
  for (const malformed of [null, {}, [], { 'job-id-list': null }, { other: '' }]) {
    const { io } = scriptedIo((request) => {
      if (request.method === 'get-job-id-list') return { id: request.id, result: malformed };
      if (request.params.includes('model')) return { id: request.id, result: ['DHP700', 'DHP700W#EU1', '1.0.31_0074', 'x05', 5009] };
      return { id: request.id, result: ['20', '2000', '::0'] };
    });
    await assert.rejects(new ReadOnlyPixCut(io).physicalIdleProof(), /Unrecognized printer job-list/);
  }
  const { io } = scriptedIo((request) => {
    if (request.params.includes('model')) return { id: request.id, result: ['DHP700', 'DHP700W#EU1', '1.0.31_0074', 'x05', 5009] };
    return { id: request.id, result: ['20', '2000', null] };
  });
  await assert.rejects(new ReadOnlyPixCut(io).physicalIdleProof(), /Unrecognized printer status or alert/);
});

test('serializes concurrent read-only requests', async () => {
  let firstResolved = false;
  const writes = [];
  const io = {
    async write(_endpoint, bytes) {
      const request = JSON.parse(decoder.decode(bytes).slice('cmd json\n'.length));
      writes.push(request.method);
      if (request.method === 'get-job-id-list') assert.equal(firstResolved, true);
    },
    async read() {
      const method = writes.at(-1);
      if (method === 'get-prop') {
        firstResolved = true;
        return encoder.encode(JSON.stringify({ id: 1, result: ['DHP700', 'DHP700W#EU1', '1.0.15_0054', 'x05', 5009] }));
      }
      return encoder.encode(JSON.stringify({ id: 2, result: [] }));
    },
  };
  const client = new ReadOnlyPixCut(io, { startingId: 1 });

  await Promise.all([client.identify(), client.activeJobs()]);
  assert.deepEqual(writes, ['get-prop', 'get-job-id-list']);
});

test('raises unsolicited printer error events instead of hiding them', async () => {
  const { io } = scriptedIo(() => ({ method: 'event.rpt_err', params: { code: 5401 } }));
  const client = new ReadOnlyPixCut(io, { startingId: 1, timeoutMs: 20 });

  await assert.rejects(client.status(), /printer error event.*5401/);
});

test('times out when the printer never replies', async () => {
  const { io } = scriptedIo(() => undefined);
  const client = new ReadOnlyPixCut(io, { startingId: 1, timeoutMs: 5 });

  await assert.rejects(client.identify(), /no reply to get-prop/);
});

test('includes a slow write in the request deadline', async () => {
  const io = {
    async write() { await new Promise((resolve) => setTimeout(resolve, 20)); },
    async read() { return encoder.encode(JSON.stringify({ id: 1, result: [] })); },
  };
  const client = new ReadOnlyPixCut(io, { startingId: 1, timeoutMs: 5 });

  await assert.rejects(client.identify(), (error) => {
    assert.equal(error.code, 'PRINTER_TIMEOUT');
    return true;
  });
});

test('rejects a matching printer error envelope', async () => {
  const { io } = scriptedIo((request) => ({
    id: request.id,
    error: { code: 5401, message: 'out of paper' },
  }));
  const client = new ReadOnlyPixCut(io, { startingId: 1 });

  await assert.rejects(client.identify(), /printer rejected get-prop.*5401/);
});

test('rejects a successful envelope with missing identity properties', async () => {
  const { io } = scriptedIo((request) => ({ id: request.id, result: [] }));
  const client = new ReadOnlyPixCut(io, { startingId: 1 });

  await assert.rejects(client.identify(), /invalid get-prop response.*model/);
});

test('resynchronizes after malformed noise and ignores a wrong-id frame', async () => {
  const chunks = [
    '{"id":8,"result":[]}',
    'diagnostic {oops {"id":9,"result":["DHP700","DHP700W#EU1","1.0.15_0054","x05",5009]}',
  ];
  const io = {
    async write() {},
    async read() { return encoder.encode(chunks.shift() ?? ''); },
  };
  const client = new ReadOnlyPixCut(io, { startingId: 9, timeoutMs: 20 });

  assert.equal((await client.identify()).model, 'DHP700');
});
