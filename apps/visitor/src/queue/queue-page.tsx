import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicQueueStatus, VisitorApi } from '../api.ts';
import { usePullToRefresh } from './use-pull-to-refresh.ts';

const statusCopy = {
  joining: { title: 'Joining the queue', detail: 'Saving your sticker…' },
  queued: { title: 'In the print queue', detail: null },
  next: { title: 'You’re next', detail: 'Stay nearby—we’ll start your sticker soon.' },
  printing: { title: 'Your sticker is being made', detail: 'We’ll update this page when it is ready.' },
  ready: { title: 'Ready for pickup', detail: 'Show this screen at the Sprout booth.' },
  collected: { title: 'Sticker collected', detail: 'Thanks for growing with Sprout.' },
  cancelled: { title: 'You left the queue', detail: 'Rejoin at the back when you are ready.' },
} as const;

export function QueuePage(props: { submissionId: string; statusToken: string; api: VisitorApi; simulation?: boolean; onNavigate?: (path: string) => void }) {
  const [status, setStatus] = useState<PublicQueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const leavingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (leavingRef.current) return;
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const latest = await props.api.getStatus(props.submissionId, props.statusToken);
      if (generation === refreshGeneration.current) setStatus(latest);
    } catch (cause) {
      if (generation === refreshGeneration.current) {
        setError(cause instanceof Error ? cause.message : 'Could not refresh. Try again.');
      }
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [props.api, props.statusToken, props.submissionId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const pullHandlers = usePullToRefresh(() => { void refresh(); });

  const leave = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    refreshGeneration.current++;
    setLoading(false);
    setError(null);
    try {
      await props.api.leave(props.submissionId, props.statusToken);
      refreshGeneration.current++;
      setLoading(false);
      setStatus((current) => current ? { ...current, publicStatus: 'cancelled', canLeaveQueue: false, jobsAhead: 0 } : current);
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'QUEUE_LEAVE_LOCKED') {
        leavingRef.current = false;
        setLeaving(false);
        await refresh();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not leave the queue. Try again.');
    } finally {
      leavingRef.current = false;
      setLeaving(false);
    }
  };

  const rejoin = () => {
    const path = `/edit?requeuedFrom=${encodeURIComponent(props.submissionId)}`;
    if (props.onNavigate) props.onNavigate(path);
    else window.location.assign(path);
  };

  const copy = status ? statusCopy[status.publicStatus] : null;
  const detail = props.simulation && status?.publicStatus === 'ready'
    ? 'Simulation complete. No physical sticker was made.'
    : copy?.detail;
  return (
    <main className="queue-page" data-testid="queue-page" {...pullHandlers}>
      <header className="brand-bar"><span className="brand-mark">sprout</span><span>Print queue</span></header>
      <section className="queue-status" aria-live="polite">
        <div className={`status-orbit ${status?.publicStatus ?? 'loading'}`} aria-hidden="true"><span /></div>
        {copy ? <h1>{copy.title}</h1> : <h1>Checking your place…</h1>}
        {status?.publicStatus === 'queued' ? <p className="queue-number">{status.jobsAhead === 0 ? 'No jobs ahead' : `${status.jobsAhead} ahead`}</p> : detail ? <p>{detail}</p> : null}
        {status ? <p className="ticket-number">Queue #{status.queueNumber}</p> : null}
      </section>
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      <div className="queue-actions">
        <button className="secondary-action" type="button" onClick={() => void refresh()} disabled={loading || leaving}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        {status && status.publicStatus !== 'cancelled' && status.publicStatus !== 'collected' ? (
          <button className="text-action" type="button" onClick={() => void leave()} disabled={!status.canLeaveQueue}>Leave queue</button>
        ) : null}
        {status?.publicStatus === 'cancelled' ? <button className="primary-action" type="button" onClick={rejoin}>Rejoin queue</button> : null}
      </div>
      <p className="pull-hint">Pull down or tap Refresh for the latest status.</p>
    </main>
  );
}
