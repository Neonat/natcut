import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPrinterSnapshot } from '../src/snapshot.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function successfulSession() {
  let closed = false;
  let request;
  return {
    get closed() { return closed; },
    io: {
      async write(_endpoint, bytes) {
        request = JSON.parse(decoder.decode(bytes).slice('cmd json\n'.length));
      },
      async read() {
        let result;
        if (request.method === 'get-prop' && request.params.includes('model')) {
          result = ['DHP700', 'DHP700W#EU1', '1.0.15_0054', 'x05', 5009];
        } else if (request.method === 'get-prop') {
          result = [20, 2000, '::0'];
        } else {
          result = [];
        }
        return encoder.encode(JSON.stringify({ id: request.id, result }));
      },
    },
    async close() { closed = true; },
  };
}

test('returns a snapshot and always closes the USB session', async () => {
  const session = successfulSession();

  const snapshot = await readPrinterSnapshot({ openSession: async () => session });

  assert.equal(snapshot.identity.model, 'DHP700');
  assert.equal(snapshot.status.label, 'idle');
  assert.deepEqual(snapshot.activeJobs, []);
  assert.equal(session.closed, true);
});

test('closes the USB session when a protocol request fails', async () => {
  let closed = false;
  const session = {
    io: {
      async write() { throw new Error('broken transport'); },
      async read() { return new Uint8Array(); },
    },
    async close() { closed = true; },
  };

  await assert.rejects(
    readPrinterSnapshot({ openSession: async () => session }),
    /broken transport/,
  );
  assert.equal(closed, true);
});
