import type { VisitorApi } from './api.ts';
import { EditorPage, overlapFixtureManifest } from './editor/editor-page.tsx';
import { QueuePage } from './queue/queue-page.tsx';

function navigate(path: string) {
  window.location.assign(path);
}

function tokenFor(submissionId: string): string {
  const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (fragmentToken) {
    sessionStorage.setItem(`natcut:status:${submissionId}`, fragmentToken);
    return fragmentToken;
  }
  return sessionStorage.getItem(`natcut:status:${submissionId}`) ?? '';
}

export function VisitorApp({ api }: { api: VisitorApi }) {
  const queueMatch = /^\/queue\/([^/]+)$/.exec(window.location.pathname);
  if (queueMatch) {
    const submissionId = decodeURIComponent(queueMatch[1]!);
    return <QueuePage submissionId={submissionId} statusToken={tokenFor(submissionId)} api={api} onNavigate={navigate} />;
  }
  const fixture = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('fixture')
    : null;
  return (
    <EditorPage
      submitSubmission={(request) => api.submit(request)}
      onNavigate={navigate}
      {...(fixture === 'overlap' ? { initialManifest: overlapFixtureManifest } : {})}
    />
  );
}
