import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyArtifactBytes } from '@natcut/artifacts';
import { DEVFEST_SG_V1, encodeLogicalSourceBundle } from '@natcut/domain';
import { publishPhysicalDryRun } from '../src/index.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function artifact() {
  const profile = DEVFEST_SG_V1;
  const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
  const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
  for (let y = 700; y < 760; y++) for (let x = 500; x < 560; x++) {
    const pixel = y * profile.sheetWidthPx + x;
    rgba.set([20, 150, 70, 255], pixel * 4);
    mask[pixel] = 255;
  }
  const bundle = await encodeLogicalSourceBundle({
    width: profile.sheetWidthPx, height: profile.sheetHeightPx, profile,
    renderVersion: 'server-raster-v1', geometryVersion: 'geometry-v1', rgba, mask,
  });
  return verifyArtifactBytes(bundle.bytes, { descriptor: bundle.descriptor, generation: '17' });
}

describe('publishPhysicalDryRun', () => {
  it('publishes a complete create-only packet with exact reproducible evidence and no job ID', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'natcut-physical-dry-run-'));
    const output = path.join(parent, 'packet');
    try {
      const input = await artifact();
      await publishPhysicalDryRun(input, output);
      expect((await readdir(output)).sort()).toEqual(['cut.plt', 'evidence.json', 'print.jpg']);
      const jpeg = await readFile(path.join(output, 'print.jpg'));
      const plt = await readFile(path.join(output, 'cut.plt'));
      const evidence = JSON.parse(await readFile(path.join(output, 'evidence.json'), 'utf8'));
      expect(evidence).toMatchObject({
        schemaVersion: 1,
        label: 'physical adapter dry-run; no printer command sent',
        transport: 'disabled-dry-run',
        input: {
          generation: '17',
          bundleSha256: input.receipt.descriptor.bundleSha256,
          colorSha256: input.receipt.descriptor.colorSha256,
          maskSha256: input.receipt.descriptor.maskSha256,
          profileSha256: input.receipt.descriptor.profileSha256,
        },
        outputs: {
          jpeg: { file: 'print.jpg', bytes: jpeg.byteLength, sha256: sha256(jpeg) },
          plt: { file: 'cut.plt', bytes: plt.byteLength, sha256: sha256(plt), knifePressure: 42 },
        },
        protocol: {
          requiresPrinterJobIdAfterDeclaration: true,
          acknowledgementRequiredPerChunk: true,
          pacingMs: 120,
          uploadOrder: ['cut.plt', 'print.jpg'],
        },
      });
      expect(evidence.protocol.declaration.method).toBe('combo-job');
      expect(JSON.stringify(evidence)).not.toMatch(/"jobId"\s*:/);

      const original = await readFile(path.join(output, 'evidence.json'));
      await expect(publishPhysicalDryRun(input, output)).rejects.toThrow(/already exists/i);
      expect(await readFile(path.join(output, 'evidence.json'))).toEqual(original);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('removes its reserved output when immutable input verification fails', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'natcut-physical-dry-run-fail-'));
    const output = path.join(parent, 'packet');
    try {
      const input = await artifact();
      input.bytes[0] = input.bytes[0]! ^ 255;
      await expect(publishPhysicalDryRun(input, output)).rejects.toThrow(/artifact|digest/i);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('publishes no packet when real devfest JPEG bytes remain above one MiB at quality 50', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'natcut-physical-dry-run-large-'));
    const output = path.join(parent, 'packet');
    try {
      const profile = DEVFEST_SG_V1;
      const rgba = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx * 4);
      const mask = new Uint8Array(profile.sheetWidthPx * profile.sheetHeightPx);
      let state = 54321;
      for (let pixel = 0; pixel < profile.sheetWidthPx * profile.sheetHeightPx; pixel++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        const value = state < 0 ? 0 : 255;
        rgba.set([value, value, value, 255], pixel * 4);
      }
      for (let y = 700; y < 760; y++) for (let x = 500; x < 560; x++) {
        mask[y * profile.sheetWidthPx + x] = 255;
      }
      const bundle = await encodeLogicalSourceBundle({
        width: profile.sheetWidthPx, height: profile.sheetHeightPx, profile,
        renderVersion: 'server-raster-v1', geometryVersion: 'geometry-v1', rgba, mask,
      });
      const input = await verifyArtifactBytes(bundle.bytes, { descriptor: bundle.descriptor, generation: '18' });
      await expect(publishPhysicalDryRun(input, output)).rejects.toThrow(/JPEG|1048576|1 MiB/i);
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 15_000);
});
