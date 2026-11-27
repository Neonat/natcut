import { DEVFEST_SG_V1 as profile, NATIVE_SRGB_EVIDENCE, encodeLogicalSourceBundle } from '@natcut/domain';
import { preparePhysicalArtifacts } from '../src/artifacts.ts';

export async function prepared(shape: 'rectangle' | 'circles' = 'rectangle') {
  const { sheetWidthPx: width, sheetHeightPx: height } = profile;
  const rgba = new Uint8Array(width * height * 4);
  const mask = new Uint8Array(width * height);
  for (let y = 500; y < 900; y++) for (let x = 300; x < 700; x++) {
    if (shape === 'circles' && ((x - 300) % 80 - 40) ** 2 + ((y - 500) % 80 - 40) ** 2 > 30 ** 2) continue;
    const pixel = y * width + x;
    mask[pixel] = 255;
    rgba.set([21, 157, 188, 255], pixel * 4);
  }
  const bundle = await encodeLogicalSourceBundle({
    width, height, profile, rgba, mask, colorEvidence: NATIVE_SRGB_EVIDENCE,
    renderVersion: 'server-raster-v1', geometryVersion: 'geometry-v1',
  });
  return preparePhysicalArtifacts({ bytes: bundle.bytes, receipt: { descriptor: bundle.descriptor, generation: '7' } });
}
