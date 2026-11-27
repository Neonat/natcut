import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
type Row = { name: string; file: string; scientificName?: string };
type Entry = { id: string; name: string; pngSha256: string; scientificName?: string };

it('imports a stable 20-sprite roster with fitted transparent artwork and retains earlier identities', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sprite-import-'));
  const out = path.join(dir, 'catalog');
  const roster = path.join(dir, 'plants.json');
  const loadIndex = async (): Promise<{ sprites: Entry[]; archived: Entry[] }> =>
    JSON.parse(await readFile(path.join(out, 'index.json'), 'utf8'));
  const importRows = async (rows: Row[]) => {
    await writeFile(roster, JSON.stringify(rows));
    return exec('npm', ['run', 'sprites:import', '--', '--input', roster, '--out', out], { cwd: path.resolve(import.meta.dirname, '../../..') });
  };
  try {
    const rows: Row[] = [];
    for (let i = 0; i < 20; i++) {
      const file = `local-source-${i}.png`;
      rows.push({ name: `Plant ${i}`, file });
      const image = sharp({ create: { width: i % 2 ? 4 : 8, height: i % 2 ? 8 : 4, channels: 4, background: { r: i, g: 100, b: 100, alpha: 1 } } });
      await (i === 19 ? image.withMetadata({ orientation: 6 }) : image).png().toFile(path.join(dir, file));
    }
    rows[0]!.scientificName = 'Example species';
    await importRows(rows);
    const initial = await loadIndex();
    expect(initial.sprites).toHaveLength(20);
    const first = initial.sprites.find((entry) => entry.name === 'Plant 0')!;
    expect(first.scientificName).toBe('Example species');
    expect(JSON.stringify(initial)).not.toContain('local-source');
    const pixelsPath = path.join(out, 'artwork', first.pngSha256 + '.png');
    const bytes = await readFile(pixelsPath);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(first.pngSha256);
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(info.height);
    const alpha = data.filter((_, i) => i % 4 === 3);
    expect(alpha[0]).toBe(0);
    expect(alpha.filter((a) => a === 255)).toHaveLength(info.width * info.height / 2);
    const oriented = initial.sprites.find((entry) => entry.name === 'Plant 19')!;
    const orientedPixels = await sharp(path.join(out, 'artwork', oriented.pngSha256 + '.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const visible = [] as Array<{ x: number; y: number }>;
    for (let pixel = 0; pixel < orientedPixels.data.length / 4; pixel++) {
      if (orientedPixels.data[pixel * 4 + 3]! >= 128) visible.push({ x: pixel % orientedPixels.info.width, y: Math.floor(pixel / orientedPixels.info.width) });
    }
    expect(Math.max(...visible.map((p) => p.x)) - Math.min(...visible.map((p) => p.x))).toBeGreaterThan(
      Math.max(...visible.map((p) => p.y)) - Math.min(...visible.map((p) => p.y)),
    );
    await importRows(rows.toReversed());
    expect(await loadIndex()).toEqual(initial);

    await sharp({ create: { width: 3, height: 9, channels: 4, background: 'red' } }).png().toFile(path.join(dir, rows[0]!.file));
    await importRows(rows);
    const changed = await loadIndex();
    expect(changed.archived).toContainEqual(first);
    expect(changed.sprites.find((entry) => entry.name === first.name)?.id).not.toBe(first.id);
    expect(await readFile(pixelsPath)).toEqual(bytes);

    const files = await readdir(path.join(out, 'artwork'));
    await writeFile(path.join(dir, 'broken.png'), 'invalid');
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(path.join(dir, 'empty.png'));
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 80, b: 40, alpha: 0.4 } } }).png().toFile(path.join(dir, 'faint.png'));
    for (const bad of [
      { name: ' plant 0 ', file: rows[1]!.file },
      { name: 'Duplicate artwork', file: rows[0]!.file },
      { name: 'Broken', file: 'broken.png' },
      { name: 'Missing', file: 'missing.png' },
      { name: 'Empty', file: 'empty.png' },
      { name: 'Faint', file: 'faint.png' },
    ]) {
      await expect(importRows([rows[0]!, bad])).rejects.toThrow();
      expect(await loadIndex()).toEqual(changed);
      expect(await readdir(path.join(out, 'artwork'))).toEqual(files);
    }

    await mkdir(out + '.import-lock-v2', { recursive: true });
    await writeFile(path.join(out + '.import-lock-v2', 'ticket-999999999-00000000-0000-0000-0000-000000000000'), '1');
    await importRows(rows);
    expect(await loadIndex()).toEqual(changed);

    const concurrentA = path.join(dir, 'concurrent-a.json');
    const concurrentB = path.join(dir, 'concurrent-b.json');
    await sharp({ create: { width: 5, height: 9, channels: 4, background: 'blue' } }).png().toFile(path.join(dir, 'a.png'));
    await sharp({ create: { width: 9, height: 5, channels: 4, background: 'green' } }).png().toFile(path.join(dir, 'b.png'));
    await writeFile(concurrentA, JSON.stringify(rows.with(0, { ...rows[0]!, file: 'a.png' })));
    await writeFile(concurrentB, JSON.stringify(rows.with(0, { ...rows[0]!, file: 'b.png' })));
    await Promise.all([
      exec('npm', ['run', 'sprites:import', '--', '--input', concurrentA, '--out', out], { cwd: path.resolve(import.meta.dirname, '../../..') }),
      exec('npm', ['run', 'sprites:import', '--', '--input', concurrentB, '--out', out], { cwd: path.resolve(import.meta.dirname, '../../..') }),
    ]);
    const serialized = await loadIndex();
    const versions = [...serialized.sprites, ...serialized.archived].filter((entry) => entry.name === 'Plant 0');
    expect(new Set(versions.map((entry) => entry.id)).size).toBeGreaterThanOrEqual(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
