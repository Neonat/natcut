import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { VerifiedArtifact } from '@natcut/artifacts';
import { preparePhysicalArtifacts } from './artifacts.ts';
import { planComboJob, planUploadPayloads } from './protocol-plan.ts';

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

export async function publishPhysicalDryRun(input: VerifiedArtifact, destination: string): Promise<void> {
  const resolved = path.resolve(destination);
  if (await exists(resolved)) throw new Error(`Output directory already exists: ${resolved}`);

  const prepared = await preparePhysicalArtifacts(input);
  const declaration = planComboJob(prepared);
  const payloads = planUploadPayloads(prepared);
  const evidence = {
    schemaVersion: 1,
    label: 'physical adapter dry-run; no printer command sent',
    transport: 'disabled-dry-run',
    input: {
      generation: prepared.receipt.generation,
      bundleSha256: prepared.receipt.descriptor.bundleSha256,
      colorSha256: prepared.receipt.descriptor.colorSha256,
      maskSha256: prepared.receipt.descriptor.maskSha256,
      profileSha256: prepared.receipt.descriptor.profileSha256,
      renderVersion: prepared.receipt.descriptor.renderVersion,
      geometryVersion: prepared.receipt.descriptor.geometryVersion,
      profile: prepared.profile,
    },
    outputs: {
      jpeg: {
        file: 'print.jpg',
        width: prepared.profile.rasterWidthPx,
        height: prepared.profile.rasterHeightPx,
        bytes: prepared.jpeg.byteLength,
        sha256: prepared.jpegSha256,
        quality: prepared.jpegQuality,
      },
      plt: {
        file: 'cut.plt',
        bytes: prepared.plt.byteLength,
        sha256: prepared.pltSha256,
        knifePressure: prepared.profile.knifePressure,
        stats: prepared.cutStats,
      },
    },
    protocol: {
      declaration,
      requiresPrinterJobIdAfterDeclaration: true,
      acknowledgementRequiredPerChunk: true,
      chunkExtlen: 4075,
      maximumPayloadBytesPerChunk: 4071,
      pacingMs: 120,
      uploadOrder: ['cut.plt', 'print.jpg'],
      payloads: payloads.map((payload) => ({
        kind: payload.kind,
        bytes: payload.byteLength,
        sha256: payload.sha256,
        chunkCount: Math.ceil(payload.byteLength / 4071),
      })),
    },
  };

  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true });
  let ownsDestination = false;
  let stage: string | null = null;
  try {
    try {
      await mkdir(resolved);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Output directory already exists: ${resolved}`);
      }
      throw cause;
    }
    ownsDestination = true;
    await writeFile(path.join(resolved, '.incomplete'), 'NatCut physical dry-run generation is incomplete.\n', { flag: 'wx' });
    stage = await mkdtemp(path.join(parent, `.${path.basename(resolved)}.tmp-`));
    await Promise.all([
      writeFile(path.join(stage, 'print.jpg'), prepared.jpeg, { flag: 'wx' }),
      writeFile(path.join(stage, 'cut.plt'), prepared.plt, { flag: 'wx' }),
      writeFile(path.join(stage, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' }),
    ]);
    for (const name of ['print.jpg', 'cut.plt', 'evidence.json']) {
      await rename(path.join(stage, name), path.join(resolved, name));
    }
    await rm(path.join(resolved, '.incomplete'));
    await rm(stage, { recursive: true, force: true });
  } catch (cause) {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (ownsDestination) await rm(resolved, { recursive: true, force: true });
    throw cause;
  }
}
