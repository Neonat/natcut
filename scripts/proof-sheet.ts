import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  CompositionManifestSchema,
  DEVFEST_SG_V1,
  manifestHash,
} from '@natcut/domain';
import { evaluateCutGeometry } from '@natcut/cut-geometry';
import {
  loadRgbaAsset,
  planComposition,
  renderCutGroupMasks,
  renderServerRaster,
  type AssetCatalog,
} from '@natcut/render';
import type { Contour, Point } from '../vendor/pixcut-trace/types.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = DEVFEST_SG_V1;
const padding = Object.freeze({ left: 8, right: 8, top: 14, bottom: 14 });

const fixtureManifest = CompositionManifestSchema.parse({
  schemaVersion: 1,
  spriteAssetId: 'sprite/monstera-v1',
  trainerAssetId: null,
  theme: 'default',
  brandingVariant: 'logo',
  cutGroups: [
    { id: 'main', members: ['sprite'] },
    { id: 'brand', members: ['branding'] },
  ],
  cutMarginMm: 1.5,
  renderVersion: 'fixture-v1',
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function svgPoints(points: Point[]): string {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ') + ' Z';
}

function contourPath(contour: Contour): string {
  return [contour.outer, ...contour.inners].map(svgPoints).filter(Boolean).join(' ');
}

function serializeContourPaths(contours: Contour[]): string[] {
  return contours.map(contourPath);
}

function buildOverlay(jpeg: Uint8Array, contours: Contour[]): string {
  const paths = serializeContourPaths(contours).map((serialized) => `<path d="${serialized}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${profile.rasterWidthPx}" height="${profile.rasterHeightPx}" viewBox="0 0 ${profile.rasterWidthPx} ${profile.rasterHeightPx}"><title>Offline preview; not print-ready</title><image width="${profile.rasterWidthPx}" height="${profile.rasterHeightPx}" href="data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}"/><g transform="translate(${padding.left} ${padding.top})" fill="none" stroke="#ef4444" stroke-width="2" vector-effect="non-scaling-stroke">${paths}</g></svg>`;
}

async function encodeSheet(rgba: Uint8ClampedArray): Promise<Buffer> {
  for (const quality of [90, 85, 80, 75, 70, 60, 50, 40]) {
    const jpeg = await sharp(Buffer.from(rgba), {
      raw: { width: profile.sheetWidthPx, height: profile.sheetHeightPx, channels: 4 },
    })
      .extend({ ...padding, background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toBuffer();
    if (jpeg.byteLength <= profile.jpegMaxBytes) return jpeg;
  }
  throw new Error(`Could not encode the offline preview below ${profile.jpegMaxBytes} bytes.`);
}

async function destinationExists(destination: string): Promise<boolean> {
  try {
    await access(destination);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

export async function generateSheetProof(destination: string): Promise<void> {
  const resolved = path.resolve(destination);
  if (await destinationExists(resolved)) throw new Error(`Output directory already exists: ${resolved}`);
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true });
  let ownsDestination = false;
  let stage: string | null = null;
  try {
    await mkdir(resolved);
    ownsDestination = true;
    await writeFile(path.join(resolved, '.incomplete'), 'NatCut proof generation is incomplete.\n', { flag: 'wx' });
    stage = await mkdtemp(path.join(parent, `.${path.basename(resolved)}.tmp-`));
    const loaded = await Promise.all([
      loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprite-fixture.png'), 'sprite/monstera-v1'),
      loadRgbaAsset(path.join(repoRoot, 'fixtures/assets/sprout-wordmark.png'), 'branding/logo'),
    ]);
    const assets: AssetCatalog = new Map(loaded.map((asset) => [asset.id, asset]));
    const plan = planComposition(fixtureManifest, profile);
    const raster = await renderServerRaster(plan, assets);
    const masks = renderCutGroupMasks(plan, assets);
    const geometry = await evaluateCutGeometry(masks, fixtureManifest.cutMarginMm, profile);
    if (!geometry.report.valid) {
      throw new Error(`Fixture geometry is not reviewable: ${geometry.report.issues.map((issue) => issue.code).join(', ')}`);
    }

    const jpeg = await encodeSheet(raster.rgba);
    const overlay = buildOverlay(jpeg, geometry.contours);
    const evidence = {
      label: 'offline preview; not print-ready',
      registrationAssumption: 'Logical artwork is centered using equal horizontal and vertical padding; physical registration is unverified.',
      profile: { id: profile.id, version: profile.version },
      paddingPx: padding,
      manifestHash: await manifestHash(fixtureManifest),
      logicalRaster: {
        width: raster.width,
        height: raster.height,
        sha256: raster.sha256,
      },
      cutMask: {
        sha256: geometry.report.rasterHash,
        geometryVersion: geometry.report.geometryVersion,
      },
      jpeg: {
        width: profile.rasterWidthPx,
        height: profile.rasterHeightPx,
        bytes: jpeg.byteLength,
        sha256: sha256(jpeg),
      },
      geometry: {
        valid: geometry.report.valid,
        severity: geometry.report.severity,
        issues: geometry.report.issues,
        contourCount: geometry.report.contourCount,
        pointCount: geometry.report.pointCount,
        cutLengthMm: geometry.report.cutLengthMm,
        minimumContourGapMm: geometry.report.minimumContourGapMm,
        edgeClearanceMm: geometry.report.edgeClearanceMm,
        contourSha256: sha256(new TextEncoder().encode(serializeContourPaths(geometry.contours).join('\n'))),
      },
    };

    await Promise.all([
      writeFile(path.join(stage, 'sheet.jpg'), jpeg, { flag: 'wx' }),
      writeFile(path.join(stage, 'cut-overlay.svg'), overlay, { encoding: 'utf8', flag: 'wx' }),
      writeFile(path.join(stage, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    ]);
    for (const name of ['sheet.jpg', 'cut-overlay.svg', 'evidence.json']) {
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

function parseOutputArgument(arguments_: string[]): string {
  const index = arguments_.indexOf('--out');
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith('-')) throw new Error('Usage: npm run proof:sheet -- --out <new-directory>');
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateSheetProof(parseOutputArgument(process.argv.slice(2)))
    .then(() => console.log('Created offline preview; not print-ready.'))
    .catch((cause) => {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exitCode = 1;
    });
}
