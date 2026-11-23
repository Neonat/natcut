import { CompositionManifestSchema, type CompositionManifest, type GeometryReport } from '@natcut/domain';
import { useEffect, useState } from 'react';
import type { SubmissionRequest, SubmissionResponse } from '../api.ts';
import { CutBorderControl } from './cut-border-control.tsx';
import { CutPreview } from './cut-preview.tsx';
import { useCutPreview } from './use-cut-preview.ts';

export const fixtureManifest: CompositionManifest = CompositionManifestSchema.parse({
  schemaVersion: 1,
  spriteAssetId: 'sprite/monstera-v1',
  trainerAssetId: null,
  theme: 'default',
  brandingVariant: 'logo',
  cutGroups: [
    { id: 'main', members: ['sprite'] },
    { id: 'brand', members: ['branding'] },
  ],
  cutMarginMm: 1.5,
  renderVersion: 'fixture-v1',
});

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export type EditorPageProps = {
  submitSubmission: (request: SubmissionRequest) => Promise<SubmissionResponse>;
  onNavigate?: (path: string) => void;
  onPreviewRequest?: (manifest: CompositionManifest, immediate: boolean) => void;
  previewReportOverride?: GeometryReport;
  requeuedFrom?: string;
};

export function EditorPage(props: EditorPageProps) {
  const [manifest, setManifest] = useState(fixtureManifest);
  const [custom, setCustom] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useCutPreview();
  const report = props.previewReportOverride ?? preview.result?.report ?? null;

  useEffect(() => {
    preview.release(manifest);
    // Initial exact preview; later requests are driven by the border control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateMargin = (cutMarginMm: number, immediate: boolean) => {
    const next = CompositionManifestSchema.parse({ ...manifest, cutMarginMm });
    setManifest(next);
    props.onPreviewRequest?.(next, immediate);
    if (immediate) preview.release(next);
    else preview.move(next);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const request: SubmissionRequest = {
      manifest,
      idempotencyKey: requestId(),
      ...(props.requeuedFrom ? { requeuedFrom: props.requeuedFrom } : {}),
      ...(report?.severity === 'warning'
        ? { warningAcknowledgement: { geometryVersion: report.geometryVersion, rasterHash: report.rasterHash } }
        : {}),
    };
    try {
      const accepted = await props.submitSubmission(request);
      sessionStorage.setItem(`natcut:status:${accepted.submissionId}`, accepted.statusToken);
      setManifest(fixtureManifest);
      const path = `/queue/${accepted.submissionId}#token=${accepted.statusToken}`;
      if (props.onNavigate) props.onNavigate(path);
      else window.location.assign(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join the queue. Try again.');
      setSubmitting(false);
    }
  };

  const structuralError = report?.severity === 'error';
  return (
    <main className="editor-page">
      <header className="brand-bar"><span className="brand-mark">sprout</span><span>Sticker studio</span></header>
      <div className="page-intro">
        <p className="step-pill">Final look</p>
        <h1>Your sprite sticker</h1>
        <p>Pick the border, check the cut line, then join the print queue.</p>
      </div>
      <CutPreview marginMm={manifest.cutMarginMm} contours={preview.result?.contours ?? []} />
      <CutBorderControl
        value={manifest.cutMarginMm}
        custom={custom}
        onPreset={(value) => { setCustom(false); updateMargin(value, true); }}
        onCustom={() => setCustom(true)}
        onCustomChange={(value) => updateMargin(value, false)}
        onCustomRelease={() => updateMargin(manifest.cutMarginMm, true)}
      />
      {report?.issues.length ? (
        <div className={structuralError ? 'notice error' : 'notice warning'} role="alert">
          <strong>{structuralError ? 'This design cannot print yet' : 'Check the cut border'}</strong>
          <span>{report.issues[0]!.message}</span>
        </div>
      ) : null}
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      <div className="sticky-action">
        <button className="primary-action" type="button" disabled={submitting || structuralError} onClick={() => void submit()}>
          {submitting ? 'Joining queue…' : report?.severity === 'warning' ? 'Print anyway' : 'Join print queue'}
        </button>
      </div>
    </main>
  );
}
