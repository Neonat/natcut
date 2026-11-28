import { DEVFEST_SG_V1, type CompositionManifest } from '@natcut/domain';
import { assetPngFilename, isRuntimeLetteringId, planComposition,
  runtimeLetteringAsset, runtimeLetteringSvgUrl, sampledSpriteHalo } from '@natcut/render/browser';
import { useEffect, useRef, useState } from 'react';
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
  runtimeSpriteUrl?: string;
};

const letteringUrls = new Map<string, string>();
function letteringUrl(id: string, plantLabel: string | undefined): string {
  const key = `${id}\0${plantLabel ?? 'YOUR PLANT'}`;
  let url = letteringUrls.get(key);
  if (!url && isRuntimeLetteringId(id)) {
    url = runtimeLetteringSvgUrl(runtimeLetteringAsset(id, plantLabel));
    letteringUrls.set(key, url);
  }
  if (!url) throw new Error('Unknown runtime lettering.');
  return url;
}

export function CutPreview({ manifest, contours, unavailable, reloadKey = 0, onArtworkState, runtimeSpriteUrl }: PreviewProps) {
  const plan = planComposition(manifest, DEVFEST_SG_V1,
    manifest.renderVersion === 'runtime-catalog-v1' ? manifest.spriteAssetId : undefined);
  const assetUrl = (assetId: string) => isRuntimeLetteringId(assetId)
    ? letteringUrl(assetId, manifest.plantLabel)
    : assetId === manifest.spriteAssetId && runtimeSpriteUrl
      ? runtimeSpriteUrl : `/${assetPngFilename(assetId)}?reload=${reloadKey}`;
  const [halo, setHalo] = useState<{ source: string; url: string } | null>(null);
  const haloLayer = plan.layers.find(layer => layer.creamHaloPx);
  const haloSource = haloLayer ? assetUrl(haloLayer.assetId) : null;
  useEffect(() => {
    if (!haloLayer || !haloSource) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(haloSource);
      if (!response.ok) throw new Error('Sprite halo source unavailable.');
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const source = document.createElement('canvas');
        source.width = bitmap.width; source.height = bitmap.height;
        const sourceContext = source.getContext('2d', { willReadFrequently: true });
        if (!sourceContext) throw new Error('Sprite halo canvas unavailable.');
        sourceContext.drawImage(bitmap, 0, 0);
        const rgba = sourceContext.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const alpha = sampledSpriteHalo({ ...haloLayer, flipX: false },
          { id: haloLayer.assetId, width: bitmap.width, height: bitmap.height, rgba });
        const output = document.createElement('canvas');
        output.width = haloLayer.width; output.height = haloLayer.height;
        const context = output.getContext('2d');
        if (!context) throw new Error('Sprite halo canvas unavailable.');
        const pixels = context.createImageData(output.width, output.height);
        for (let i = 0; i < alpha.length; i++) if (alpha[i]) {
          const offset = i * 4;
          pixels.data[offset] = 255; pixels.data[offset + 1] = 239;
          pixels.data[offset + 2] = 199; pixels.data[offset + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        if (!cancelled) setHalo({ source: haloSource, url: output.toDataURL('image/png') });
      } finally { bitmap.close(); }
    })().catch(() => { if (!cancelled) onArtworkState?.('error'); });
    return () => { cancelled = true; };
  }, [haloSource, haloLayer?.assetId, haloLayer?.width, haloLayer?.height,
    haloLayer?.creamHaloPx, reloadKey, onArtworkState]);
  const artworkKey = [manifest.renderVersion, manifest.spriteAssetId, manifest.plantLabel,
    ...plan.layers.map(layer => layer.assetId), runtimeSpriteUrl, reloadKey].join(':');
  const loadState = useRef({ key: artworkKey, layers: new Set<string>() });
  if (loadState.current.key !== artworkKey) loadState.current = { key: artworkKey, layers: new Set() };
  const dilationPx = (manifest.cutMarginMm * 300) / 25.4;

  useEffect(() => {
    onArtworkState?.('loading');
  }, [artworkKey, onArtworkState]);

  const loaded = (layerId: string) => {
    if (loadState.current.key !== artworkKey) return;
    loadState.current.layers.add(layerId);
    if (loadState.current.layers.size === plan.layers.length + plan.layers.filter(layer => layer.creamHaloPx).length) onArtworkState?.('ready');
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
            <g filter="url(#cut-border)">
            {layer.creamHaloPx && halo?.source === haloSource && <image
              href={halo.url} x={layer.x} y={layer.y} width={layer.width} height={layer.height}
              transform={layer.flipX ? `translate(${2 * layer.x + layer.width} 0) scale(-1 1)` : undefined}
              preserveAspectRatio="none" imageRendering="pixelated"
              onLoad={() => loaded(`${layer.id}-halo`)}
              onError={() => onArtworkState?.('error')}
            />}
            <image
              href={assetUrl(layer.assetId)}
              x={layer.x}
              y={layer.y}
              width={layer.width}
              height={layer.height}
              transform={layer.flipX ? `translate(${2 * layer.x + layer.width} 0) scale(-1 1)` : undefined}
              preserveAspectRatio="none"
              imageRendering="pixelated"
              onLoad={() => loaded(layer.id)}
              onError={() => loadState.current.key === artworkKey && onArtworkState?.('error')}
            />
            </g>
          </g>
        ))}
        {contours.map((contour, index) => <path key={index} d={pathData(contour)} fill="none" stroke="#ff5a36" strokeWidth="8" strokeDasharray="22 16" />)}
      </svg>
    </section>
  );
}
