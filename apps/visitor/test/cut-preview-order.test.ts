import { describe, expect, it, vi } from 'vitest';
import { CutPreviewCoordinator, fixtureManifest } from '../src/index.ts';

describe('cut preview ordering', () => {
  it('ignores an older result that arrives after a newer revision', () => {
    const applied = vi.fn();
    const coordinator = new CutPreviewCoordinator(vi.fn(), applied, 100);
    coordinator.release({ ...fixtureManifest, cutMarginMm: 1 });
    coordinator.release({ ...fixtureManifest, cutMarginMm: 2 });

    coordinator.receive({ revision: 2, report: { marker: 'new' } as never, contours: [] });
    coordinator.receive({ revision: 1, report: { marker: 'old' } as never, contours: [] });

    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it('debounces movement but evaluates immediately on release', () => {
    vi.useFakeTimers();
    const post = vi.fn();
    const coordinator = new CutPreviewCoordinator(post, vi.fn(), 150);
    coordinator.move({ ...fixtureManifest, cutMarginMm: 1.1 });
    coordinator.move({ ...fixtureManifest, cutMarginMm: 1.2 });
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(149);
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ exact: true, manifest: expect.objectContaining({ cutMarginMm: 1.2 }) }));

    coordinator.move({ ...fixtureManifest, cutMarginMm: 1.3 });
    coordinator.release({ ...fixtureManifest, cutMarginMm: 1.3 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ exact: true, manifest: expect.objectContaining({ cutMarginMm: 1.3 }) }));
    vi.useRealTimers();
  });
});
