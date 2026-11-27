import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import { isPreparedArtifactPair } from './prepared-evidence.ts';
import type { PreparedPhysicalArtifacts } from './artifacts.ts';
import { uploadFramePayloadBytes } from './upload-frame-size.ts';

const capturedUuid = 'f45d69a1da22727c26aa863ea657de8b32a501f2';
const capturedHash = '26b8714aea78792854637621ad5cf1c4ed31ad1f';

export type UploadPayload = {
  kind: 'plt' | 'jpeg';
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
};

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function planUploadPayloads(artifacts: PreparedPhysicalArtifacts): UploadPayload[] {
  if (artifacts.print?.kind !== 'print-raster-jpeg' || artifacts.cut?.kind !== 'cut-path-plt') throw new Error('Prepared artifact role mismatch.');
  if (!isPreparedArtifactPair(artifacts)) throw new Error('Expected the pair issued by verified physical preparation.');
  const { descriptor } = artifacts.receipt;
  if (!isDeepStrictEqual(artifacts.profile, descriptor.profile)) {
    throw new Error('Prepared print profile differs from the immutable artifact receipt.');
  }
  if (artifacts.cut.sourceMaskSha256 !== descriptor.maskSha256) {
    throw new Error('Prepared cut mask digest differs from the immutable artifact receipt.');
  }
  if (digest(artifacts.print.preview.data) !== artifacts.print.generationQc.previewSha256) {
    throw new Error('Canonical print preview digest mismatch.');
  }
  const jpeg = new Uint8Array(artifacts.print.bytes);
  const plt = new Uint8Array(artifacts.cut.bytes);
  if (jpeg.byteLength > artifacts.profile.jpegMaxBytes) {
    throw new Error('Prepared JPEG exceeds the immutable profile byte limit.');
  }
  if (digest(jpeg) !== artifacts.print.sha256) throw new Error('Prepared JPEG digest mismatch.');
  if (digest(plt) !== artifacts.cut.sha256) throw new Error('Prepared PLT digest mismatch.');
  const document = parsePlt(new TextDecoder().decode(plt));
  if (document.knifePressure !== artifacts.profile.knifePressure) {
    throw new Error('Prepared PLT pressure differs from the immutable profile.');
  }
  if (document.paths.length === 0) throw new Error('Prepared PLT contains no cut path.');
  return [
    { kind: 'plt', bytes: plt, byteLength: plt.byteLength, sha256: artifacts.cut.sha256 },
    { kind: 'jpeg', bytes: jpeg, byteLength: jpeg.byteLength, sha256: artifacts.print.sha256 },
  ];
}

export function planComboJob(artifacts: PreparedPhysicalArtifacts) {
  const [cut, image] = planUploadPayloads(artifacts);
  if (!cut || !image || cut.kind !== 'plt' || image.kind !== 'jpeg') throw new Error('Invalid upload ordering.');
  const profile = artifacts.profile;
  const documentBase = `natcut-${artifacts.receipt.descriptor.bundleSha256.slice(0, 32)}`;
  return {
    method: 'combo-job' as const,
    params: [
      { method: 'print-job' as const, params: {
        uuid: capturedUuid,
        'job-url': '',
        'print-quality': profile.printQuality,
        copies: profile.copies,
        'document-name': `${documentBase}.jpg`,
        'file-size': image.byteLength,
        'document-format': 9,
        'hash-method': 1,
        'hash-value': capturedHash,
        'media-size': profile.mediaSize,
        'media-type': profile.mediaType,
        'user-account': '12345678',
        'job-type': 600,
        channel: 14864,
        timeout: 180,
      } },
      { method: 'cut-job' as const, params: {
        'file-size': cut.byteLength,
        'document-format': 18,
        'document-name': `${documentBase}.plt`,
        'job-url': '',
        'hash-method': 1,
        'hash-value': capturedHash,
        timeout: 100,
      } },
    ],
  };
}

function verifyPayload(payload: UploadPayload) {
  if (payload.byteLength !== payload.bytes.byteLength) throw new Error('Upload payload length mismatch.');
  if (digest(payload.bytes) !== payload.sha256) throw new Error('Upload payload digest mismatch.');
}

export function frameUploadPayload(payload: UploadPayload, jobId: number): Uint8Array[] {
  verifyPayload(payload);
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || jobId > 0xffff_ffff) {
    throw new Error('Printer job ID must be a positive unsigned 32-bit integer.');
  }
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < payload.bytes.byteLength; offset += uploadFramePayloadBytes) {
    const body = payload.bytes.subarray(offset, offset + uploadFramePayloadBytes);
    const header = new TextEncoder().encode(`cmd data EXTLEN=${body.byteLength + 4}\n`);
    const frame = new Uint8Array(header.byteLength + 4 + body.byteLength);
    frame.set(header);
    new DataView(frame.buffer).setUint32(header.byteLength, jobId, true);
    frame.set(body, header.byteLength + 4);
    frames.push(frame);
  }
  if (frames.length === 0) throw new Error('Upload payload must not be empty.');
  return frames;
}
