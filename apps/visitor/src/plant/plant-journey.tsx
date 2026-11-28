import { assetPngFilename, sprites } from '@natcut/render/browser';
import { useEffect, useState } from 'react';
import type { PlantFlowStatus, PlantVisitorApi, SubmissionRequest, SubmissionResponse } from '../api.ts';
import { EditorPage, visitorSheetManifest } from '../editor/editor-page.tsx';
import sproutWordmark from '../assets/sprout-wordmark.png';

const draftKey = 'natcut:plant-capture';
const fallbackKey = 'natcut:plant-fallback';

export function PlantJourney({ api, onNavigate }: { api: PlantVisitorApi; onNavigate: (path: string) => void }) {
  const [captureId, setCaptureId] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
  const [fallbackAssetId, setFallbackAssetId] = useState(() => sessionStorage.getItem(fallbackKey) ?? sprites[0]!.id);
  const [status, setStatus] = useState<PlantFlowStatus | null>(null);
  const [spriteUrl, setSpriteUrl] = useState('');
  const [candidateUrl, setCandidateUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function startOver() {
    sessionStorage.removeItem(draftKey);
    setCaptureId(''); setPhoto(null); setStatus(null); setError('');
  }

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
    if (!captureId || status?.state !== 'accepted' || status.sproutAck !== 'pending') return;
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
    const generated = status.decision.outcome === 'generated_accepted';
    if (generated && status.sproutAck === 'needs_reconciliation') return <main className="plant-journey"><h1>We need to check your sprite.</h1>
      <p>Your choice is saved. Please ask the booth host for help.</p></main>;
    if (generated && status.sproutAck !== 'confirmed') return <main className="plant-journey"><h1>Preparing your sprite</h1>
      <p>Your choice is saved. We’re checking the finished artwork.</p>
      <button disabled={busy} onClick={() => void run(() => api.syncOutcome(captureId))}>Continue</button>
      {error && <p role="alert">{error}</p>}</main>;
    if (generated && !spriteUrl) return <main className="plant-journey"><h1>Loading your sprite</h1>
      <button onClick={() => void api.acceptedSprite(captureId).then(blob => setSpriteUrl(URL.createObjectURL(blob))).catch(() => setError('Preview unavailable'))}>Retry preview</button>
      {error && <p role="alert">{error}</p>}</main>;
    const manifest = status.decision.outcome === 'generated_accepted'
      ? { ...visitorSheetManifest, renderVersion: 'runtime-catalog-v1', spriteAssetId: status.decision.natcutAssetId,
          plantLabel: status.plantLabel }
      : { ...visitorSheetManifest, spriteAssetId: status.decision.catalogAssetId };
    const submit = (request: SubmissionRequest): Promise<SubmissionResponse> => api.submitPlant(captureId, request);
    return <EditorPage initialManifest={manifest} submitSubmission={submit} onNavigate={onNavigate} lockSpriteChoice
      {...(generated ? { runtimeSpriteUrl: spriteUrl } : {})} />;
  }

  return <main className="plant-journey">
    <header className="plant-topline"><img src={sproutWordmark} alt="Sprout" /><span>Sticker studio</span></header>
    <div className="plant-intro"><span className="plant-eyebrow">01 / YOUR PLANT</span><h1>Meet your new sprite.</h1>
      <p>Show us a clear photo of your plant. We’ll turn it into a character, then you can finish your sticker.</p></div>
    {!status && <>
      <section className="plant-library-entry" aria-label="Approved sprite library">
        <span className="plant-eyebrow">READY TO PRINT</span>
        <h2>Choose a sprite from the garden</h2>
        <p>Pick an approved plant, choose your sticker layout, and preview the cut before joining the queue.</p>
        <button type="button" onClick={() => onNavigate('/studio')}>Browse approved sprites</button>
      </section>
      <label className="plant-upload"><input type="file" accept="image/jpeg,image/png,image/webp"
        onChange={event => {
          const next = event.currentTarget.files?.[0] ?? null;
          if (photo && next && (photo.name !== next.name || photo.size !== next.size || photo.lastModified !== next.lastModified)) {
            sessionStorage.removeItem(draftKey);
            setCaptureId('');
          }
          setPhoto(next);
        }} />
        {photoUrl ? <img src={photoUrl} alt="Your plant photo" /> : <span>Tap to take or upload a plant photo</span>}</label>
      <p className="plant-hint">For the best result, keep the leaves and flowers in focus.</p>
      <label className="plant-fallback-label">Your backup sprite <span>Ready if generation takes too long</span></label>
      <div className="plant-backups">{sprites.map(sprite => <button key={sprite.id} type="button"
        className={fallbackAssetId === sprite.id ? 'selected' : ''}
        aria-pressed={fallbackAssetId === sprite.id}
        onClick={() => setFallbackAssetId(sprite.id)}>
        <img src={`/${assetPngFilename(sprite.id)}`} alt="" loading="lazy" />
        <span>{sprite.name}</span>
      </button>)}</div>
      <button className="primary-action" disabled={!photo || busy} onClick={() => void upload()}>{busy ? 'Uploading…' : 'Create my sprite'}</button>
    </>}
    {status?.state === 'waiting' && <section className="plant-progress"><span className="plant-eyebrow">02 / MAKING YOUR SPRITE</span>
      <h2>A little magic is growing.</h2><p>We’ll show your sprite as soon as it’s ready.</p>
      <button className="plant-secondary" disabled={busy} onClick={() => void run(() => api.acceptFallback(captureId))}>Use my backup sprite now</button></section>}
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
      <button className="plant-secondary" onClick={startOver}>Try another photo</button></section>}
    {status?.state === 'needs_reconciliation' && <section className="plant-progress"><h2>We need a moment to check your sprite.</h2>
      <p>You can keep going with your backup sprite while we check what happened.</p>
      <button className="primary-action" disabled={busy}
        onClick={() => void run(() => api.acceptFallback(captureId))}>Use my backup sprite</button></section>}
    {error && <div className="notice error" role="alert">{error}
      {status ? <button onClick={() => void run(() => api.plantStatus(captureId))}>Retry status</button> : null}
      <button onClick={startOver}>Use another photo</button></div>}
  </main>;
}
