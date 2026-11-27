export const fixtureNames = ['flat', 'gradient', 'edges', 'transparency', 'seeded-detail'] as const;

export function fixtureRgba(name: typeof fixtureNames[number], width: number, height: number, detailRows = height) {
  const rgba = Buffer.alloc(width * height * 4);
  let state = 0x13579bdf;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = 4 * (y * width + x);
    const t = Math.floor(255 * x / (width - 1));
    const u = Math.floor(255 * y / (height - 1));
    let r = 54, g = 157, b = 212, a = 255;
    switch (name) {
      case 'flat': break;
      case 'gradient': r = t; g = u; b = (t + u) >> 1; break;
      case 'edges': {
        const band = ((x + y) % 37) < 17;
        r = band ? 227 : 19; g = band ? 47 : 139; b = band ? 81 : 213;
        break;
      }
      case 'transparency': r = 210; g = 57; b = 76; a = (3 * x + y) & 255; break;
      case 'seeded-detail':
        if (y < detailRows) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
          const luma = state & 191;
          r = luma + (t >> 2); g = luma + (u >> 2); b = luma + ((255 - t) >> 2);
        }
        break;
    }
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  return rgba;
}

export function maximaOf(results: { maeMilli: readonly number[]; p99: number; highErrorPpm: number; worstTileBias: number }[]) {
  return {
    maeMilli: Math.max(...results.flatMap(m => m.maeMilli)),
    p99: Math.max(...results.map(m => m.p99)),
    highErrorPpm: Math.max(...results.map(m => m.highErrorPpm)),
    worstTileBias: Math.max(...results.map(m => m.worstTileBias)),
  };
}
