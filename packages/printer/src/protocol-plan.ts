import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parsePlt } from '../../../vendor/pixcut-trace/plt.ts';
import type { PreparedPhysicalArtifacts } from './artifacts.ts';

const capturedUuid = 'f45d69a1da22727c26aa863ea657de8b32a501f2';
const capturedHash = '26b8714aea78792854637621ad5cf1c4ed31ad1f';
const dataExtlen = 4075;
const dataPayloadBytes = dataExtlen - 4;

export type UploadPayload = {
  kind: 'plt' | 'jpeg';
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
};

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyArtifacts(artifacts: PreparedPhysicalArtifacts) {
  const { descriptor } = artifacts.receipt;
  if (!isDeepStrictEqual(artifacts.profile, descriptor.profile)) {
    throw new Error('Prepared print profile differs from the immutable artifact receipt.');
  }
  if (artifacts.sourceMaskSha256 !== descriptor.maskSha256) {
    throw new Error('Prepared cut mask digest differs from the immutable artifact receipt.');
  }
  if (artifacts.jpeg.byteLength > artifacts.profile.jpegMaxBytes) {
    throw new Error('Prepared JPEG exceeds the immutable profile byte limit.');
  }
  if (digest(artifacts.jpeg) !== artifacts.jpegSha256) throw new Error('Prepared JPEG digest mismatch.');
  if (digest(artifacts.plt) !== artifacts.pltSha256) throw new Error('Prepared PLT digest mismatch.');
  const document = parsePlt(new TextDecoder().decode(artifacts.plt));
  if (document.knifePressure !== artifacts.profile.knifePressure) {
    throw new Error('Prepared PLT pressure differs from the immutable profile.');
  }
  if (document.paths.length === 0) throw new Error('Prepared PLT contains no cut path.');
}

export function planUploadPayloads(artifacts: PreparedPhysicalArtifacts): UploadPayload[] {
  verifyArtifacts(artifacts);
  return [
    { kind: 'plt', bytes: new Uint8Array(artifacts.plt), byteLength: artifacts.plt.byteLength, sha256: artifacts.pltSha256 },
    { kind: 'jpeg', bytes: new Uint8Array(artifacts.jpeg), byteLength: artifacts.jpeg.byteLength, sha256: artifacts.jpegSha256 },
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
  for (let offset = 0; offset < payload.bytes.byteLength; offset += dataPayloadBytes) {
    const body = payload.bytes.subarray(offset, offset + dataPayloadBytes);
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
