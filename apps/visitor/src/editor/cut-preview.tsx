import { DEVFEST_SG_V1, type CompositionManifest } from '@natcut/domain';
import { assetPngFilename, planComposition } from '@natcut/render/browser';
import { useEffect, useRef } from 'react';
import type { ContourPreview } from './use-cut-preview.ts';

function pathData(points: ContourPreview): string {
  if (points.length === 0) return '';
  return `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`;
}

type ArtworkState = 'loading' | 'ready' | 'error';
type PreviewProps = {
  manifest: CompositionManifest;
  contours: ContourPreview[];
  unavailable?: boolean;
  reloadKey?: number;
  onArtworkState?: (state: ArtworkState) => void;
};

export function CutPreview({ manifest, contours, unavailable, reloadKey = 0, onArtworkState }: PreviewProps) {
  const plan = planComposition(manifest, DEVFEST_SG_V1);
  const artworkKey = `${plan.layers.map((layer) => assetPngFilename(layer.assetId)).join(':')}:${reloadKey}`;
  const loadState = useRef({ key: artworkKey, layers: new Set<string>() });
  if (loadState.current.key !== artworkKey) loadState.current = { key: artworkKey, layers: new Set() };
  const dilationPx = (manifest.cutMarginMm * 300) / 25.4;

  useEffect(() => {
    onArtworkState?.('loading');
  }, [artworkKey, onArtworkState]);

  const loaded = (layerId: string) => {
    if (loadState.current.key !== artworkKey) return;
    loadState.current.layers.add(layerId);
    if (loadState.current.layers.size === plan.layers.length) onArtworkState?.('ready');
  };

  return (
    <section className="preview-shell" aria-label="Sticker preview">
      <div className="preview-label"><span>Live preview</span><span>{manifest.cutMarginMm.toFixed(1)} mm border</span></div>
      {unavailable && <p className="notice error" role="alert">The sprite preview couldn’t load. Retry or choose another sprite.</p>}
      <svg className="sticker-preview" viewBox="0 0 1200 2100" role="img" aria-label="Trusted sprite sticker composition preview">
        <defs>
          <filter id="paper-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="24" stdDeviation="22" floodOpacity="0.22" /></filter>
          <filter id="cut-border" x="-30%" y="-30%" width="160%" height="160%">
            <feMorphology in="SourceAlpha" operator="dilate" radius={dilationPx} result="dilated" />
            <feFlood floodColor="white" result="white" />
            <feComposite in="white" in2="dilated" operator="in" result="border" />
            <feMerge><feMergeNode in="border" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width="1200" height="2100" rx="72" fill="#dceac7" />
        {plan.layers.map((layer) => (
          <g key={`${layer.id}:${artworkKey}`} filter="url(#paper-shadow)">
            <image
              href={`/${assetPngFilename(layer.assetId)}?reload=${reloadKey}`}
              x={layer.x}
              y={layer.y}
              width={layer.width}
              height={layer.height}
              preserveAspectRatio="none"
              imageRendering="pixelated"
              filter="url(#cut-border)"
              onLoad={() => loaded(layer.id)}
              onError={() => loadState.current.key === artworkKey && onArtworkState?.('error')}
            />
          </g>
        ))}
        {contours.map((contour, index) => <path key={index} d={pathData(contour)} fill="none" stroke="#ff5a36" strokeWidth="8" strokeDasharray="22 16" />)}
      </svg>
    </section>
  );
}
