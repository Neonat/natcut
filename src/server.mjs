import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { deriveRibbonRegistrationStatus } from '@natcut/printer/physical-qc';
import { journalUnavailable, requireMutableAttempt } from './physical-evidence.mjs';

const operatorPageUrl = new URL('../public/index.html', import.meta.url);
const webUsbClientUrl = new URL('../public/webusb-client.js', import.meta.url);

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request, maximumBytes = 4096, rejectDuplicateKeys = false) {
  return new Promise((resolve, reject) => {
    const badRequest = message => reject(Object.assign(new Error(message), { code: 'BAD_REQUEST' }));
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      badRequest('Expected application/json.');
      return;
    }
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) badRequest('Request body is too large.');
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (length > maximumBytes) return;
      try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        let members = 0;
        const body = JSON.parse(source, rejectDuplicateKeys ? (_key, value) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) members += Object.keys(value).length;
          return value;
        } : undefined);
        if (rejectDuplicateKeys) {
          // Count key tokens in the validated JSON before accepting JSON.parse's last-member-wins result.
          let keys = 0;
          for (const match of source.matchAll(/"(?:\\.|[^"\\])*"\s*(:)?/g)) {
            if (match[1] === ':') keys++;
          }
          if (keys !== members) return badRequest('Duplicate JSON field.');
        }
        resolve(body);
      } catch { badRequest('Invalid JSON body.'); }
    });
    request.on('error', reject);
  });
}

const evidenceErrors = {
  BAD_REQUEST: 400, OBSERVATION_CONFLICT: 409, ATTEMPT_LOCKED: 409, ATTEMPT_ALREADY_STARTED: 409, JOURNAL_UNAVAILABLE: 503,
};

function sendEvidenceError(response, error) {
  const status = evidenceErrors[error?.code];
  if (!status) return false;
  sendJson(response, status, { ok: false, error: { code: error.code, message: error.message } });
  return true;
}

function publicError(error) {
  if (error?.code === 'PRINTER_NOT_FOUND') return { status: 503, code: error.code, message: error.message };
  if (error?.code === 'PRINTER_BUSY') return { status: 409, code: error.code, message: error.message };
  if (error?.code === 'PRINTER_TIMEOUT' || /no reply/i.test(error?.message ?? '')) {
    return { status: 504, code: 'PRINTER_TIMEOUT', message: 'The printer did not reply before the status request timed out.' };
  }
  return { status: 500, code: 'PRINTER_ERROR', message: 'The printer status request failed.' };
}

export function createServer({
  getSnapshot,
  readOperatorPage = () => readFile(operatorPageUrl),
  readWebUsbClient = () => readFile(webUsbClientUrl),
  getPhysicalAttemptEvidence = () => { throw journalUnavailable(); },
  recordCompletedAttempt,
  recordRibbonRegistrationQc,
  preparePhysicalProof,
  sendPhysicalProof,
  browserPhysicalCoordinator,
  physicalSendEnabled = false,
}) {
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot must be a function');
  let snapshotInFlight = null;
  let proofInFlight = null;
  let preparedProof = null;
  let physicalSendStarted = false;
  let printerQueue = Promise.resolve();

  const serializePrinter = (operation) => {
    const result = printerQueue.then(operation, operation);
    printerQueue = result.catch(() => {});
    return result;
  };

  const queueSnapshot = () => {
    if (!snapshotInFlight) {
      snapshotInFlight = Promise.resolve()
        .then(() => serializePrinter(getSnapshot))
        .finally(() => { snapshotInFlight = null; });
    }
    return snapshotInFlight;
  };

  const queueProof = () => {
    if (preparedProof) return Promise.resolve(preparedProof);
    if (!proofInFlight) {
      proofInFlight = Promise.resolve()
        .then(() => {
          if (typeof preparePhysicalProof !== 'function') throw new Error('Physical proof preparation is unavailable.');
          return preparePhysicalProof();
        })
        .then((proof) => { preparedProof = proof; return proof; })
        .finally(() => { proofInFlight = null; });
    }
    return proofInFlight;
  };

  const handle = async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(response, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Malformed request target.' } });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/physical-proof/evidence') {
      try {
        const evidence = getPhysicalAttemptEvidence();
        const qc = evidence?.ribbonRegistrationQc;
        sendJson(response, 200, { ok: true, evidence, ribbonOverall: qc ? deriveRibbonRegistrationStatus(qc.channels) : null });
      } catch { sendEvidenceError(response, journalUnavailable()); }
      return;
    }

    if (request.method === 'POST' &&
        (pathname === '/api/physical-proof/record-completed' || pathname === '/api/physical-proof/physical-qc')) {
      try {
        const input = await readJsonBody(request, 65536, true);
        const append = pathname === '/api/physical-proof/record-completed' ? recordCompletedAttempt : recordRibbonRegistrationQc;
        if (!append) throw journalUnavailable();
        sendJson(response, 200, { ok: true, record: append(input) });
      } catch (error) {
        if (!sendEvidenceError(response, error)) sendEvidenceError(response, journalUnavailable());
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/api/physical-proof/prepare') {
      try {
        const input = await readJsonBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== 0) {
          sendJson(response, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Proof preparation takes an empty JSON object.' } });
          return;
        }
        const proof = await queueProof();
        let sendEnabled = false;
        if (physicalSendEnabled && !physicalSendStarted) {
          try { sendEnabled = getPhysicalAttemptEvidence() === null; } catch { sendEnabled = false; }
        }
        sendJson(response, 200, { ok: true, proof: proof.summary, sendEnabled });
      } catch (error) {
        sendJson(response, error?.code === 'BAD_REQUEST' ? 400 : 500, {
          ok: false, error: { code: error?.code ?? 'PROOF_PREPARATION_FAILED', message: error?.message ?? 'Proof preparation failed.' },
        });
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/api/physical-proof/send') {
      try {
        const input = await readJsonBody(request);
        requireMutableAttempt(getPhysicalAttemptEvidence, true);
        if (!physicalSendEnabled) {
          sendJson(response, 403, { ok: false, error: { code: 'SEPARATE_APPROVAL_REQUIRED', message: 'The exact printer write still requires separate approval.' } });
          return;
        }
        const proof = await queueProof();
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            input.approvalFingerprint !== proof.summary.approvalFingerprint || input.confirmation !== 'SEND ONE SHEET' ||
            Reflect.ownKeys(input).length !== 2) {
          sendJson(response, 400, { ok: false, error: { code: 'APPROVAL_MISMATCH', message: 'The physical proof approval does not match this exact job.' } });
          return;
        }
        if (typeof sendPhysicalProof !== 'function') throw new Error('Physical proof transport is unavailable.');
        if (physicalSendStarted) {
          throw Object.assign(new Error('This attempt has already started.'), { code: 'ATTEMPT_ALREADY_STARTED' });
        }
        physicalSendStarted = true;
        const result = await serializePrinter(() => {
          requireMutableAttempt(getPhysicalAttemptEvidence, true);
          return sendPhysicalProof(input, proof);
        });
        sendJson(response, 409, { ok: false, result });
      } catch (error) {
        if (sendEvidenceError(response, error)) return;
        sendJson(response, 500, { ok: false, error: { code: 'PHYSICAL_ATTEMPT_FAILED', message: error?.message ?? 'Physical attempt failed.' } });
      }
      return;
    }

    if (request.method === 'POST' && pathname.startsWith('/api/physical-proof/browser/')) {
      try {
        const input = await readJsonBody(request);
        const action = pathname.slice('/api/physical-proof/browser/'.length);
        requireMutableAttempt(getPhysicalAttemptEvidence, action === 'begin');
        if (!physicalSendEnabled) {
          sendJson(response, 403, { ok: false, error: { code: 'SEPARATE_APPROVAL_REQUIRED', message: 'The exact printer write still requires separate approval.' } });
          return;
        }
        if (!preparedProof) {
          sendJson(response, 409, { ok: false, error: { code: 'PROOF_NOT_PREPARED', message: 'Prepare the physical proof first.' } });
          return;
        }
        if (!browserPhysicalCoordinator) throw new Error('Browser physical coordinator is unavailable.');
        if (action === 'begin') {
          const attempt = browserPhysicalCoordinator.begin(input, preparedProof);
          physicalSendStarted = true;
          sendJson(response, 200, { ok: true, attempt });
          return;
        }
        if (action === 'job-id') {
          sendJson(response, 200, { ok: true, checkpoint: browserPhysicalCoordinator.recordJobId(input) });
          return;
        }
        if (action === 'frame') {
          const frame = browserPhysicalCoordinator.nextFrame(input);
          sendJson(response, 200, { ok: true, frame: {
            sequence: frame.sequence,
            kind: frame.kind,
            index: frame.index,
            base64: Buffer.from(frame.frame).toString('base64'),
          } });
          return;
        }
        if (action === 'ack') {
          sendJson(response, 200, { ok: true, checkpoint: browserPhysicalCoordinator.acknowledgeFrame(input) });
          return;
        }
        if (action === 'finish') {
          sendJson(response, 409, { ok: false, result: browserPhysicalCoordinator.finish(input) });
          return;
        }
        if (action === 'hold') {
          sendJson(response, 409, { ok: false, result: browserPhysicalCoordinator.hold(input) });
          return;
        }
        sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Browser physical route not found.' } });
      } catch (error) {
        if (sendEvidenceError(response, error)) return;
        sendJson(response, physicalSendStarted ? 409 : 400, {
          ok: false, error: { code: 'BROWSER_PHYSICAL_STOPPED', message: error?.message ?? 'Browser physical attempt stopped.' },
        });
      }
      return;
    }

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

    if (pathname === '/api/physical-proof/preview.jpg') {
      if (!preparedProof) {
        sendJson(response, 404, { ok: false, error: { code: 'PROOF_NOT_PREPARED', message: 'Prepare the physical proof first.' } });
        return;
      }
      response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
      response.end(preparedProof.artifacts.print.bytes);
      return;
    }

    if (pathname === '/api/physical-proof/cut-preview.svg') {
      if (!preparedProof) {
        sendJson(response, 404, { ok: false, error: { code: 'PROOF_NOT_PREPARED', message: 'Prepare the physical proof first.' } });
        return;
      }
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      response.end(preparedProof.cutPreviewSvg);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = await readOperatorPage();
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(html);
      return;
    }

    if (pathname === '/webusb-client.js') {
      const javascript = await readWebUsbClient();
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(javascript);
      return;
    }

    sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  };

  return createHttpServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: { code: 'SERVER_ERROR', message: 'The local NatCut server could not complete the request.' } });
      } else {
        response.destroy();
      }
    });
  });
}

async function start() {
  const [
    { openUsbSession },
    { readPrinterSnapshot },
    { createPhysicalProofRuntime },
    { createBrowserPhysicalCoordinator },
  ] = await Promise.all([
    import('./usb-session.mjs'),
    import('./snapshot.mjs'),
    import('./physical-proof-runtime.mjs'),
    import('./browser-physical-coordinator.mjs'),
  ]);
  const openSession = async () => {
    const { findByIds } = await import('usb');
    return openUsbSession({ usbModule: { findByIds } });
  };
  const physical = createPhysicalProofRuntime({
    approvalFingerprint: process.env.NATCUT_APPROVED_PHYSICAL_FINGERPRINT,
    journalPath: process.env.NATCUT_TRANSPORT_JOURNAL,
    openSession,
  });
  const browserPhysicalCoordinator = createBrowserPhysicalCoordinator({
    approvalFingerprint: process.env.NATCUT_APPROVED_PHYSICAL_FINGERPRINT,
    journalPath: process.env.NATCUT_TRANSPORT_JOURNAL,
  });
  const server = createServer({
    getSnapshot: () => readPrinterSnapshot({
      openSession,
    }),
    ...physical,
    browserPhysicalCoordinator,
  });
  const host = process.env.NATCUT_HOST ?? '127.0.0.1';
  const port = Number(process.env.NATCUT_PORT ?? 4173);
  server.listen(port, host, () => {
    console.log(`NatCut physical proof dashboard: http://${host}:${server.address().port}`);
    console.log(physical.physicalSendEnabled ? 'Exact physical write enabled.' : 'Physical write locked; preparation only.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
