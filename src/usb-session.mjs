import { CTRL, DATA, PID, VID } from './protocol.mjs';

function printerError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function translateUsbError(error) {
  if (error?.errno === -3 || /LIBUSB_ERROR_ACCESS/.test(String(error))) {
    return printerError(
      'PRINTER_BUSY',
      'PixCut USB interfaces are busy or unavailable. Close Chrome, Liene Photos, or any other printer connection and try again.',
      error,
    );
  }
  return printerError('PRINTER_USB_ERROR', `PixCut USB error: ${error?.message ?? String(error)}`, error);
}

function releaseInterface(usbInterface) {
  return new Promise((resolve) => {
    usbInterface.release(true, () => resolve());
  });
}

export async function openUsbSession({ usbModule, vid = VID, pid = PID } = {}) {
  if (!usbModule?.findByIds) throw new TypeError('usbModule.findByIds is required');
  const device = usbModule.findByIds(vid, pid);
  if (!device) throw printerError('PRINTER_NOT_FOUND', 'PixCut S1 not found on USB. Check power and the USB cable.');

  const claimed = [];
  let closed = false;

  try {
    device.open();
    for (const interfaceNumber of [CTRL.iface, DATA.iface]) {
      const usbInterface = device.interface(interfaceNumber);
      usbInterface.claim();
      claimed.push(usbInterface);
    }
  } catch (error) {
    for (const usbInterface of [...claimed].reverse()) await releaseInterface(usbInterface);
    try { device.close(); } catch { /* device may not have opened */ }
    throw translateUsbError(error);
  }

  const endpoints = new Map();
  for (const usbInterface of claimed) {
    for (const endpoint of usbInterface.endpoints) endpoints.set(endpoint.address, endpoint);
  }

  function endpointAt(address) {
    const endpoint = endpoints.get(address);
    if (!endpoint) throw printerError('PRINTER_USB_ERROR', `PixCut endpoint 0x${address.toString(16)} is missing.`);
    return endpoint;
  }

  const io = {
    write(address, bytes) {
      return new Promise((resolve, reject) => {
        endpointAt(address).transfer(Buffer.from(bytes), (error) => {
          if (error) reject(translateUsbError(error));
          else resolve();
        });
      });
    },
    read(address, maxLength, timeoutMs) {
      return new Promise((resolve, reject) => {
        const endpoint = endpointAt(address);
        endpoint.timeout = Math.round(timeoutMs);
        endpoint.transfer(maxLength, (error, data) => {
          if (error?.errno === 2 || /TIMED_OUT/.test(String(error))) {
            resolve(new Uint8Array());
          } else if (error) {
            reject(translateUsbError(error));
          } else {
            resolve(new Uint8Array(data));
          }
        });
      });
    },
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const usbInterface of [...claimed].reverse()) await releaseInterface(usbInterface);
    device.close();
  };

  return { io, close };
}
