/// <reference lib="webworker" />
import { buildDistanceField, evaluateCutGeometry } from '@natcut/cut-geometry';
import { canonicalManifestJson, DEVFEST_SG_V1, type CompositionManifest } from '@natcut/domain';
import { loadPlannedAssets, planComposition, renderCutGroupMasks, type RgbaAsset } from '@natcut/render/browser';
import type { CutPreviewRequest, CutPreviewResult } from '../editor/use-cut-preview.ts';

async function loadAsset(filename: string, id: string): Promise<RgbaAsset> {
  const response = await fetch('/' + filename);
  if (!response.ok) throw new Error('Artwork unavailable');
  const image = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create the cut-preview canvas');
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;
    return { id, width: image.width, height: image.height, rgba };
  } finally {
    image.close();
  }
}

function compositionKey(manifest: CompositionManifest) {
  return canonicalManifestJson({ ...manifest, cutMarginMm: 1.5 });
}

// A pair of full-sheet masks and distance fields is about 50 MB. Keep only the
// current composition so changing its border reuses the fields at bounded cost.
let prepared: {
  key: string;
  masks: ReturnType<typeof renderCutGroupMasks>;
  fields: ReturnType<typeof buildDistanceField>[];
} | null = null;
let pending: CutPreviewRequest | null = null;
let busy = false;

async function processPreview({ revision, manifest }: CutPreviewRequest): Promise<void> {
  const manifestFingerprint = canonicalManifestJson(manifest);
  const key = compositionKey(manifest);
  if (prepared?.key !== key) {
    prepared = null;
    const plan = planComposition(manifest, DEVFEST_SG_V1);
    const assets = await loadPlannedAssets(plan, loadAsset);
    if (pending && compositionKey(pending.manifest) !== key) return;
    const masks = renderCutGroupMasks(plan, assets);
    prepared = { key, masks, fields: masks.map((mask) => buildDistanceField(mask, DEVFEST_SG_V1.alphaThreshold)) };
  }
  if (pending) return;
  const { report, contours } = await evaluateCutGeometry(prepared.masks, manifest.cutMarginMm, DEVFEST_SG_V1, prepared.fields);
  const result: CutPreviewResult = {
    revision, manifestFingerprint, report,
    contours: contours.flatMap((contour) => [contour.outer, ...contour.inners]),
  };
  self.postMessage(result);
}

async function drain() {
  busy = true;
  try {
    while (pending) {
      const request = pending;
      pending = null;
      try {
        await processPreview(request);
      } catch {
        const result: CutPreviewResult = {
          revision: request.revision, manifestFingerprint: canonicalManifestJson(request.manifest),
          error: 'Could not prepare the sprite preview.',
        };
        self.postMessage(result);
      }
    }
  } finally {
    busy = false;
  }
}

self.addEventListener('message', (event: MessageEvent<CutPreviewRequest>) => {
  pending = event.data;
  if (!busy) void drain();
});
