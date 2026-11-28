import {
  canonicalManifestJson,
  CompositionManifestSchema,
  geometryIssuesHash,
  manifestHash,
  type CompositionManifest,
  type GeometryReport,
} from '@natcut/domain';
import { catalogManifest, legacyManifest } from '@natcut/render/browser';
import { useEffect, useRef, useState } from 'react';
import type { SubmissionRequest, SubmissionResponse } from '../api.ts';
import { CutBorderControl } from './cut-border-control.tsx';
import { CutPreview } from './cut-preview.tsx';
import { SpritePicker } from './sprite-picker.tsx';
import {
  acceptedSubmissionAttempt,
  markSubmissionAttemptAccepted,
  restoreOrCreateSubmissionAttempt,
  submissionAttemptBinding,
  type SubmissionAttempt,
} from './submission-attempt.ts';
import { useCutPreview } from './use-cut-preview.ts';
import sproutWordmark from '../assets/sprout-wordmark.png';

export const fixtureManifest = legacyManifest;

export const overlapFixtureManifest: CompositionManifest = CompositionManifestSchema.parse({
  ...fixtureManifest,
  trainerAssetId: 'trainer/friend-v1',
  theme: 'battling',
  cutGroups: [
    { id: 'trainer', members: ['trainer'] },
    { id: 'sprite', members: ['sprite'] },
    { id: 'brand', members: ['branding'] },
  ],
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
  initialManifest?: CompositionManifest;
  runtimeSpriteUrl?: string;
  lockSpriteChoice?: boolean;
};

export function EditorPage(props: EditorPageProps) {
  const initialManifest = props.initialManifest ?? catalogManifest;
  const [manifest, setManifest] = useState(initialManifest);
  const [custom, setCustom] = useState(() => ![1, 1.5, 2].includes(initialManifest.cutMarginMm));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artworkState, setArtworkState] = useState<'loading' | 'ready' | 'error'>(props.previewReportOverride ? 'ready' : 'loading');
  const [assetReload, setAssetReload] = useState(0);
  const preview = useCutPreview(undefined, props.runtimeSpriteUrl);
  const current = preview.result?.manifestFingerprint === canonicalManifestJson(manifest) ? preview.result : null;
  const report = props.previewReportOverride ?? current?.report;
  const submissionAttempt = useRef<SubmissionAttempt | null>(null);

  useEffect(() => { preview.release(initialManifest); }, []);
  useEffect(() => {
    const accepted = acceptedSubmissionAttempt(submissionAttemptBinding(initialManifest, props.requeuedFrom));
    if (!accepted) return;
    let statusToken: string | null;
    try { statusToken = sessionStorage.getItem(`natcut:status:${accepted.submissionId}`); }
    catch { return; }
    if (!statusToken) return;
    const path = `/queue/${accepted.submissionId}#token=${statusToken}`;
    if (props.onNavigate) props.onNavigate(path);
    else window.location.assign(path);
  }, []);

  const update = (next: CompositionManifest, immediate: boolean) => {
    if (canonicalManifestJson(next) !== canonicalManifestJson(manifest)) {
      if (next.spriteAssetId !== manifest.spriteAssetId) setArtworkState('loading');
      setManifest(next);
      setError(null);
    }
    props.onPreviewRequest?.(next, immediate);
    if (immediate) preview.release(next);
    else preview.move(next);
  };

  const updateMargin = (cutMarginMm: number, immediate: boolean) => {
    update(CompositionManifestSchema.parse({ ...manifest, cutMarginMm }), immediate);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const binding = submissionAttemptBinding(manifest, props.requeuedFrom);
      const attempt = submissionAttempt.current?.binding === binding
        ? submissionAttempt.current
        : restoreOrCreateSubmissionAttempt(binding, requestId);
      submissionAttempt.current = attempt;
      const request: SubmissionRequest = {
        manifest,
        idempotencyKey: attempt.idempotencyKey,
        ...(props.requeuedFrom ? { requeuedFrom: props.requeuedFrom } : {}),
        ...(report?.severity === 'warning'
          ? { warningAcknowledgement: {
            geometryVersion: report.geometryVersion,
            rasterHash: report.rasterHash,
            manifestHash: await manifestHash(manifest),
            issuesHash: await geometryIssuesHash(report.issues),
          } }
          : {}),
      };
      const accepted = await props.submitSubmission(request);
      sessionStorage.setItem(`natcut:status:${accepted.submissionId}`, accepted.statusToken);
      markSubmissionAttemptAccepted(attempt, accepted.submissionId);
      if (manifest.renderVersion === 'catalog-v1') {
        try { sessionStorage.setItem(`natcut:draft:${accepted.submissionId}`, JSON.stringify(manifest)); }
        catch { /* A full tab store should still open the accepted ticket. */ }
      }
      const path = `/queue/${accepted.submissionId}#token=${accepted.statusToken}`;
      if (props.onNavigate) props.onNavigate(path);
      else window.location.assign(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not join the queue. Try again.');
      setSubmitting(false);
    }
  };

  const structuralError = report?.severity === 'error';
  const previewFailed = Boolean(current?.error) || artworkState === 'error';
  const retryPreview = () => {
    setArtworkState('loading');
    setAssetReload((value) => value + 1);
    preview.release(manifest);
  };
  return (
    <main className="editor-page">
      <header className="brand-bar"><img className="brand-wordmark" src={sproutWordmark} alt="Sprout" /><span>Sticker studio</span></header>
      <div className="page-intro">
        <h1>Your sprite sticker</h1>
      </div>
      <fieldset className="studio-layout" disabled={submitting} aria-label="Sticker design">
        {manifest.renderVersion === 'catalog-v1' && !props.lockSpriteChoice && (
          <SpritePicker selected={manifest.spriteAssetId} reloadKey={assetReload}
            onChange={(spriteAssetId) => update({ ...manifest, spriteAssetId }, true)} />
        )}
        {manifest.trainerAssetId === null && <div className="sheet-variants" role="group" aria-label="Choose sticker sheet layout">
          <p className="eyebrow">Your sheet</p><h2>Choose a layout</h2>
          <div className="sheet-variant-options">
            {([['classic', 'One large sticker'], ['duo', 'Two stickers'], ['trio', 'Three stickers']] as const).map(([value, label]) =>
              <button key={value} type="button" className={(manifest.sheetVariant ?? 'classic') === value ? 'selected' : ''}
                aria-pressed={(manifest.sheetVariant ?? 'classic') === value}
                onClick={() => update(CompositionManifestSchema.parse({ ...manifest, sheetVariant: value }), true)}>{label}</button>)}
          </div>
        </div>}
        <CutPreview manifest={manifest} contours={current?.contours ?? []} reloadKey={assetReload}
          {...(props.runtimeSpriteUrl ? { runtimeSpriteUrl: props.runtimeSpriteUrl } : {})}
          unavailable={previewFailed} onArtworkState={setArtworkState} />
        <CutBorderControl
          value={manifest.cutMarginMm}
          custom={custom}
          onPreset={(value) => { setCustom(false); updateMargin(value, true); }}
          onCustom={() => setCustom(true)}
          onCustomChange={(value) => updateMargin(value, false)}
          onCustomRelease={() => updateMargin(manifest.cutMarginMm, true)}
        />
      </fieldset>
      {report?.issues.length ? (
        <div className={structuralError ? 'notice error' : 'notice warning'} role="alert">
          <strong>{structuralError ? 'This design cannot print yet' : 'Check the cut border'}</strong>
          <span>{report.issues[0]!.message}</span>
        </div>
      ) : null}
      {error ? <div className="notice error" role="alert">{error}</div> : null}
      <div className="sticky-action">
        <button className="primary-action" type="button"
          disabled={submitting || (!previewFailed && (structuralError || !report || artworkState === 'loading'))}
          onClick={() => previewFailed ? retryPreview() : void submit()}>
          {submitting ? 'Joining queue…' : previewFailed ? 'Retry preview' : (!report || artworkState === 'loading') ? 'Checking cut…' : report.severity === 'warning' ? 'Print anyway' : 'Join print queue'}
        </button>
      </div>
    </main>
  );
}
