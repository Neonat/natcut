import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { safelyExecutableStates } from './job-store.ts';
import type { OperatorQueue } from './operator-queue.ts';
import { prepareNextWorkerJob, runLocalJob, type WorkerDependencies } from './worker.ts';

const assets = new Map<string, readonly [string, string]>([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/desk.css', ['desk.css', 'text/css; charset=utf-8']],
  ['/desk.js', ['desk.js', 'text/javascript; charset=utf-8']],
] as const);

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function cursor(search: URLSearchParams, name: string) {
  const value = search.get(name) ?? '0';
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function createOperatorServer(deps: WorkerDependencies, queue: OperatorQueue) {
  let currentSubmissionId: string | null = null;
  let claiming = false;
  let executing = false;
  const capability = randomBytes(32).toString('base64url');

  return createServer(async (request, response) => {
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    const host = '127.0.0.1:' + request.socket.localPort;
    const { origin } = request.headers;
    const site = request.headers['sec-fetch-site'];
    if (request.socket.localAddress !== '127.0.0.1' ||
        request.headersDistinct.host?.length !== 1 || request.headers.host !== host ||
        (origin !== undefined && origin !== 'http://' + host) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      return send(response, 403, { error: 'LOCAL_CONTROL_ONLY' });
    }
    if (request.method === 'POST' &&
        ((site !== undefined && origin !== 'http://' + host) ||
         request.headers['x-natcut-control'] !== capability || request.headers['content-type'] !== 'application/json')) {
      return send(response, 403, { error: 'LOCAL_CONTROL_ONLY' });
    }
    try {
      const asset = assets.get(request.url ?? '/');
      if (request.method === 'GET' && asset) {
        const content = await readFile(new URL('../public/' + asset[0], import.meta.url));
        response.writeHead(200, { 'content-type': asset[1] });
        return response.end(content);
      }
      if (request.method === 'GET' && request.url === '/session') return send(response, 200, { capability });
      if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true });
      const url = new URL(request.url ?? '/', 'http://' + host);
      if (request.method === 'GET' && url.pathname === '/queue') {
        const queued = cursor(url.searchParams, 'queuedAfter');
        const ready = cursor(url.searchParams, 'readyAfter');
        if (queued === null || ready === null) return send(response, 400, { error: 'INVALID_CURSOR' });
        const page = await queue.list({ queued, ready });
        return send(response, 200, { ...page, claimedSubmissionId: currentSubmissionId, busy: claiming || executing });
      }
      const pickup = /^\/collect\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      if (request.method === 'POST' && pickup) {
        const result = await queue.collect(pickup[1]!);
        if (result === 'not-found') return send(response, 404, { error: 'TICKET_NOT_FOUND' });
        if (result === 'not-ready') return send(response, 409, { error: 'TICKET_NOT_READY' });
        return send(response, 200, { publicStatus: result });
      }
      if (request.method === 'POST' && request.url === '/claim') {
        if (claiming || executing) return send(response, 409, { error: 'SIMULATOR_BUSY' });
        if (currentSubmissionId) return send(response, 409, { error: 'JOB_ALREADY_CLAIMED' });
        claiming = true;
        try {
          const prepared = await prepareNextWorkerJob(deps);
          if (prepared.kind === 'idle') return send(response, 404, { error: 'QUEUE_EMPTY' });
          if (prepared.kind === 'waiting_for_cloud') return send(response, 503, { error: 'STATUS_SYNC_PENDING' });
          if (prepared.kind !== 'prepared') {
            return send(response, 409, { error: 'JOB_NEEDS_RECONCILIATION', submissionId: prepared.submissionId });
          }
          currentSubmissionId = prepared.job.submissionId;
          return send(response, 200, { submissionId: currentSubmissionId, publicStatus: 'next' });
        } finally {
          claiming = false;
        }
      }
      if (request.method === 'POST' && request.url === '/start') {
        if (claiming || executing) return send(response, 409, { error: 'SIMULATOR_BUSY' });
        if (!currentSubmissionId) return send(response, 409, { error: 'NO_CLAIMED_JOB' });
        const expectedId = request.headers['x-natcut-submission'];
        if (expectedId !== undefined && expectedId !== currentSubmissionId) {
          return send(response, 409, { error: 'CLAIM_CHANGED' });
        }
        const job = deps.store.getBySubmissionId(currentSubmissionId);
        if (!job) return send(response, 404, { error: 'LOCAL_JOB_MISSING' });
        if (!safelyExecutableStates.has(job.state)) {
          return send(response, 409, { error: 'JOB_NOT_SAFE_TO_START' });
        }
        const startedSubmissionId = currentSubmissionId;
        executing = true;
        void runLocalJob(deps, job).catch(() => {
          // The durable worker fences determine whether this job can be claimed again.
        }).finally(() => {
          executing = false;
          currentSubmissionId = null;
        });
        return send(response, 202, { submissionId: startedSubmissionId, started: true });
      }
      return send(response, 404, { error: 'NOT_FOUND' });
    } catch {
      return send(response, 500, { error: 'CONTROL_UNAVAILABLE' });
    }
  });
}
