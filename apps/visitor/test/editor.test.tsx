import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeometryReport } from '@natcut/domain';
import { EditorPage, fixtureManifest } from '../src/index.ts';

afterEach(cleanup);

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

describe('mobile editor', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /print anyway/i }));

    await waitFor(() => expect(submitSubmission).toHaveBeenCalledTimes(1));
    expect(submitSubmission).toHaveBeenCalledWith(expect.objectContaining({
      manifest: fixtureManifest,
      warningAcknowledgement: {
        geometryVersion: 'natcut-geometry-v1',
        rasterHash: 'a'.repeat(64),
      },
    }));
  });
});
