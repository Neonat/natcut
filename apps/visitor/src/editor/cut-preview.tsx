import { DEVFEST_SG_V1, type CompositionManifest } from '@natcut/domain';
import { planComposition } from '@natcut/render/browser';
import type { ContourPreview } from './use-cut-preview.ts';

function pathData(points: ContourPreview): string {
  if (points.length === 0) return '';
  return `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`;
}

function assetUrl(assetId: string): string {
  return assetId.startsWith('branding/') ? '/sprout-wordmark.png' : '/sprite-fixture.png';
}

export function CutPreview({ manifest, contours }: { manifest: CompositionManifest; contours: ContourPreview[] }) {
  const plan = planComposition(manifest, DEVFEST_SG_V1);
  const dilationPx = (manifest.cutMarginMm * 300) / 25.4;
  return (
    <section className="preview-shell" aria-label="Sticker preview">
      <div className="preview-label"><span>Live preview</span><span>{manifest.cutMarginMm.toFixed(1)} mm border</span></div>
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
          <g key={layer.id} filter="url(#paper-shadow)">
            <image
              href={assetUrl(layer.assetId)}
              x={layer.x}
              y={layer.y}
              width={layer.width}
              height={layer.height}
              preserveAspectRatio="none"
              filter="url(#cut-border)"
            />
          </g>
        ))}
        {contours.map((contour, index) => <path key={index} d={pathData(contour)} fill="none" stroke="#ff5a36" strokeWidth="8" strokeDasharray="22 16" />)}
      </svg>
    </section>
  );
}
