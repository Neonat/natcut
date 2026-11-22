import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const operatorPageUrl = new URL('../public/index.html', import.meta.url);

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function publicError(error) {
  if (error?.code === 'PRINTER_NOT_FOUND') return { status: 503, code: error.code, message: error.message };
  if (error?.code === 'PRINTER_BUSY') return { status: 409, code: error.code, message: error.message };
  if (error?.code === 'PRINTER_TIMEOUT' || /no reply/i.test(error?.message ?? '')) {
    return { status: 504, code: 'PRINTER_TIMEOUT', message: 'The printer did not reply before the status request timed out.' };
  }
  return { status: 500, code: 'PRINTER_ERROR', message: 'The printer status request failed.' };
}

export function createServer({ getSnapshot }) {
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot must be a function');
  let snapshotQueue = Promise.resolve();

  const queueSnapshot = () => {
    const result = snapshotQueue.then(getSnapshot, getSnapshot);
    snapshotQueue = result.catch(() => {});
    return result;
  };

  return createHttpServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Only read-only GET requests are supported.' } }, { allow: 'GET' });
      return;
    }

    if (pathname === '/api/health') {
      sendJson(response, 200, { ok: true, service: 'natcut', mode: 'read-only' });
      return;
    }

    if (pathname === '/api/printer') {
      try {
        const snapshot = await queueSnapshot();
        sendJson(response, 200, { ok: true, snapshot });
      } catch (error) {
        const mapped = publicError(error);
        sendJson(response, mapped.status, { ok: false, error: { code: mapped.code, message: mapped.message } });
      }
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = await readFile(operatorPageUrl);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(html);
      return;
    }

    sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
}

async function start() {
  const [{ findByIds }, { openUsbSession }, { readPrinterSnapshot }] = await Promise.all([
    import('usb'),
    import('./usb-session.mjs'),
    import('./snapshot.mjs'),
  ]);
  const server = createServer({
    getSnapshot: () => readPrinterSnapshot({
      openSession: () => openUsbSession({ usbModule: { findByIds } }),
    }),
  });
  const host = process.env.NATCUT_HOST ?? '127.0.0.1';
  const port = Number(process.env.NATCUT_PORT ?? 4173);
  server.listen(port, host, () => console.log(`NatCut read-only dashboard: http://${host}:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
