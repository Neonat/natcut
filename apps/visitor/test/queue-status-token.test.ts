import { afterEach, describe, expect, it } from 'vitest';
import { queueStatusToken } from '../src/queue/queue-status-token.ts';

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('queue status URL', () => {
  it('imports a legacy bearer fragment and removes it from the visible URL', () => {
    window.history.replaceState(null, '', '/queue/submission-first#token=private-status-token');

    expect(queueStatusToken('submission-first')).toBe('private-status-token');
    expect(window.location.pathname).toBe('/queue/submission-first');
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('natcut:status:submission-first')).toBe('private-status-token');
    expect(queueStatusToken('submission-first')).toBe('private-status-token');
  });

  it('does not read one submission’s token for another queue URL', () => {
    sessionStorage.setItem('natcut:status:submission-first', 'private-status-token');
    window.history.replaceState(null, '', '/queue/submission-second');

    expect(queueStatusToken('submission-second')).toBe('');
  });
});
