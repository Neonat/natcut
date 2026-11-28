import { catalogManifest, sprites } from '@natcut/render/browser';
import { useEffect, useState } from 'react';
import type { PlantFlowStatus, PlantVisitorApi, SubmissionRequest, SubmissionResponse } from '../api.ts';
import { EditorPage } from '../editor/editor-page.tsx';
import sproutWordmark from '../assets/sprout-wordmark.png';

const draftKey = 'natcut:plant-capture';
const fallbackKey = 'natcut:plant-fallback';

export function PlantJourney({ api, submitCatalog, onNavigate }: { api: PlantVisitorApi;
  submitCatalog: (request: SubmissionRequest) => Promise<SubmissionResponse>; onNavigate: (path: string) => void }) {
  const [captureId, setCaptureId] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [fallbackAssetId, setFallbackAssetId] = useState(() => sessionStorage.getItem(fallbackKey) ?? sprites[0]!.id);
  const [status, setStatus] = useState<PlantFlowStatus | null>(null);
  const [spriteUrl, setSpriteUrl] = useState('');
  const [candidateUrl, setCandidateUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    if (!captureId || status || photo) return;
    let active = true;
    void api.plantStatus(captureId).catch(error => {
      if (error instanceof Error && error.message === 'PLANT_JOB_NOT_FOUND') return api.begin(captureId, fallbackAssetId);
      throw error;
    }).then(next => { if (active) setStatus(next); }).catch(() => {
      if (active) { sessionStorage.removeItem(draftKey); setCaptureId(''); }
    });
    return () => { active = false; };
  }, [api, captureId, fallbackAssetId, photo, status]);

  useEffect(() => {
    if (!captureId || !status || !['waiting', 'needs_create_retry'].includes(status.state)) return;
    const timer = setTimeout(() => {
      const request = status.state === 'needs_create_retry'
        ? api.begin(captureId, fallbackAssetId) : api.plantStatus(captureId);
      void request.then(setStatus).catch(() => setError('Could not check your sprite. Tap retry.'));
    }, 1200);
    return () => clearTimeout(timer);
  }, [api, captureId, fallbackAssetId, status]);

  useEffect(() => {
    if (!captureId || status?.state !== 'accepted' || status.sproutAck === 'confirmed') return;
    const timer = setTimeout(() => void api.syncOutcome(captureId).then(setStatus).catch(() => {}), 1200);
    return () => clearTimeout(timer);
  }, [api, captureId, status]);

  useEffect(() => {
    if (status?.state !== 'candidate_available') return;
    let active = true;
    let url = '';
    void api.candidatePreview(captureId, status.candidateId).then(blob => {
      url = URL.createObjectURL(blob);
      if (active) setCandidateUrl(url);
      else URL.revokeObjectURL(url);
    }).catch(() => { if (active) setError('Could not show this sprite. Retry the preview.'); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [api, captureId, status]);

  useEffect(() => {
    if (status?.state !== 'accepted' || status.decision.outcome !== 'generated_accepted' || status.sproutAck !== 'confirmed') return;
    let active = true;
    let url = '';
    void api.acceptedSprite(captureId).then(blob => {
      url = URL.createObjectURL(blob);
      if (active) setSpriteUrl(url);
      else URL.revokeObjectURL(url);
    }).catch(() => { if (active) setError('Your sprite preview is unavailable. Tap retry.'); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [api, captureId, status]);

  async function run(action: () => Promise<PlantFlowStatus>) {
    setBusy(true); setError('');
    try { setStatus(await action()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); }
    finally { setBusy(false); }
  }

  async function upload() {
    if (!photo) return;
    const id = captureId || crypto.randomUUID();
    setCaptureId(id);
    sessionStorage.setItem(draftKey, id);
    sessionStorage.setItem(fallbackKey, fallbackAssetId);
    setBusy(true); setError('');
    try {
      await api.capture(id, photo);
      setStatus(await api.begin(id, fallbackAssetId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not upload your plant. Try again.'); }
    finally { setBusy(false); }
  }

  if (status?.state === 'accepted') {
    if (status.sproutAck !== 'confirmed') return <main className="plant-journey"><h1>Preparing your sprite</h1>
      <p>Your choice is saved. We’re checking the finished artwork.</p>
      <button disabled={busy} onClick={() => void run(() => api.syncOutcome(captureId))}>Continue</button>
      {error && <p role="alert">{error}</p>}</main>;
    const generated = status.decision.outcome === 'generated_accepted';
    if (generated && !spriteUrl) return <main className="plant-journey"><h1>Loading your sprite</h1>
      <button onClick={() => void api.acceptedSprite(captureId).then(blob => setSpriteUrl(URL.createObjectURL(blob))).catch(() => setError('Preview unavailable'))}>Retry preview</button>
      {error && <p role="alert">{error}</p>}</main>;
    const manifest = status.decision.outcome === 'generated_accepted'
      ? { ...catalogManifest, renderVersion: 'runtime-catalog-v1', spriteAssetId: status.decision.natcutAssetId }
      : { ...catalogManifest, spriteAssetId: status.decision.catalogAssetId };
    const submit = (request: SubmissionRequest): Promise<SubmissionResponse> => generated
      ? api.submitPlant(captureId, request)
      : submitCatalog(request);
    return <EditorPage initialManifest={manifest} submitSubmission={submit} onNavigate={onNavigate} lockSpriteChoice
      {...(generated ? { runtimeSpriteUrl: spriteUrl } : {})} />;
  }

  return <main className="plant-journey">
    <header className="plant-topline"><img src={sproutWordmark} alt="Sprout" /><span>Sticker studio</span></header>
    <div className="plant-intro"><span className="plant-eyebrow">01 / YOUR PLANT</span><h1>Meet your new sprite.</h1>
      <p>Show us a clear photo of your plant. We’ll turn it into a character, then you can finish your sticker.</p></div>
    {!status && <>
      <label className="plant-upload"><input type="file" accept="image/jpeg,image/png,image/webp"
        onChange={event => setPhoto(event.currentTarget.files?.[0] ?? null)} />
        {photoUrl ? <img src={photoUrl} alt="Your plant photo" /> : <span>Tap to take or upload a plant photo</span>}</label>
      <p className="plant-hint">For the best result, keep the leaves and flowers in focus.</p>
      <label className="plant-fallback-label">Your backup sprite <span>Ready if generation takes too long</span></label>
      <div className="plant-backups">{sprites.map(sprite => <button key={sprite.id} type="button"
        className={fallbackAssetId === sprite.id ? 'selected' : ''}
        onClick={() => setFallbackAssetId(sprite.id)}>{sprite.name}</button>)}</div>
      <button className="primary-action" disabled={!photo || busy} onClick={() => void upload()}>{busy ? 'Uploading…' : 'Create my sprite'}</button>
    </>}
    {status?.state === 'waiting' && <section className="plant-progress"><span className="plant-eyebrow">02 / MAKING YOUR SPRITE</span>
      <h2>A little magic is growing.</h2><p>About {Math.max(1, Math.ceil(status.remainingMs / 1000))} seconds left before your backup is ready.</p></section>}
    {status?.state === 'candidate_available' && <section className="plant-progress"><span className="plant-eyebrow">02 / YOUR SPRITE IS READY</span>
      <h2>Is this sprite cute enough?</h2>
      {candidateUrl ? <img className="plant-candidate" src={candidateUrl} alt="Your generated plant sprite" />
        : <p>Loading your sprite preview…</p>}
      <button className="primary-action" disabled={busy || !candidateUrl}
        onClick={() => void run(() => api.acceptGenerated(captureId, status.candidateId))}>Yes, use this sprite</button>
      <button className="plant-secondary" disabled={busy}
        onClick={() => void run(() => api.acceptFallback(captureId))}>Choose my backup instead</button></section>}
    {status?.state === 'identification_review' && <section className="plant-progress"><h2>We couldn’t identify your plant confidently.</h2>
      {status.suggestions[0] && <p>Closest match: {status.suggestions[0].name} ({Math.round(status.suggestions[0].scoreBps / 100)}%).</p>}
      <button className="primary-action" disabled={busy} onClick={() => void run(() => api.acceptFallback(captureId))}>Choose my backup sprite</button>
      <button className="plant-secondary" onClick={() => { sessionStorage.removeItem(draftKey); setCaptureId(''); setStatus(null); }}>Try another photo</button></section>}
    {status?.state === 'needs_reconciliation' && <section className="plant-progress"><h2>We need a moment to check your sprite.</h2>
      <p>Your photo is safe. Please ask the booth host for help.</p></section>}
    {error && <div className="notice error" role="alert">{error}<button onClick={() => void run(() => api.plantStatus(captureId))}>Retry</button></div>}
  </main>;
}
