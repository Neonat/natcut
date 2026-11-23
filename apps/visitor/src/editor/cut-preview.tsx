import type { ContourPreview } from './use-cut-preview.ts';

function pathData(points: ContourPreview): string {
  if (points.length === 0) return '';
  return `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`;
}

export function CutPreview({ marginMm, contours }: { marginMm: number; contours: ContourPreview[] }) {
  const approximateStroke = 8 + marginMm * 24;
  return (
    <section className="preview-shell" aria-label="Sticker preview">
      <div className="preview-label"><span>Live preview</span><span>{marginMm.toFixed(1)} mm border</span></div>
      <svg className="sticker-preview" viewBox="0 0 1200 2100" role="img" aria-label="Monstera sprite sticker with Sprout branding">
        <defs>
          <filter id="paper-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="24" stdDeviation="22" floodOpacity="0.22" /></filter>
          <clipPath id="sprite-clip"><ellipse cx="600" cy="850" rx="380" ry="380" /></clipPath>
        </defs>
        <rect width="1200" height="2100" rx="72" fill="#dceac7" />
        <ellipse cx="600" cy="850" rx="380" ry="380" fill="white" stroke="white" strokeWidth={approximateStroke} filter="url(#paper-shadow)" />
        <image href="/sprite-fixture.png" x="240" y="490" width="720" height="720" preserveAspectRatio="xMidYMid meet" clipPath="url(#sprite-clip)" />
        <g filter="url(#paper-shadow)">
          <rect x="365" y="1815" width="470" height="155" rx="70" fill="white" stroke="white" strokeWidth={approximateStroke / 2} />
          <text x="600" y="1918" textAnchor="middle" fontFamily="Arial Rounded MT Bold, sans-serif" fontSize="82" fontWeight="800" fill="#18392b">sprout</text>
        </g>
        {contours.map((contour, index) => <path key={index} d={pathData(contour)} fill="none" stroke="#ff5a36" strokeWidth="8" strokeDasharray="22 16" />)}
      </svg>
    </section>
  );
}
