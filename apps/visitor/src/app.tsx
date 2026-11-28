import { CompositionManifestSchema } from '@natcut/domain';
import { assertSupportedRecipe } from '@natcut/render/browser';
import type { VisitorApi } from './api.ts';
import { EditorPage, overlapFixtureManifest } from './editor/editor-page.tsx';
import { QueuePage } from './queue/queue-page.tsx';
import { PlantJourney } from './plant/plant-journey.tsx';
import { queueStatusToken } from './queue/queue-status-token.ts';

function navigate(path: string) {
  window.location.assign(path);
}

export function VisitorApp({ api, simulation }: { api: VisitorApi; simulation?: boolean }) {
  return (
    <>
      {simulation ? <p className="simulation-notice">Simulation rehearsal · Fixture artwork only</p> : null}
      <VisitorRoute api={api} simulation={simulation ?? false} />
    </>
  );
}

function requeueDraft(id: string) {
  try {
    const saved = sessionStorage.getItem(`natcut:draft:${id}`);
    if (!saved) return;
    const manifest = CompositionManifestSchema.parse(JSON.parse(saved));
    if (manifest.renderVersion !== 'catalog-v1') return;
    assertSupportedRecipe(manifest);
    return manifest;
  } catch {
    return undefined;
  }
}

function VisitorRoute({ api, simulation }: { api: VisitorApi; simulation: boolean }) {
  const plantHome = window.location.pathname === '/' && import.meta.env.VITE_NATCUT_PLANT_FLOW_ENABLED === 'true';
  if ((window.location.pathname === '/plant' || plantHome) && api.plant) {
    return <PlantJourney api={api.plant} onNavigate={navigate} />;
  }
  const queueMatch = /^\/queue\/([^/]+)$/.exec(window.location.pathname);
  if (queueMatch) {
    const submissionId = decodeURIComponent(queueMatch[1]!);
    return <QueuePage submissionId={submissionId} statusToken={queueStatusToken(submissionId)} api={api} onNavigate={navigate} simulation={simulation} />;
  }
  const fixture = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('fixture')
    : null;
  const requeuedFrom = new URLSearchParams(window.location.search).get('requeuedFrom') ?? undefined;
  const initial = fixture === 'overlap' ? overlapFixtureManifest : requeuedFrom ? requeueDraft(requeuedFrom) : undefined;
  return (
    <EditorPage
      submitSubmission={(request) => api.submit(request)}
      onNavigate={navigate}
      {...(initial ? { initialManifest: initial } : {})}
      {...(requeuedFrom ? { requeuedFrom } : {})}
    />
  );
}
