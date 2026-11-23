import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueuePage, type PublicQueueStatus, type VisitorApi } from '../src/index.ts';

afterEach(cleanup);

function status(publicStatus: PublicQueueStatus['publicStatus']): PublicQueueStatus {
  return {
    submissionId: 'submission-1',
    publicStatus,
    queueNumber: 2,
    jobsAhead: 1,
    canLeaveQueue: publicStatus === 'joining' || publicStatus === 'queued',
    updatedAt: '2026-11-23T12:00:00.000Z',
  };
}

function api(publicStatus: PublicQueueStatus['publicStatus'] = 'queued'): VisitorApi {
  return {
    submit: vi.fn().mockResolvedValue({ submissionId: 'submission-2', statusToken: 'new-token' }),
    getStatus: vi.fn().mockResolvedValue(status(publicStatus)),
    leave: vi.fn().mockResolvedValue({ submissionId: 'submission-1', publicStatus: 'cancelled' }),
  } as unknown as VisitorApi;
}

describe('queue page', () => {
  it('refreshes explicitly and uses the same refresh for a pull-down gesture', async () => {
    const visitorApi = api();
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    await screen.findByText(/1 ahead/i);
    expect(visitorApi.getStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(visitorApi.getStatus).toHaveBeenCalledTimes(2));

    const page = screen.getByTestId('queue-page');
    fireEvent.touchStart(page, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(page);
    await waitFor(() => expect(visitorApi.getStatus).toHaveBeenCalledTimes(3));
  });

  it('enables Leave queue while queued and disables it at You’re next', async () => {
    const queuedApi = api('queued');
    const view = render(<QueuePage submissionId="submission-1" statusToken="token" api={queuedApi} />);
    expect(await screen.findByRole('button', { name: /leave queue/i })).not.toHaveProperty('disabled', true);

    view.unmount();
    const nextApi = api('next');
    render(<QueuePage submissionId="submission-1" statusToken="token" api={nextApi} />);
    expect(await screen.findByRole('heading', { name: /you’re next/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /leave queue/i })).toHaveProperty('disabled', true);
  });

  it('opens a fresh editable draft when rejoining from a cancelled submission', async () => {
    const visitorApi = api('cancelled');
    const onNavigate = vi.fn();
    render(
      <QueuePage
        submissionId="submission-1"
        statusToken="token"
        api={visitorApi}
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /rejoin queue/i }));
    expect(visitorApi.submit).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('/edit?requeuedFrom=submission-1');
  });

  it('refreshes into the locked state when the worker wins the leave race', async () => {
    const visitorApi = api('queued');
    vi.mocked(visitorApi.leave).mockRejectedValueOnce(new Error('QUEUE_LEAVE_LOCKED'));
    vi.mocked(visitorApi.getStatus)
      .mockResolvedValueOnce(status('queued'))
      .mockResolvedValueOnce(status('next'));
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    fireEvent.click(await screen.findByRole('button', { name: /leave queue/i }));
    expect(await screen.findByRole('heading', { name: /you’re next/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /leave queue/i })).toHaveProperty('disabled', true);
  });

  it('surfaces a connectivity error when leaving fails', async () => {
    const visitorApi = api('queued');
    vi.mocked(visitorApi.leave).mockRejectedValueOnce(new Error('Network unavailable'));
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    fireEvent.click(await screen.findByRole('button', { name: /leave queue/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable');
  });

  it('does not let an older refresh overwrite a successful leave', async () => {
    const visitorApi = api('queued');
    let resolveStale!: (value: PublicQueueStatus) => void;
    const stale = new Promise<PublicQueueStatus>((resolve) => { resolveStale = resolve; });
    vi.mocked(visitorApi.getStatus)
      .mockResolvedValueOnce(status('queued'))
      .mockReturnValueOnce(stale);
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    await screen.findByText(/1 ahead/i);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    fireEvent.click(screen.getByRole('button', { name: /leave queue/i }));
    expect(await screen.findByRole('button', { name: /rejoin queue/i })).toBeTruthy();
    resolveStale(status('queued'));
    await Promise.resolve();
    expect(screen.getByRole('button', { name: /rejoin queue/i })).toBeTruthy();
    expect(screen.queryByText(/1 ahead/i)).toBeNull();
  });

  it('does not start a refresh while Leave is pending', async () => {
    const visitorApi = api('queued');
    let finishLeave!: () => void;
    vi.mocked(visitorApi.leave).mockReturnValueOnce(new Promise((resolve) => {
      finishLeave = () => resolve({ submissionId: 'submission-1', publicStatus: 'cancelled' });
    }));
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    await screen.findByText(/1 ahead/i);
    fireEvent.click(screen.getByRole('button', { name: /leave queue/i }));
    expect(screen.getByRole('button', { name: /refresh/i })).toHaveProperty('disabled', true);
    const page = screen.getByTestId('queue-page');
    fireEvent.touchStart(page, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(page, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(page);
    expect(visitorApi.getStatus).toHaveBeenCalledTimes(1);
    finishLeave();
    expect(await screen.findByRole('button', { name: /rejoin queue/i })).toBeTruthy();
  });

  it.each([
    ['printing', /your sticker is being made/i],
    ['ready', /ready for pickup/i],
  ] as const)('shows plain visitor copy for %s without internal jargon', async (publicStatus, expected) => {
    render(<QueuePage submissionId="submission-1" statusToken="token" api={api(publicStatus)} />);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/upload|plt|laminat|eject/i);
  });

  it('does not render editor controls after submission', async () => {
    render(<QueuePage submissionId="submission-1" statusToken="token" api={api()} />);
    await screen.findByText(/1 ahead/i);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('button', { name: /tight|standard|wide|custom/i })).toBeNull();
  });
});
