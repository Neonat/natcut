import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUsbTransportMutationPort } from '../src/printer-mutation-port.mjs';
import { CTRL, DATA } from '../src/protocol.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function declaration() {
  return { method: 'combo-job', params: [{ method: 'print-job', params: { 'file-size': 12 } }] };
}

test('normalizes one printer-issued combo job id and writes the exact declaration', async () => {
  const writes = [];
  let request;
  const port = createUsbTransportMutationPort({
    async write(endpoint, bytes) {
      writes.push({ endpoint, bytes: new Uint8Array(bytes) });
      request = JSON.parse(decoder.decode(bytes).slice('cmd json\n'.length));
    },
    async read(endpoint) {
      assert.equal(endpoint, CTRL.in);
      return encoder.encode(JSON.stringify({ id: request.id, result: [{ 'job-id': 37, state: 1 }] }));
    },
  }, { startingId: 700, timeoutMs: 50 });

  assert.deepEqual(await port.declareCombo(declaration()), { jobId: 37 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endpoint, CTRL.out);
  assert.deepEqual(JSON.parse(decoder.decode(writes[0].bytes).slice('cmd json\n'.length)), {
    id: 700,
    method: 'combo-job',
    params: declaration().params,
  });
});
test('accepts one complete data acknowledgement and rejects refusal or ambiguity without retrying', async (t) => {
  for (const [name, replies, message] of [
    ['success', ['noise ', 'OK'], null],
    ['refusal', ['ER media'], /refused/i],
    ['ambiguous', ['OK ER'], /ambiguous/i],
  ]) {
    await t.test(name, async () => {
      const writes = [];
      const queue = [...replies];
      const port = createUsbTransportMutationPort({
        async write(endpoint, bytes) { writes.push({ endpoint, bytes: new Uint8Array(bytes) }); },
        async read(endpoint) {
          assert.equal(endpoint, DATA.in);
          return encoder.encode(queue.shift() ?? '');
        },
      }, { timeoutMs: 50 });
      const frame = encoder.encode('cmd data EXTLEN=5\n%\0\0\0x');
      const action = port.sendFrameAndWaitForAck({ jobId: 37, kind: 'plt', index: 0, frame });
      if (message) await assert.rejects(action, message);
      else await action;
      assert.equal(writes.length, 1);
      assert.equal(writes[0].endpoint, DATA.out);
      assert.deepEqual(writes[0].bytes, frame);
    });
  }
});
test('rejects a frame whose embedded job id differs before writing', async () => {
  let writes = 0;
  const port = createUsbTransportMutationPort({
    async write() { writes += 1; },
    async read() { return encoder.encode('OK'); },
  });
  const frame = encoder.encode('cmd data EXTLEN=5\n%\0\0\0x');
  await assert.rejects(
    port.sendFrameAndWaitForAck({ jobId: 38, kind: 'plt', index: 0, frame }),
    /job ID/i,
  );
  assert.equal(writes, 0);
});
