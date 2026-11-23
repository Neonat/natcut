/// <reference lib="webworker" />
import { buildDistanceField, evaluateCutGeometry } from '@natcut/cut-geometry';
import { canonicalManifestJson, DEVFEST_SG_V1 } from '@natcut/domain';
import {
  planComposition,
  renderCutGroupMasks,
  type AssetCatalog,
  type RgbaAsset,
} from '@natcut/render/browser';
import type { CutPreviewRequest, CutPreviewResult } from '../editor/use-cut-preview.ts';

async function loadAsset(url: string, id: string): Promise<RgbaAsset> {
  const response = await fetch(url);
  const image = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create the cut-preview canvas');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  image.close();
  return { id, width: canvas.width, height: canvas.height, rgba: new Uint8ClampedArray(data) };
}

const assetsPromise: Promise<AssetCatalog> = Promise.all([
  loadAsset('/sprite-fixture.png', 'sprite/monstera-v1'),
  loadAsset('/sprite-fixture.png', 'trainer/friend-v1'),
  loadAsset('/sprout-wordmark.png', 'branding/logo'),
  loadAsset('/sprout-wordmark.png', 'branding/logo-and-sprites'),
  loadAsset('/sprout-wordmark.png', 'branding/logo-and-species'),
]).then((assets) => new Map(assets.map((asset) => [asset.id, asset])));

type PreparedGeometry = {
  masks: ReturnType<typeof renderCutGroupMasks>;
  fields: ReturnType<typeof buildDistanceField>[];
};

const geometryCache = new Map<string, Promise<PreparedGeometry>>();

function prepareGeometry(key: string, manifest: CutPreviewRequest['manifest']): Promise<PreparedGeometry> {
  const existing = geometryCache.get(key);
  if (existing) return existing;
  const pending = assetsPromise.then((assets) => {
    const masks = renderCutGroupMasks(planComposition(manifest, DEVFEST_SG_V1), assets);
    return {
      masks,
      fields: masks.map((mask) => buildDistanceField(mask, DEVFEST_SG_V1.alphaThreshold)),
    };
  });
  geometryCache.set(key, pending);
  return pending;
}

self.addEventListener('message', async (event: MessageEvent<CutPreviewRequest>) => {
  const { revision, manifest } = event.data;
  const { cutMarginMm: _cutMarginMm, ...geometryManifest } = manifest;
  const key = JSON.stringify(geometryManifest);
  const prepared = await prepareGeometry(key, manifest);
  const evaluation = await evaluateCutGeometry(
    prepared.masks,
    manifest.cutMarginMm,
    DEVFEST_SG_V1,
    prepared.fields,
  );
  const result: CutPreviewResult = {
    revision,
    report: evaluation.report,
    contours: evaluation.contours.map((contour) => contour.outer),
    manifestFingerprint: canonicalManifestJson(manifest),
  };
  self.postMessage(result);
});
