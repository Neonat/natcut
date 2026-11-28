import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { getStorage } from 'firebase-admin/storage';
import { NATCUT_ARTIFACT_BUCKET } from '@natcut/artifacts';
import { expect, it } from 'vitest';
import { createGcsRuntimeSpriteObjectStore } from '../src/runtime-sprite-gcs.ts';

const bytes = Buffer.from('private normalized sprite bytes');
const sha = createHash('sha256').update(bytes).digest('hex');
const path = `runtime-sprites/v1/${sha}.png`;
type NativeBucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;
const _bucketTypeCheck: Parameters<typeof createGcsRuntimeSpriteObjectStore>[0] = {} as NativeBucket;
void _bucketTypeCheck;

function fakeBucket() {
  let stored: Buffer | null = null;
  let currentGeneration = '41';
  let loseUploadResponse = false;
  let reportedSize: number | undefined;
  const saves: unknown[] = [];
  const bucket = {
    name: NATCUT_ARTIFACT_BUCKET,
    file(name: string, options?: { generation?: string }) {
      expect(name).toBe(path);
      return {
        async save(input: Buffer, settings: unknown) {
          saves.push(settings);
          if (stored) throw new Error('precondition failed');
          stored = Buffer.from(input);
          if (loseUploadResponse) throw new Error('upload response lost');
        },
        async getMetadata() {
          if (!stored || (options?.generation && options.generation !== currentGeneration)) throw new Error('generation missing');
          return [{ generation: currentGeneration, size: reportedSize ?? stored.length }] as [{ generation: string; size: number }];
        },
        createReadStream() {
          if (!stored || options?.generation !== currentGeneration) throw new Error('unpinned read');
          return Readable.from([Buffer.from(stored)]);
        },
      };
    },
  };
  return { bucket, saves,
    loseResponse: () => { loseUploadResponse = true; },
    changeBytes: (value: Buffer) => { stored = value; },
    changeGeneration: (value: string) => { currentGeneration = value; },
    reportSize: (value: number) => { reportedSize = value; },
  };
}

it('creates the content address once and reads only the pinned object generation', async () => {
  const fake = fakeBucket();
  const store = createGcsRuntimeSpriteObjectStore(fake.bucket);
  expect(await store.publishCreateOnly(path, bytes)).toEqual({ generation: '41' });
  expect(fake.saves[0]).toMatchObject({ resumable: false, validation: 'md5',
    preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'image/png' } });
  expect(await store.readExact(path, '41')).toEqual(bytes);
  fake.changeGeneration('42');
  await expect(store.readExact(path, '41')).rejects.toThrow(/generation missing/i);
  fake.changeGeneration('41');
  fake.reportSize(Number.NaN);
  await expect(store.readExact(path, '41')).rejects.toThrow(/metadata mismatch/i);
  fake.reportSize(1);
  await expect(store.readExact(path, '41')).rejects.toThrow(/exceeds metadata size/i);
});

it('recovers a lost create response only when existing pinned bytes match', async () => {
  const fake = fakeBucket();
  fake.loseResponse();
  const store = createGcsRuntimeSpriteObjectStore(fake.bucket);
  expect(await store.publishCreateOnly(path, bytes)).toEqual({ generation: '41' });
  expect(await store.publishCreateOnly(path, bytes)).toEqual({ generation: '41' });
  fake.changeBytes(Buffer.from('different'));
  await expect(store.publishCreateOnly(path, bytes)).rejects.toThrow(/bytes mismatch/i);
});

it('refuses a foreign bucket, path, digest, or unpinned generation', async () => {
  const fake = fakeBucket();
  expect(() => createGcsRuntimeSpriteObjectStore({ ...fake.bucket, name: 'foreign-bucket' })).toThrow(/bucket mismatch/i);
  const store = createGcsRuntimeSpriteObjectStore(fake.bucket);
  await expect(store.publishCreateOnly('../escape.png', bytes)).rejects.toThrow(/object path/i);
  await expect(store.publishCreateOnly(path, Buffer.from('changed'))).rejects.toThrow(/digest/i);
  await expect(store.readExact(path, '0')).rejects.toThrow(/generation/i);
});
