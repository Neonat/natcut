import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogManifest, sprites } from '@natcut/render/browser';
import { canonicalManifestJson, type GeometryReport } from '@natcut/domain';
import { CutPreview, EditorPage, fixtureManifest, overlapFixtureManifest } from '../src/index.ts';

afterEach(() => {
  cleanup();
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
