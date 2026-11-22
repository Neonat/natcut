import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CTRL, DATA, PID, VID } from '../src/protocol.mjs';
import { openUsbSession } from '../src/usb-session.mjs';

function createEndpoint(address, transfer) {
  return { address, timeout: 0, transfer };
}

function createUsbDevice({ failClaimAt } = {}) {
  const events = [];
  const writes = [];
  const controlOut = createEndpoint(CTRL.out, (buffer, callback) => {
    writes.push([...buffer]);
    callback(null);
  });
  const controlIn = createEndpoint(CTRL.in, (_length, callback) => {
    const error = new Error('LIBUSB_TRANSFER_TIMED_OUT');
    error.errno = 2;
    callback(error);
  });
  const dataOut = createEndpoint(DATA.out, (_buffer, callback) => callback(null));
  const dataIn = createEndpoint(DATA.in, (_length, callback) => callback(null, Buffer.from([1, 2])));

  const makeInterface = (number, endpoints) => ({
    endpoints,
    claim() {
      events.push(`claim:${number}`);
      if (number === failClaimAt) {
        const error = new Error('LIBUSB_ERROR_ACCESS');
        error.errno = -3;
        throw error;
      }
    },
    release(_reattach, callback) {
      events.push(`release:${number}`);
      callback(null);
    },
  });
  const interfaces = new Map([
    [CTRL.iface, makeInterface(CTRL.iface, [controlOut, controlIn])],
    [DATA.iface, makeInterface(DATA.iface, [dataOut, dataIn])],
  ]);
  const device = {
    open() { events.push('open'); },
    close() { events.push('close'); },
    interface(number) { return interfaces.get(number); },
  };
  const usbModule = {
    findByIds(vid, pid) {
      assert.equal(vid, VID);
      assert.equal(pid, PID);
      return device;
    },
  };
  return { usbModule, events, writes };
}

test('reports a clear error when the printer is absent', async () => {
  const usbModule = { findByIds: () => undefined };

  await assert.rejects(openUsbSession({ usbModule }), (error) => {
    assert.equal(error.code, 'PRINTER_NOT_FOUND');
    assert.match(error.message, /PixCut S1 not found/);
    return true;
  });
});

test('claims both vendor interfaces and maps endpoint transfers', async () => {
  const { usbModule, events, writes } = createUsbDevice();
  const session = await openUsbSession({ usbModule });

  await session.io.write(CTRL.out, Uint8Array.from([9, 8]));
  const timedOutRead = await session.io.read(CTRL.in, 4096, 25);
  const dataRead = await session.io.read(DATA.in, 4096, 25);
  await session.close();

  assert.deepEqual(writes, [[9, 8]]);
  assert.deepEqual([...timedOutRead], []);
  assert.deepEqual([...dataRead], [1, 2]);
  assert.deepEqual(events, ['open', 'claim:2', 'claim:3', 'release:3', 'release:2', 'close']);
});

test('translates access denial and releases a partially claimed session', async () => {
  const { usbModule, events } = createUsbDevice({ failClaimAt: DATA.iface });

  await assert.rejects(openUsbSession({ usbModule }), (error) => {
    assert.equal(error.code, 'PRINTER_BUSY');
    assert.match(error.message, /Close Chrome/);
    return true;
  });
  assert.deepEqual(events, ['open', 'claim:2', 'claim:3', 'release:2', 'close']);
});
