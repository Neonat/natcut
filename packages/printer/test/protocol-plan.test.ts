import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEVFEST_SG_V1, printProfileHashSync } from '@natcut/domain';
import type { PreparedPhysicalArtifacts } from '../src/artifacts.ts';
import { frameUploadPayload, planComboJob, planUploadPayloads } from '../src/index.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function prepared(): PreparedPhysicalArtifacts {
  const jpeg = new Uint8Array([255, 216, 1, 2, 255, 217]);
  const plt = new TextEncoder().encode('IN VER0.1.0 KP42 U1,1 D1,1 D2,2 U6476,0  @ ');
  return {
    receipt: {
      generation: '7',
      descriptor: {
        formatVersion: 1,
        profile: DEVFEST_SG_V1,
        width: 1200,
        height: 2100,
        renderVersion: 'server-raster-v1',
        geometryVersion: 'geometry-v1',
        colorByteLength: 10_080_000,
        colorSha256: 'a'.repeat(64),
        maskByteLength: 2_520_000,
        maskSha256: 'c'.repeat(64),
        byteLength: 12_600_000,
        bundleSha256: 'b'.repeat(64),
        profileSha256: printProfileHashSync(DEVFEST_SG_V1),
      },
    },
    profile: DEVFEST_SG_V1,
    jpeg,
    jpegSha256: sha256(jpeg),
    jpegQuality: 95,
    plt,
    pltSha256: sha256(plt),
    sourceMaskSha256: 'c'.repeat(64),
    cutStats: { pathCount: 0, pointCount: 0, cutLengthMm: 0, travelLengthMm: 0 },
  };
}

describe('protocol plan', () => {
  it('declares the exact deterministic print-and-cut documents from immutable evidence', () => {
    const plan = planComboJob(prepared());
    expect(plan).toEqual({
      method: 'combo-job',
      params: [
        { method: 'print-job', params: {
          uuid: 'f45d69a1da22727c26aa863ea657de8b32a501f2',
          'job-url': '', 'print-quality': 4, copies: 1,
          'document-name': `natcut-${'b'.repeat(32)}.jpg`, 'file-size': 6, 'document-format': 9,
          'hash-method': 1, 'hash-value': '26b8714aea78792854637621ad5cf1c4ed31ad1f',
          'media-size': 5013, 'media-type': 2030, 'user-account': '12345678',
          'job-type': 600, channel: 14864, timeout: 180,
        } },
        { method: 'cut-job', params: {
          'file-size': 43, 'document-format': 18,
          'document-name': `natcut-${'b'.repeat(32)}.plt`, 'job-url': '',
          'hash-method': 1, 'hash-value': '26b8714aea78792854637621ad5cf1c4ed31ad1f', timeout: 100,
        } },
      ],
    });
    expect(planComboJob(prepared())).toEqual(plan);
  });

  it('orders the exact PLT before the exact JPEG and rejects changed bytes', () => {
    const artifacts = prepared();
    expect(planUploadPayloads(artifacts).map(({ kind, byteLength, sha256 }) => ({ kind, byteLength, sha256 })))
      .toEqual([
        { kind: 'plt', byteLength: artifacts.plt.byteLength, sha256: artifacts.pltSha256 },
        { kind: 'jpeg', byteLength: artifacts.jpeg.byteLength, sha256: artifacts.jpegSha256 },
      ]);
    artifacts.jpeg[2] = artifacts.jpeg[2]! ^ 255;
    expect(() => planUploadPayloads(artifacts)).toThrow(/JPEG digest/i);
    expect(() => planComboJob(artifacts)).toThrow(/JPEG digest/i);
  });

  it('frames 4071-byte payload chunks with exact EXTLEN and little-endian job ID', () => {
    const bytes = new Uint8Array(5000).map((_, index) => index & 255);
    const payload = { kind: 'plt' as const, bytes, byteLength: bytes.byteLength, sha256: sha256(bytes) };
    const frames = frameUploadPayload(payload, 0x12345678);
    expect(frames).toHaveLength(2);
    const firstNewline = frames[0]!.indexOf(10);
    expect(new TextDecoder().decode(frames[0]!.subarray(0, firstNewline + 1))).toBe('cmd data EXTLEN=4075\n');
    expect(new DataView(frames[0]!.buffer, frames[0]!.byteOffset + firstNewline + 1, 4).getUint32(0, true))
      .toBe(0x12345678);
    expect(frames[0]!.subarray(firstNewline + 5)).toEqual(bytes.subarray(0, 4071));
    const secondNewline = frames[1]!.indexOf(10);
    expect(new TextDecoder().decode(frames[1]!.subarray(0, secondNewline + 1))).toBe('cmd data EXTLEN=933\n');
    expect(frames[1]!.subarray(secondNewline + 5)).toEqual(bytes.subarray(4071));
  });

  it.each([0, -1, 1.5, 0x1_0000_0000, Number.NaN])('rejects invalid printer job ID %s', (jobId) => {
    const payload = planUploadPayloads(prepared())[0]!;
    expect(() => frameUploadPayload(payload, jobId)).toThrow(/job ID/i);
  });

  it('rejects a payload whose declared length does not match its bytes', () => {
    const payload = { ...planUploadPayloads(prepared())[0]!, byteLength: 999 };
    expect(() => frameUploadPayload(payload, 1)).toThrow(/length/i);
  });
});
