/// <reference lib="webworker" />
import { buildDistanceField, evaluateCutGeometry } from '@natcut/cut-geometry';
import { DEVFEST_SG_V1, type CutGroupMember } from '@natcut/domain';
import type { CutGroupMask } from '@natcut/render';
import type { CutPreviewRequest, CutPreviewResult } from '../editor/use-cut-preview.ts';

const width = DEVFEST_SG_V1.sheetWidthPx;
const height = DEVFEST_SG_V1.sheetHeightPx;

function fillEllipse(alpha: Uint8Array, cx: number, cy: number, rx: number, ry: number) {
  for (let y = Math.max(0, cy - ry); y <= Math.min(height - 1, cy + ry); y++) {
    for (let x = Math.max(0, cx - rx); x <= Math.min(width - 1, cx + rx); x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) alpha[y * width + x] = 255;
    }
  }
}

function fillRect(alpha: Uint8Array, left: number, top: number, rectWidth: number, rectHeight: number) {
  for (let y = top; y < top + rectHeight; y++) alpha.fill(255, y * width + left, y * width + left + rectWidth);
}

function addMember(alpha: Uint8Array, member: CutGroupMember) {
  if (member === 'sprite') fillEllipse(alpha, 600, 850, 380, 380);
  else if (member === 'trainer') fillEllipse(alpha, 420, 850, 285, 405);
  else fillRect(alpha, 390, 1850, 420, 105);
}

let cachedKey = '';
let cachedMasks: CutGroupMask[] = [];
let cachedFields: ReturnType<typeof buildDistanceField>[] = [];

self.addEventListener('message', async (event: MessageEvent<CutPreviewRequest>) => {
  const { revision, manifest } = event.data;
  const { cutMarginMm: _cutMarginMm, ...geometryManifest } = manifest;
  const key = JSON.stringify(geometryManifest);
  if (key !== cachedKey) {
    cachedKey = key;
    cachedMasks = manifest.cutGroups.map((group) => {
      const alpha = new Uint8Array(width * height);
      for (const member of group.members) addMember(alpha, member);
      return { id: group.id, width, height, alpha };
    });
    cachedFields = cachedMasks.map((mask) => buildDistanceField(mask, DEVFEST_SG_V1.alphaThreshold));
  }
  const evaluation = await evaluateCutGeometry(cachedMasks, manifest.cutMarginMm, DEVFEST_SG_V1, cachedFields);
  const result: CutPreviewResult = {
    revision,
    report: evaluation.report,
    contours: evaluation.contours.map((contour) => contour.outer),
  };
  self.postMessage(result);
});
