import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWebUsbProtocol } from '../public/webusb-client.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('reads identity, safe status, and active jobs through the browser control endpoint', async () => {
  let request;
  const protocol = createWebUsbProtocol({
    async write(endpoint, bytes) {
      assert.equal(endpoint, 0x06);
      request = JSON.parse(decoder.decode(bytes).slice('cmd json\n'.length));
    },
    async read(endpoint) {
      assert.equal(endpoint, 0x86);
      let result;
      if (request.method === 'get-prop' && request.params.includes('model')) {
        result = ['DHP700', 'DHP700W', '1.0.15', 'x05', 5013];
      } else if (request.method === 'get-prop') result = [20, 2000, '::0'];
      else result = [91];
      return encoder.encode(`{"result":${JSON.stringify(result)},"id":${request.id}}`);
    },
  }, { startingId: 5, timeoutMs: 50 });

  assert.deepEqual(await protocol.snapshot(), {
    identity: { model: 'DHP700', sku: 'DHP700W', 'firmware-revision': '1.0.15', 'hardware-revision': 'x05', 'media-size': 5013 },
    status: { state: 20, sub: 2000, alerts: [], label: 'idle', subLabel: 'idle' },
    activeJobs: [91],
  });
});

test('returns one unambiguous printer job id from a browser combo declaration', async () => {
  let request;
  const protocol = createWebUsbProtocol({
    async write(_endpoint, bytes) { request = JSON.parse(decoder.decode(bytes).slice('cmd json\n'.length)); },
    async read() { return encoder.encode(JSON.stringify({ id: request.id, result: [{ 'job-id': 57 }] })); },
  }, { startingId: 8, timeoutMs: 50 });

  assert.equal(await protocol.declare({ method: 'combo-job', params: [] }), 57);
});

test('writes one server-framed data chunk and requires one unambiguous OK acknowledgement', async () => {
  const writes = [];
  const replies = [encoder.encode('prefix '), encoder.encode('OK')];
  const protocol = createWebUsbProtocol({
    async write(endpoint, bytes) { writes.push({ endpoint, bytes: new Uint8Array(bytes) }); },
    async read(endpoint) { assert.equal(endpoint, 0x84); return replies.shift() ?? new Uint8Array(); },
  }, { timeoutMs: 50 });
  const frame = new Uint8Array([1, 2, 3]);
  await protocol.sendFrame(frame);
  assert.deepEqual(writes, [{ endpoint: 0x04, bytes: frame }]);
});
