export function queueStatusToken(submissionId: string): string {
  const storageKey = `natcut:status:${submissionId}`;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('token');
  if (token) {
    // Older links carry the bearer in the fragment. Import it before removing
    // it from the address bar, so refresh in this tab keeps working.
    try {
      sessionStorage.setItem(storageKey, token);
      fragment.delete('token');
      const rest = fragment.toString();
      window.history.replaceState(window.history.state, '',
        `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
    } catch { /* Keep the original fragment if tab storage is unavailable. */ }
    return token;
  }
  try { return sessionStorage.getItem(storageKey) ?? ''; }
  catch { return ''; }
}
