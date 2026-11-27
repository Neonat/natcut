import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepared } from './prepared-fixture.ts';
import * as preparationAuthority from '../src/prepared-evidence.ts';
import type { PreparedPhysicalArtifacts } from '../src/artifacts.ts';
import { frameUploadPayload, planComboJob, planUploadPayloads } from '../src/index.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('protocol plan', () => {
  it('exposes only checked preparation and a read-only membership test from the source authority', () => {
    expect(Object.keys(preparationAuthority).sort()).toEqual(['isPreparedArtifactPair', 'preparePhysicalArtifacts']);
  });

  it('declares the exact deterministic print-and-cut documents from immutable evidence', async () => {
    const artifact = await prepared();
    const document = 'natcut-' + artifact.receipt.descriptor.bundleSha256.slice(0, 32);
    const plan = planComboJob(artifact);
    expect(plan).toEqual({
      method: 'combo-job',
      params: [
        { method: 'print-job', params: {
          uuid: 'f45d69a1da22727c26aa863ea657de8b32a501f2',
          'job-url': '', 'print-quality': 4, copies: 1,
          'document-name': `${document}.jpg`, 'file-size': artifact.print.bytes.length, 'document-format': 9,
          'hash-method': 1, 'hash-value': '26b8714aea78792854637621ad5cf1c4ed31ad1f',
          'media-size': 5013, 'media-type': 2030, 'user-account': '12345678',
          'job-type': 600, channel: 14864, timeout: 180,
        } },
        { method: 'cut-job', params: {
          'file-size': artifact.cut.bytes.length, 'document-format': 18,
          'document-name': `${document}.plt`, 'job-url': '',
          'hash-method': 1, 'hash-value': '26b8714aea78792854637621ad5cf1c4ed31ad1f', timeout: 100,
        } },
      ],
    });
    expect(planComboJob(await prepared())).toEqual(plan);
  });

  it('orders the exact PLT before the exact JPEG and rejects changed bytes', async () => {
    const artifacts = await prepared();
    expect(planUploadPayloads(artifacts).map(({ kind, byteLength, sha256 }) => ({ kind, byteLength, sha256 })))
      .toEqual([
        { kind: 'plt', byteLength: artifacts.cut.bytes.byteLength, sha256: artifacts.cut.sha256 },
        { kind: 'jpeg', byteLength: artifacts.print.bytes.byteLength, sha256: artifacts.print.sha256 },
      ]);
    artifacts.print.bytes[2] = artifacts.print.bytes[2]! ^ 255;
    expect(() => planUploadPayloads(artifacts)).toThrow(/JPEG digest/i);
    expect(() => planComboJob(artifacts)).toThrow(/JPEG digest/i);
  });

  it('rejects an exchanged cut and print role before planning either upload', async () => {
    const pair = await prepared();
    const swapped = { ...pair, print: pair.cut, cut: pair.print };
    expect(() => planUploadPayloads(swapped as unknown as PreparedPhysicalArtifacts)).toThrow();
  });

  it('rejects a substituted print JPEG even with matching caller-supplied hashes and copied QC evidence', async () => {
    const pair = await prepared();
    const overlay = new TextEncoder().encode('<svg><path stroke="red"/></svg>');
    const forged = { ...pair, print: { ...pair.print, bytes: overlay, sha256: sha256(overlay) } };
    expect(() => planUploadPayloads(forged)).toThrow(/verified physical preparation/i);
  });

  it('blocks a changed canonical preview when its original JPEG still matches', async () => {
    const pair = await prepared();
    pair.print.preview.data[0] = 0;
    expect(() => planUploadPayloads(pair)).toThrow(/preview digest/i);
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
    const bytes = new Uint8Array([1]);
    const payload = { kind: 'plt' as const, bytes, byteLength: 1, sha256: sha256(bytes) };
    expect(() => frameUploadPayload(payload, jobId)).toThrow(/job ID/i);
  });

  it('rejects a payload whose declared length does not match its bytes', () => {
    const bytes = new Uint8Array([1]);
    const payload = { kind: 'plt' as const, bytes, byteLength: 999, sha256: sha256(bytes) };
    expect(() => frameUploadPayload(payload, 1)).toThrow(/length/i);
  });
});
