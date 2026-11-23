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

  it('rejoins from a cancelled submission as a new immutable request', async () => {
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
    await waitFor(() => expect(visitorApi.submit).toHaveBeenCalledTimes(1));
    expect(visitorApi.submit).toHaveBeenCalledWith(expect.objectContaining({ requeuedFrom: 'submission-1' }));
    expect(onNavigate).toHaveBeenCalledWith('/queue/submission-2#token=new-token');
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
