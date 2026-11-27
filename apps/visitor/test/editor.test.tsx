import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogManifest, sprites } from '@natcut/render/browser';
import { canonicalManifestJson, type GeometryReport } from '@natcut/domain';
import { CutPreview, EditorPage, fixtureManifest, overlapFixtureManifest, QueuePage, type VisitorApi } from '../src/index.ts';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function warningReport(): GeometryReport {
  return {
    valid: true,
    severity: 'warning',
    issues: [{ code: 'CUT_CONTOURS_OVERLAP', severity: 'warning', message: 'Two cut borders touch.' }],
    contourCount: 2,
    pointCount: 20,
    cutLengthMm: 130,
    minimumContourGapMm: 0,
    edgeClearanceMm: 4,
    geometryVersion: 'natcut-geometry-v1',
    rasterHash: 'a'.repeat(64),
    acknowledgedByVisitor: false,
    acknowledgedAt: null,
  };
}

function loadVisibleArtwork(root: ParentNode = document): void {
  root.querySelectorAll('.sticker-preview image').forEach((node) => fireEvent.load(node));
}

function spriteRadio(id: string): HTMLInputElement {
  const radio = screen.getAllByRole<HTMLInputElement>('radio').find((input) => input.value === id);
  if (!radio) throw new Error(`Missing sprite radio ${id}`);
  return radio;
}

describe('mobile editor', () => {
  const alternate = sprites[1];
  const itWithAlternate = alternate ? it : it.skip;

  itWithAlternate('changes the artwork, discards old contours and warnings, and recovers both visible art and geometry', async () => {
    let port: EventTarget;
    const requests: { revision: number; manifest: typeof fixtureManifest }[] = [];
    vi.stubGlobal('Worker', class extends EventTarget {
      constructor() { super(); port = this; }
      postMessage(message: typeof requests[number]) { requests.push(message); }
    });
    const respond = (i: number, body: object) => {
      const { revision, manifest } = requests[i]!;
      act(() => { port.dispatchEvent(new MessageEvent('message', { data: {
        revision, manifestFingerprint: canonicalManifestJson(manifest), ...body,
      } })); });
    };
    const { container } = render(<EditorPage submitSubmission={vi.fn()} />);
    const paths = () => container.querySelectorAll('.sticker-preview path');
    const image = () => container.querySelector('.sticker-preview image')!.getAttribute('href');
    const oldImage = image();
    container.querySelectorAll('.sticker-preview image').forEach((node) => fireEvent.load(node));
    const warning = { report: warningReport(), contours: [[{ x: 10, y: 10 }, { x: 30, y: 20 }]] };
    respond(0, warning);
    expect(paths()).toHaveLength(1);
    fireEvent.click(spriteRadio(alternate!.id));
    expect(image()).not.toBe(oldImage);
    expect(paths()).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /checking cut/i })).toHaveProperty('disabled', true);
    respond(0, warning);
    expect(paths()).toHaveLength(0);
    respond(1, { error: 'Could not load artwork.' });
    expect(screen.getByRole('button', { name: /retry preview/i })).toHaveProperty('disabled', false);
    fireEvent.error(container.querySelector('.sticker-preview image')!);
    expect(screen.getByRole('alert').textContent).toMatch(/sprite|preview/i);
    const failedHref = image();
    fireEvent.click(screen.getByRole('button', { name: /retry preview/i }));
    expect(image()).not.toBe(failedHref);
    container.querySelectorAll('.sticker-preview image').forEach((node) => fireEvent.load(node));
    respond(2, { report: { ...warningReport(), severity: 'ok', issues: [] }, contours: [[{ x: 80, y: 90 }]] });
    expect(paths()[0]?.getAttribute('d')).toContain('80 90');
    expect(screen.getByRole('button', { name: /join print queue/i })).toHaveProperty('disabled', false);
  });

  itWithAlternate('rotates the submission key only when the selected design changes', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('Lost response'));
    render(<EditorPage submitSubmission={submit} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} />);
    loadVisibleArtwork();
    const clickSubmit = async () => {
      fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
      await screen.findByRole('alert');
    };
    await clickSubmit();
    fireEvent.click(screen.getByRole('button', { name: /standard/i }));
    await clickSubmit();
    fireEvent.click(spriteRadio(alternate!.id));
    loadVisibleArtwork();
    await clickSubmit();
    expect(submit.mock.calls[1]![0].idempotencyKey).toBe(submit.mock.calls[0]![0].idempotencyKey);
    expect(submit.mock.calls[2]![0].idempotencyKey).not.toBe(submit.mock.calls[0]![0].idempotencyKey);
    expect(submit.mock.calls[2]![0].manifest.spriteAssetId).not.toBe(submit.mock.calls[0]![0].manifest.spriteAssetId);
  });

  itWithAlternate('keeps the chosen design fixed while its ticket request is in flight', async () => {
    render(<EditorPage submitSubmission={() => new Promise(() => {})}
      previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} />);
    loadVisibleArtwork();
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    const pear = spriteRadio(alternate!.id);
    const wide = screen.getByRole('button', { name: /Wide/ });
    expect(pear.matches(':disabled')).toBe(true);
    expect(wide.matches(':disabled')).toBe(true);
  });

  it('uses sprite language and applies the exact cut-border presets', () => {
    render(<EditorPage submitSubmission={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /your sprite sticker/i })).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('plantemon');

    fireEvent.click(screen.getByRole('button', { name: /tight/i }));
    expect(screen.getByText('1.0 mm', { selector: 'output' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /standard/i }));
    expect(screen.getByText('1.5 mm', { selector: 'output' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /wide/i }));
    expect(screen.getByText('2.0 mm', { selector: 'output' })).toBeTruthy();
  });

  it('reveals a labelled custom slider and requests previews while dragging', () => {
    const onPreviewRequest = vi.fn();
    render(<EditorPage submitSubmission={vi.fn()} onPreviewRequest={onPreviewRequest} />);
    fireEvent.click(screen.getByRole('button', { name: /custom/i }));
    const slider = screen.getByRole('slider', { name: /custom cut border/i });
    fireEvent.change(slider, { target: { value: '2.4' } });
    expect(screen.getByText('2.4 mm', { selector: 'output' })).toBeTruthy();
    expect(onPreviewRequest).toHaveBeenLastCalledWith(expect.objectContaining({ cutMarginMm: 2.4 }), false);
    fireEvent.pointerUp(slider);
    expect(onPreviewRequest).toHaveBeenLastCalledWith(expect.objectContaining({ cutMarginMm: 2.4 }), true);
  });

  it('shows overlap as a warning and keeps Print anyway enabled', () => {
    render(<EditorPage submitSubmission={vi.fn()} previewReportOverride={warningReport()} />);
    loadVisibleArtwork();
    expect(screen.getByRole('alert').textContent).toMatch(/two cut borders touch/i);
    expect(screen.getByRole('button', { name: /print anyway/i })).not.toHaveProperty('disabled', true);
  });

  it('submits the warning acknowledgement bound to the exact preview hash', async () => {
    const submitSubmission = vi.fn().mockResolvedValue({
      submissionId: 'submission-1',
      statusToken: 'opaque-token',
      queueNumber: 1,
      jobsAhead: 0,
      publicStatus: 'queued',
    });
    render(
      <EditorPage
        submitSubmission={submitSubmission}
        previewReportOverride={warningReport()}
        onNavigate={vi.fn()}
      />,
    );
    loadVisibleArtwork();
    fireEvent.click(screen.getByRole('button', { name: /print anyway/i }));

    await waitFor(() => expect(submitSubmission).toHaveBeenCalledTimes(1));
    expect(submitSubmission).toHaveBeenCalledWith(expect.objectContaining({
      manifest: catalogManifest,
      warningAcknowledgement: expect.objectContaining({
        geometryVersion: 'natcut-geometry-v1',
        rasterHash: 'a'.repeat(64),
        manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        issuesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it('reuses one idempotency key when retrying the unchanged draft', async () => {
    const submitSubmission = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ submissionId: 'submission-1', statusToken: 'token' });
    render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={vi.fn()} />);
    loadVisibleArtwork();
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await waitFor(() => expect(submitSubmission).toHaveBeenCalledTimes(2));
    expect(submitSubmission.mock.calls[0]![0].idempotencyKey).toBe(submitSubmission.mock.calls[1]![0].idempotencyKey);
  });

  it('recovers the original accepted ticket after a committed response is lost and the editor reloads', async () => {
    const accepted = {
      submissionId: 'submission-original',
      statusToken: 'original-status-token',
      queueNumber: 4,
      jobsAhead: 3,
      publicStatus: 'queued' as const,
    };
    let committedKey = '';
    const submitSubmission = vi.fn(async (request: { idempotencyKey: string }) => {
      if (!committedKey) {
        committedKey = request.idempotencyKey;
        throw new Error('response lost after commit');
      }
      expect(request.idempotencyKey).toBe(committedKey);
      return accepted;
    });
    const onNavigate = vi.fn();
    const first = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={onNavigate} />);
    loadVisibleArtwork(first.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await screen.findByRole('alert');
    expect(sessionStorage.getItem(`natcut:status:${accepted.submissionId}`)).toBeNull();

    first.unmount();
    const reloaded = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={onNavigate} />);
    loadVisibleArtwork(reloaded.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(`/queue/${accepted.submissionId}#token=${accepted.statusToken}`));
    expect(submitSubmission).toHaveBeenCalledTimes(2);
    expect(submitSubmission.mock.calls[1]![0].idempotencyKey).toBe(submitSubmission.mock.calls[0]![0].idempotencyKey);
    const stored = JSON.parse(sessionStorage.getItem('natcut:submission-attempt:v1')!);
    expect(stored).toEqual(expect.objectContaining({ state: 'accepted', submissionId: accepted.submissionId }));
    expect(JSON.stringify(stored)).not.toContain(accepted.statusToken);
  });

  it('redirects without another POST after a crash between acceptance and navigation', async () => {
    const accepted = {
      submissionId: 'submission-accepted', statusToken: 'accepted-token', queueNumber: 1, jobsAhead: 0, publicStatus: 'queued' as const,
    };
    const submitSubmission = vi.fn().mockResolvedValue(accepted);
    const interruptedNavigation = vi.fn();
    const first = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={interruptedNavigation} />);
    loadVisibleArtwork(first.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await waitFor(() => expect(interruptedNavigation).toHaveBeenCalledTimes(1));
    first.unmount();

    const recoveredNavigation = vi.fn();
    render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={recoveredNavigation} />);

    await waitFor(() => expect(recoveredNavigation).toHaveBeenCalledWith(`/queue/${accepted.submissionId}#token=${accepted.statusToken}`));
    expect(submitSubmission).toHaveBeenCalledTimes(1);
  });

  it('keeps the accepted fence when the queue page cannot confirm the ticket', async () => {
    const accepted = {
      submissionId: 'submission-accepted', statusToken: 'accepted-token', queueNumber: 1, jobsAhead: 0, publicStatus: 'queued' as const,
    };
    const onNavigate = vi.fn();
    const editor = render(<EditorPage submitSubmission={vi.fn().mockResolvedValue(accepted)} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={onNavigate} />);
    loadVisibleArtwork(editor.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    editor.unmount();

    const queueApi = { getStatus: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as VisitorApi;
    render(<QueuePage submissionId={accepted.submissionId} statusToken={accepted.statusToken} api={queueApi} />);
    await screen.findByRole('alert');

    expect(JSON.parse(sessionStorage.getItem('natcut:submission-attempt:v1')!)).toEqual(expect.objectContaining({
      state: 'accepted', submissionId: accepted.submissionId,
    }));
  });

  it('starts a fresh attempt for a later intentional same-design submission after acceptance', async () => {
    const submitSubmission = vi.fn()
      .mockResolvedValueOnce({
        submissionId: 'submission-first', statusToken: 'token-first', queueNumber: 1, jobsAhead: 0, publicStatus: 'queued',
      })
      .mockResolvedValueOnce({
        submissionId: 'submission-second', statusToken: 'token-second', queueNumber: 2, jobsAhead: 1, publicStatus: 'queued',
      });
    const firstNavigate = vi.fn();
    const first = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={firstNavigate} />);
    loadVisibleArtwork(first.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await waitFor(() => expect(firstNavigate).toHaveBeenCalledTimes(1));
    first.unmount();
    expect(JSON.parse(sessionStorage.getItem('natcut:submission-attempt:v1')!).state).toBe('accepted');

    const queueApi = {
      getStatus: vi.fn().mockResolvedValue({
        submissionId: 'submission-first', publicStatus: 'queued', queueNumber: 1, jobsAhead: 0,
        canLeaveQueue: true, updatedAt: '2026-11-28T00:00:00.000Z',
      }),
    } as unknown as VisitorApi;
    const queue = render(<QueuePage submissionId="submission-first" statusToken="token-first" api={queueApi} />);
    await waitFor(() => expect(queueApi.getStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sessionStorage.getItem('natcut:submission-attempt:v1')).toBeNull());
    queue.unmount();

    const secondNavigate = vi.fn();
    const second = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={secondNavigate} />);
    loadVisibleArtwork(second.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await waitFor(() => expect(secondNavigate).toHaveBeenCalledTimes(1));

    expect(submitSubmission).toHaveBeenCalledTimes(2);
    expect(submitSubmission.mock.calls[1]![0].idempotencyKey).not.toBe(submitSubmission.mock.calls[0]![0].idempotencyKey);
  });

  it('does not clear a newer attempt that replaced the accepted one while its response was in flight', async () => {
    const submitSubmission = vi.fn(async () => {
      const stored = JSON.parse(sessionStorage.getItem('natcut:submission-attempt:v1')!);
      sessionStorage.setItem('natcut:submission-attempt:v1', JSON.stringify({ ...stored, idempotencyKey: 'newer-attempt-key' }));
      return { submissionId: 'submission-first', statusToken: 'token-first', queueNumber: 1, jobsAhead: 0, publicStatus: 'queued' as const };
    });
    const onNavigate = vi.fn();
    const view = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={onNavigate} />);
    loadVisibleArtwork(view.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));

    expect(JSON.parse(sessionStorage.getItem('natcut:submission-attempt:v1')!).idempotencyKey).toBe('newer-attempt-key');
  });

  it('keeps the accepted attempt when its status token cannot be stored', async () => {
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'natcut:status:submission-first') throw new Error('storage full');
      nativeSetItem.call(this, key, value);
    });
    const submitSubmission = vi.fn().mockResolvedValue({
      submissionId: 'submission-first', statusToken: 'token-first', queueNumber: 1, jobsAhead: 0, publicStatus: 'queued',
    });
    const view = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} onNavigate={vi.fn()} />);
    loadVisibleArtwork(view.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await screen.findByRole('alert');

    const stored = JSON.parse(sessionStorage.getItem('natcut:submission-attempt:v1')!);
    expect(stored.idempotencyKey).toBe(submitSubmission.mock.calls[0]![0].idempotencyKey);
  });

  it('does not trust corrupt attempt storage', async () => {
    sessionStorage.setItem('natcut:submission-attempt:v1', '{not-json');
    const submitSubmission = vi.fn().mockRejectedValue(new Error('offline'));
    const view = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} />);
    loadVisibleArtwork(view.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));

    await screen.findByRole('alert');
    expect(submitSubmission).toHaveBeenCalledTimes(1);
    expect(submitSubmission.mock.calls[0]![0].idempotencyKey).toEqual(expect.any(String));
  });

  it('does not POST when the attempt cannot be persisted first', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
    const submitSubmission = vi.fn();
    const view = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} />);
    loadVisibleArtwork(view.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be saved/i);
    expect(submitSubmission).not.toHaveBeenCalled();
  });

  it('rotates a stored attempt when an explicit requeue changes the request source', async () => {
    const submitSubmission = vi.fn().mockRejectedValue(new Error('offline'));
    const first = render(<EditorPage submitSubmission={submitSubmission} previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} />);
    loadVisibleArtwork(first.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await screen.findByRole('alert');
    first.unmount();

    const requeue = render(<EditorPage submitSubmission={submitSubmission} requeuedFrom="submission-previous" previewReportOverride={{ ...warningReport(), severity: 'ok', issues: [] }} />);
    loadVisibleArtwork(requeue.container);
    fireEvent.click(screen.getByRole('button', { name: /join print queue/i }));
    await screen.findByRole('alert');

    expect(submitSubmission).toHaveBeenCalledTimes(2);
    expect(submitSubmission.mock.calls[1]![0].idempotencyKey).not.toBe(submitSubmission.mock.calls[0]![0].idempotencyKey);
  });

  it('previews every trusted composition layer instead of a hardcoded single sprite', () => {
    const { container } = render(<CutPreview manifest={overlapFixtureManifest} contours={[]} />);
    expect(container.querySelectorAll('image')).toHaveLength(3);
    expect(container.querySelector('text')).toBeNull();
  });

  it('reports visible artwork loading, failure, reload and readiness', async () => {
    const onArtworkState = vi.fn();
    const { container, rerender } = render(
      <CutPreview manifest={catalogManifest} contours={[]} reloadKey={0} onArtworkState={onArtworkState} />,
    );
    await waitFor(() => expect(onArtworkState).toHaveBeenLastCalledWith('loading'));
    const firstHref = container.querySelector('image')!.getAttribute('href');
    container.querySelectorAll('image').forEach((node) => fireEvent.load(node));
    expect(onArtworkState).toHaveBeenLastCalledWith('ready');
    fireEvent.error(container.querySelector('image')!);
    expect(onArtworkState).toHaveBeenLastCalledWith('error');
    rerender(<CutPreview manifest={catalogManifest} contours={[]} reloadKey={1} onArtworkState={onArtworkState} />);
    expect(container.querySelector('image')!.getAttribute('href')).not.toBe(firstHref);
    await waitFor(() => expect(onArtworkState).toHaveBeenLastCalledWith('loading'));
  });
});
