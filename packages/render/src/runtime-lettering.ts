import { NATIVE_SRGB_EVIDENCE } from '@natcut/domain';
import type { SrgbRgbaAsset } from './assets.ts';

export const RUNTIME_NAME_ID = 'lettering/runtime/name';
export const RUNTIME_PHRASE_A_ID = 'lettering/runtime/bloom-bright';
export const RUNTIME_PHRASE_B_ID = 'lettering/runtime/grow-bold';

const glyphs: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14], H: [17, 17, 17, 31, 17, 17, 17],
  I: [31, 4, 4, 4, 4, 4, 31], J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31], '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 16, 30, 1, 1, 30],
  '6': [14, 16, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 1, 14],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
};

const captions: Record<string, readonly [readonly string[], readonly string[]]> = {
  FRANGIPANI: [['FRANGI-', 'PANIC'], ['PETAL TO', 'THE METAL']],
  STRAWBERRY: [['BERRY', 'SWEET'], ['BERRY', 'BRAVE']],
  ORCHID: [['ORCHID YOU', 'NOT'], ['BLOOM', 'SERVICE']],
  'MOTH ORCHID': [['ORCHID YOU', 'NOT'], ['BLOOM', 'SERVICE']],
  SUNFLOWER: [['SUNS OUT', 'PETALS OUT'], ['RAY OF', 'MISCHIEF']],
  ROSE: [['THORN TO', 'BE WILD'], ['ROSE ALL', 'DAY']],
  MONSTERA: [['LEAF ME', 'ALONE'], ['MONSTER', 'ENERGY']],
  HIBISCUS: [['HIBIS-', 'KISS'], ['PETAL TO', 'THE METAL']],
  'CHERRY BLOSSOM': [['BLOOM', 'BOOM'], ['PETAL TO', 'THE METAL']],
};

export function runtimeCaptions(plantLabel: string): readonly [readonly string[], readonly string[]] {
  return captions[plantLabel] ?? [['LEAF ME', 'ALONE'], ['PETAL TO', 'THE METAL']];
}

const specs = {
  [RUNTIME_NAME_ID]: { width: 780, height: 130, lines: 1 },
  [RUNTIME_PHRASE_A_ID]: { width: 550, height: 260, lines: 2 },
  [RUNTIME_PHRASE_B_ID]: { width: 550, height: 260, lines: 2 },
} as const;

export function isRuntimeLetteringId(id: string): id is keyof typeof specs {
  return Object.hasOwn(specs, id);
}

export function runtimeLetteringAsset(id: keyof typeof specs, plantLabel = 'YOUR PLANT'): SrgbRgbaAsset {
  const { width, height } = specs[id];
  const [first, second] = runtimeCaptions(plantLabel);
  const lines = id === RUNTIME_NAME_ID ? [plantLabel] : id === RUNTIME_PHRASE_A_ID ? first : second;
  if (lines.some(line => !/^[A-Z0-9 -]+$/.test(line))) throw new Error('Runtime lettering uses unsupported glyphs.');
  const margin = 22;
  const widest = Math.max(...lines.map(line => line.length * 6 - 1));
  const lineGapUnits = lines.length === 1 ? 0 : 3;
  const scale = Math.min(13, Math.floor((width - margin * 2) / widest),
    Math.floor((height - margin * 2) / (lines.length * 7 + lineGapUnits)));
  if (scale < 3) throw new Error('Runtime lettering does not fit the sticker.');
  const rgba = new Uint8ClampedArray(width * height * 4);
  const paint = (x: number, y: number, size: number, color: readonly [number, number, number]) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + size); row++) {
      for (let col = Math.max(0, x); col < Math.min(width, x + size); col++) {
        const offset = (row * width + col) * 4;
        rgba[offset] = color[0]; rgba[offset + 1] = color[1]; rgba[offset + 2] = color[2]; rgba[offset + 3] = 255;
      }
    }
  };
  const blocks: [number, number][] = [];
  const totalHeight = (lines.length * 7 + lineGapUnits) * scale;
  const top = Math.floor((height - totalHeight) / 2);
  for (const [lineIndex, line] of lines.entries()) {
    const left = Math.floor((width - (line.length * 6 - 1) * scale) / 2);
    for (const [charIndex, char] of [...line].entries()) {
      const glyph = glyphs[char];
      if (!glyph) throw new Error(`Unsupported lettering glyph: ${char}`);
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
        if (glyph[row]! & (1 << (4 - col))) blocks.push([
          left + (charIndex * 6 + col) * scale,
          top + (lineIndex * (7 + lineGapUnits) + row) * scale,
        ]);
      }
    }
  }
  const cream = [255, 239, 199] as const;
  const red = [190, 29, 62] as const;
  const halo = 12;
  for (const [x, y] of blocks) paint(x - halo, y - halo, scale + halo * 2, cream);
  for (const [x, y] of blocks) paint(x, y, scale, red);
  return { id, width, height, rgba, colorEvidence: NATIVE_SRGB_EVIDENCE };
}

/** Browser preview draws the same integer RGBA runs used by the trusted raster and cut mask. */
export function runtimeLetteringSvgUrl(asset: SrgbRgbaAsset): string {
  const runs: string[] = [];
  const { width, height, rgba } = asset;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const start = x;
      const offset = (y * width + x) * 4;
      const alpha = rgba[offset + 3];
      const color = `${rgba[offset]},${rgba[offset + 1]},${rgba[offset + 2]}`;
      x++;
      while (x < width) {
        const next = (y * width + x) * 4;
        if (rgba[next + 3] !== alpha || `${rgba[next]},${rgba[next + 1]},${rgba[next + 2]}` !== color) break;
        x++;
      }
      if (alpha) runs.push(`<rect x="${start}" y="${y}" width="${x - start}" height="1" fill="rgb(${color})"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${runs.join('')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
