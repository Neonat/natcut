import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueuePage, VisitorApp, type PublicQueueStatus, type VisitorApi } from '../src/index.ts';

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
    submitSurvey: vi.fn().mockResolvedValue({ surveyId: 'survey-1', created: true }),
    getSurveyStatus: vi.fn().mockResolvedValue({ eligible: true, submitted: false }),
  } as unknown as VisitorApi;
}

describe('visitor simulation', () => {
  it('labels the rehearsal editor before visitors submit', () => {
    render(<VisitorApp api={api()} simulation />);
    expect(screen.getByText(/simulation rehearsal/i)).toBeTruthy();
  });

  it('explains that a ready simulation ticket has no physical sticker', async () => {
    render(<QueuePage submissionId="submission-1" statusToken="token" api={api('ready')} simulation />);
    expect(await screen.findByRole('heading', { name: 'Ready for pickup' })).toBeTruthy();
    expect(screen.getByText(/no physical sticker was made/i)).toBeTruthy();
    expect(screen.queryByText(/show this screen at the sprout booth/i)).toBeNull();
  });
});

describe('queue page', () => {
  it('explains a token-free link opened without the original tab storage', () => {
    const visitorApi = api();
    render(<QueuePage submissionId="submission-1" statusToken="" api={visitorApi} />);
    expect(screen.getByRole('heading', { name: /open your original queue tab/i })).toBeTruthy();
    expect(visitorApi.getStatus).not.toHaveBeenCalled();
  });
  it('offers feedback only after the sticker is collected', async () => {
    const view = render(<QueuePage submissionId="submission-1" statusToken="token" api={api('ready')} />);
    await screen.findByRole('heading', { name: /ready for pickup/i });
    expect(screen.queryByRole('heading', { name: /are the stickers cute/i })).toBeNull();

    view.unmount();
    render(<QueuePage submissionId="submission-1" statusToken="token" api={api('collected')} />);
    expect(await screen.findByRole('heading', { name: /are the stickers cute/i })).toBeTruthy();
  });

  it('hides marketing fields from a non-owner and restores thanks for the original session', async () => {
    const otherApi = api('collected');
    vi.mocked(otherApi.getSurveyStatus).mockResolvedValue({ eligible: false, submitted: false });
    const view = render(<QueuePage submissionId="submission-1" statusToken="token" api={otherApi} />);
    await screen.findByRole('heading', { name: /sticker collected/i });
    await waitFor(() => expect(otherApi.getSurveyStatus).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox', { name: /product updates/i })).toBeNull();

    view.unmount();
    const ownerApi = api('collected');
    vi.mocked(ownerApi.getSurveyStatus).mockResolvedValue({ eligible: true, submitted: true });
    render(<QueuePage submissionId="submission-1" statusToken="token" api={ownerApi} />);
    expect(await screen.findByText(/thanks for your feedback/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /send feedback/i })).toBeNull();
  });

  it('requires a rating and submits opt-out feedback without an email field', async () => {
    const visitorApi = api('collected');
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    const send = await screen.findByRole('button', { name: /send feedback/i });
    expect(send).toHaveProperty('disabled', true);
    expect(screen.queryByRole('textbox', { name: /email/i })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    fireEvent.click(send);
    await waitFor(() => expect(visitorApi.submitSurvey).toHaveBeenCalledWith({
      stickerSubmissionId: 'submission-1',
      cuteRating: 5,
      marketingOptIn: false,
    }));
    expect(await screen.findByText(/thanks for your feedback/i)).toBeTruthy();
  });

  it('keeps product email optional and requires a valid address only after opt-in', async () => {
    const visitorApi = api('collected');
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    fireEvent.click(await screen.findByRole('radio', { name: '4 stars' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /email me sprout product updates/i }));
    const email = screen.getByRole('textbox', { name: /email/i });
    const send = screen.getByRole('button', { name: /send feedback/i });
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(email, { target: { value: ' Person@Example.COM ' } });
    fireEvent.click(send);

    await waitFor(() => expect(visitorApi.submitSurvey).toHaveBeenCalledWith({
      stickerSubmissionId: 'submission-1',
      cuteRating: 4,
      marketingOptIn: true,
      email: 'Person@Example.COM',
    }));
  });

  it('keeps the collected ticket intact after failure and accepts an idempotent retry', async () => {
    const visitorApi = api('collected');
    vi.mocked(visitorApi.submitSurvey)
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ surveyId: 'survey-1', created: false });
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    fireEvent.click(await screen.findByRole('radio', { name: '3 stars' }));
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('Network unavailable');
    expect(screen.getByRole('heading', { name: /sticker collected/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByText(/thanks for your feedback/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /sticker collected/i })).toBeTruthy();
  });

  it('freezes the displayed rating and consent choices while sending', async () => {
    const visitorApi = api('collected');
    let finish!: () => void;
    vi.mocked(visitorApi.submitSurvey).mockReturnValue(new Promise((resolve) => {
      finish = () => resolve({ surveyId: 'survey-1', created: true });
    }));
    render(<QueuePage submissionId="submission-1" statusToken="token" api={visitorApi} />);
    const rating = await screen.findByRole('radio', { name: '5 stars' });
    const optIn = screen.getByRole('checkbox', { name: /email me sprout product updates/i });
    fireEvent.click(rating);
    fireEvent.click(optIn);
    fireEvent.change(screen.getByRole('textbox', { name: /email/i }), { target: { value: 'person@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(rating).toHaveProperty('disabled', true);
    expect(optIn).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: /email/i })).toHaveProperty('disabled', true);
    finish();
    expect(await screen.findByText(/thanks for your feedback/i)).toBeTruthy();
  });

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
