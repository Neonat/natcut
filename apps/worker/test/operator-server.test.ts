import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobStore, SimulatedPrinter, type CloudQueue } from '../src/index.ts';
import type { OperatorQueue } from '../src/operator-queue.ts';
import { artifactReader, submission } from './fixtures/submission.ts';
import { createOperatorServer } from '../src/operator-server.ts';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

async function desk(
  recoverClaim: CloudQueue['recoverClaim'] = async () => null,
  list: OperatorQueue['list'] = async () => { throw Error('unexpected queue access'); },
) {
  const store = new JobStore(':memory:');
  const server = createOperatorServer({
    workerId: 'test', store, artifactReader, executor: new SimulatedPrinter(),
    cloud: {
      recoverClaim, claimNextSubmission: async () => null,
      beginExecution: async () => { throw Error('unexpected execution'); },
      completeExecution: async () => { throw Error('unexpected status publication'); },
    },
  }, {
    list,
    collect: async () => { throw Error('unexpected pickup'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  disposers.push(() => { server.closeAllConnections(); server.close(); store.close(); });
  async function send(path: string, method = 'GET', headers: Record<string, string> = {}) {
    const req = request(origin + path, { method, headers });
    const result = once(req, 'response');
    req.end();
    const [response] = await result;
    const chunks = [];
    for await (const part of response) chunks.push(part);
    return { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() };
  }
  const session = await send('/session');
  const headers = { 'content-type': 'application/json', 'x-natcut-control': JSON.parse(session.body).capability ?? '' };
  return { send, headers, origin };
}

describe('loopback control boundary', () => {
  it('serves a correlatable submission column and a non-sensitive reconciliation alert', async () => {
    const { send } = await desk();
    const [html, script] = await Promise.all([send('/'), send('/desk.js')]);
    expect(html.body).toContain('<th>Submission ID</th>');
    expect(html.body).toMatch(/id="hold" role="alert"/);
    expect(html.body).toContain('require operator reconciliation');
    expect(script.body).toContain('ticket.submissionId');
    expect(script.body).toContain('Retry completion acknowledgement');
    expect(html.body + script.body).not.toMatch(/lastError|executionToken|artifactReceiptJson|jpegPath/);
  });

  it('issues a different capability for each listener, only to local clients', async () => {
    const a = await desk();
    const b = await desk();
    expect(a.headers['x-natcut-control']).toMatch(/^[a-zA-Z0-9_-]{32,}$/);
    expect(a.headers).not.toEqual(b.headers);
    const session = await a.send('/session');
    expect(session.headers['cache-control']).toContain('no-store');
    for (const headers of [{ origin: 'http://127.0.0.1:4174' }, { host: 'localhost' }, { 'sec-fetch-site': 'cross-site' }]) {
      const denied = await a.send('/session', 'GET', headers as Record<string, string>);
      expect(denied.status).toBe(403);
      expect(denied.body).not.toContain(a.headers['x-natcut-control']);
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it.each(['/claim', '/start', '/collect/visitor-a'])('rejects untrusted or simple requests to %s', async (route) => {
    const { send, origin, headers } = await desk();
    for (const values of [
      {}, { ...headers, origin: origin + '.invalid' }, { ...headers, origin: 'null' },
      { ...headers, 'sec-fetch-site': 'same-origin' }, { ...headers, host: '127.0.0.1' }, { ...headers, 'sec-fetch-site': 'cross-site' },
      { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      { ...headers, 'x-natcut-control': 'wrong' },
    ]) {
      expect((await send(route, 'POST', values)).status).toBe(403);
    }
    expect((await send('/claim', 'POST', { ...headers, origin })).status).toBe(404);
    expect((await send('/start', 'POST', headers)).status).toBe(409);
  });

  it('blocks conflicting claim and start while a lease read is pending, then releases the command', async () => {
    const pending = Promise.withResolvers<null>();
    const entered = Promise.withResolvers<void>();
    const recover = vi.fn<CloudQueue['recoverClaim']>()
      .mockImplementationOnce(() => { entered.resolve(); return pending.promise; })
      .mockResolvedValue(null);
    const { send, headers } = await desk(recover);
    const claim = send('/claim', 'POST', headers);
    await entered.promise;
    try {
      const concurrent = await Promise.all(['/claim', '/start'].map((path) => send(path, 'POST', headers)));
      expect(concurrent.map((r) => [r.status, JSON.parse(r.body).error])).toEqual([
        [409, 'SIMULATOR_BUSY'], [409, 'SIMULATOR_BUSY'],
      ]);
    } finally {
      pending.resolve(null);
      await claim;
    }
    expect((await send('/claim', 'POST', headers)).status).toBe(404);
  });

  it('omits the Start target when a slow queue read shows an earlier ticket as Next', async () => {
    const delayed = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const ticket = { ...submission('second', 2), publicStatus: 'next' as const };
    const { send, headers } = await desk(
      async () => ({ submission: ticket, workerId: 'test', claimedAt: ticket.updatedAt }),
      async () => {
        reading.resolve();
        await delayed.promise;
        return {
          rows: [
            { submissionId: 'first', queueNumber: 1, publicStatus: 'next', localState: 'claimed', notice: null, onHold: false, completionRetry: false },
            { submissionId: 'second', queueNumber: 2, publicStatus: 'queued', localState: null, notice: null, onHold: false, completionRetry: false },
          ],
          next: { queued: null, ready: null },
          completionRetrySubmissionId: null,
        };
      },
    );
    const refresh = send('/queue');
    await reading.promise;
    try {
      expect((await send('/claim', 'POST', headers)).status).toBe(200);
    } finally {
      delayed.resolve();
    }
    const snapshot = JSON.parse((await refresh).body);
    expect(snapshot.rows[0].submissionId).toBe('first');
    expect(snapshot.claimedSubmissionId).toBeNull();
  });

  it('returns a fixed failure message and allows another claim after a preparation exception', async () => {
    const recover = vi.fn<CloudQueue['recoverClaim']>()
      .mockRejectedValueOnce(Error('private-error-path'))
      .mockResolvedValue(null);
    const { send, headers } = await desk(recover);
    const failed = await send('/claim', 'POST', headers);
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain('private-error-path');
    expect((await send('/claim', 'POST', headers)).status).toBe(404);
  });
});
