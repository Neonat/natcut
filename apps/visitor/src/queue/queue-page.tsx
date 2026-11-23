import { useCallback, useEffect, useState } from 'react';
import type { PublicQueueStatus, VisitorApi } from '../api.ts';
import { fixtureManifest } from '../editor/editor-page.tsx';
import { usePullToRefresh } from './use-pull-to-refresh.ts';

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

const statusCopy = {
  joining: { title: 'Joining the queue', detail: 'Saving your sticker…' },
  queued: { title: 'In the print queue', detail: null },
  next: { title: 'You’re next', detail: 'Stay nearby—we’ll start your sticker soon.' },
  printing: { title: 'Your sticker is being made', detail: 'We’ll update this page when it is ready.' },
  ready: { title: 'Ready for pickup', detail: 'Show this screen at the Sprout booth.' },
  collected: { title: 'Sticker collected', detail: 'Thanks for growing with Sprout.' },
  cancelled: { title: 'You left the queue', detail: 'Rejoin at the back when you are ready.' },
} as const;

export function QueuePage(props: { submissionId: string; statusToken: string; api: VisitorApi; onNavigate?: (path: string) => void }) {
  const [status, setStatus] = useState<PublicQueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await props.api.getStatus(props.submissionId, props.statusToken));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh. Try again.');
    } finally {
      setLoading(false);
    }
  }, [props.api, props.statusToken, props.submissionId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const pullHandlers = usePullToRefresh(() => { void refresh(); });

  const leave = async () => {
    await props.api.leave(props.submissionId, props.statusToken);
    setStatus((current) => current ? { ...current, publicStatus: 'cancelled', canLeaveQueue: false, jobsAhead: 0 } : current);
  };

  const rejoin = async () => {
    const accepted = await props.api.submit({ manifest: fixtureManifest, idempotencyKey: requestId(), requeuedFrom: props.submissionId });
    sessionStorage.setItem(`natcut:status:${accepted.submissionId}`, accepted.statusToken);
    const path = `/queue/${accepted.submissionId}#token=${accepted.statusToken}`;
    if (props.onNavigate) props.onNavigate(path);
    else window.location.assign(path);
  };

  const copy = status ? statusCopy[status.publicStatus] : null;
  return (
    <main className="queue-page" data-testid="queue-page" {...pullHandlers}>
      <header className="brand-bar"><span className="brand-mark">sprout</span><span>Print queue</span></header>
      <section className="queue-status" aria-live="polite">
        <div className={`status-orbit ${status?.publicStatus ?? 'loading'}`} aria-hidden="true"><span /></div>
        {copy ? <h1>{copy.title}</h1> : <h1>Checking your place…</h1>}
        {status?.publicStatus === 'queued' ? <p className="queue-number">{status.jobsAhead === 0 ? 'No jobs ahead' : `${status.jobsAhead} ahead`}</p> : copy?.detail ? <p>{copy.detail}</p> : null}
        {status ? <p className="ticket-number">Queue #{status.queueNumber}</p> : null}
      </section>
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      <div className="queue-actions">
        <button className="secondary-action" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        {status && status.publicStatus !== 'cancelled' && status.publicStatus !== 'collected' ? (
          <button className="text-action" type="button" onClick={() => void leave()} disabled={!status.canLeaveQueue}>Leave queue</button>
        ) : null}
        {status?.publicStatus === 'cancelled' ? <button className="primary-action" type="button" onClick={() => void rejoin()}>Rejoin queue</button> : null}
      </div>
      <p className="pull-hint">Pull down or tap Refresh for the latest status.</p>
    </main>
  );
}
