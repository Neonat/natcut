import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { NATCUT_ARTIFACT_BUCKET } from '@natcut/artifacts';
import { RuntimeSpriteIntegrityError, type RuntimeSpriteObjectStore } from './runtime-sprite.ts';

type Metadata = { generation?: string | number; size?: string | number; contentEncoding?: string };
type PinnedFile = {
  save(bytes: Buffer, options: { resumable: false; validation: 'md5';
    preconditionOpts: { ifGenerationMatch: 0 }; metadata: { contentType: 'image/png' } }): Promise<void>;
  getMetadata(): Promise<[Metadata, ...unknown[]]>;
  createReadStream(options: { validation: 'md5'; decompress: false }): Readable;
};
type Bucket = { name: string; file(path: string, options?: { generation?: string }): PinnedFile };

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pathPattern = /^runtime-sprites\/v1\/([a-f0-9]{64})\.png$/;
const generationPattern = /^[1-9][0-9]*$/;

export function createGcsRuntimeSpriteObjectStore(bucket: Bucket): RuntimeSpriteObjectStore {
  if (bucket.name !== NATCUT_ARTIFACT_BUCKET) throw new RuntimeSpriteIntegrityError('Runtime sprite bucket mismatch.');
  function checkPath(path: string) {
    const match = pathPattern.exec(path);
    if (!match) throw new RuntimeSpriteIntegrityError('Invalid runtime sprite object path.');
    return match[1]!;
  }
  async function readExact(path: string, generation: string): Promise<Buffer> {
    const expectedDigest = checkPath(path);
    if (!generationPattern.test(generation)) throw new RuntimeSpriteIntegrityError('Invalid object generation.');
    const file = bucket.file(path, { generation });
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    if (String(metadata.generation) !== generation || metadata.contentEncoding ||
      !Number.isSafeInteger(size) || size < 1 || size > 20_000_000) {
      throw new RuntimeSpriteIntegrityError('Pinned runtime sprite metadata mismatch.');
    }
    const chunks: Buffer[] = [];
    let observed = 0;
    for await (const chunk of file.createReadStream({ validation: 'md5', decompress: false })) {
      if (!(chunk instanceof Uint8Array)) throw new RuntimeSpriteIntegrityError('Invalid runtime sprite stream chunk.');
      observed += chunk.byteLength;
      if (observed > size) throw new RuntimeSpriteIntegrityError('Pinned runtime sprite response exceeds metadata size.');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, observed);
    if (bytes.length !== size || digest(bytes) !== expectedDigest) {
      throw new RuntimeSpriteIntegrityError('Pinned runtime sprite bytes mismatch.');
    }
    return bytes;
  }
  return {
    readExact,
    async publishCreateOnly(path, bytes) {
      if (digest(bytes) !== checkPath(path) || bytes.length > 20_000_000) {
        throw new RuntimeSpriteIntegrityError('Runtime sprite upload digest or length mismatch.');
      }
      try {
        await bucket.file(path).save(bytes, { resumable: false, validation: 'md5',
          preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'image/png' } });
      } catch {
        // A lost create response and an existing content-addressed object use the same readback path.
      }
      const [metadata] = await bucket.file(path).getMetadata();
      const generation = String(metadata.generation);
      const pinned = await readExact(path, generation);
      if (!pinned.equals(bytes)) throw new RuntimeSpriteIntegrityError('Existing runtime sprite object differs from the upload.');
      return { generation };
    },
  };
}
