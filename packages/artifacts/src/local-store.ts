import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeLogicalSourceBundle, verifyLogicalSourceBundleDescriptor, type ArtifactReceipt, type LogicalSourceBundle } from '@natcut/domain';
import type { ArtifactPublisher } from './publisher.ts';
import { ArtifactIntegrityError, parseArtifactReceipt, verifyArtifactBytes, type ArtifactReader } from './reader.ts';

export class LocalArtifactStore implements ArtifactPublisher, ArtifactReader {
  private readonly root: string;

  /** `directory` must live below a stable parent controlled by the process owner. */
  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async publish(bundle: LogicalSourceBundle, { signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted();
    const descriptor = await verifyLogicalSourceBundleDescriptor(bundle.descriptor);
    await this.putIfAbsent(bundle.bytes, descriptor, signal);
    signal?.throwIfAborted();
    // A local content address has exactly one immutable generation.
    return { descriptor, generation: '1' };
  }

  private async ensurePrivateRoot(create: boolean): Promise<void> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('Artifact store root must be a real private directory.');
    }
    if ((root.mode & 0o077) !== 0 || (process.getuid && root.uid !== process.getuid())) {
      throw new Error('Artifact store root must be owned by this process user with private permissions.');
    }
  }

  async putIfAbsent(input: Uint8Array, descriptorInput: unknown, signal?: AbortSignal): Promise<'created' | 'reused'> {
    signal?.throwIfAborted();
    const { bytes, descriptor } = await decodeLogicalSourceBundle(input, descriptorInput);
    signal?.throwIfAborted();
    await this.ensurePrivateRoot(true);
    const target = join(this.root, descriptor.bundleSha256);
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes, signal ? { signal } : undefined);
        await file.sync();
      } finally {
        await file.close();
      }
      // POSIX rename replaces an existing object. A same-directory hard link publishes
      // the complete inode atomically and fails with EEXIST if another writer won.
      let result: 'created' | 'reused' = 'created';
      signal?.throwIfAborted();
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        result = 'reused';
      }
      await this.readVerified(descriptor, signal);
      return result;
    } finally {
      await unlink(temporary);
    }
  }

  async readVerified(descriptorInput: unknown, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const descriptor = await verifyLogicalSourceBundleDescriptor(descriptorInput);
    return (await this.readLocalGeneration({ descriptor, generation: '1' }, signal)).bytes;
  }

  async read(receiptInput: ArtifactReceipt, { signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted();
    const receipt = parseArtifactReceipt(receiptInput);
    if (receipt.generation !== '1') throw new ArtifactIntegrityError('Missing local artifact generation.');
    try {
      return await this.readLocalGeneration(receipt, signal);
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new ArtifactIntegrityError('Missing or invalid local artifact object.', { cause: error });
      }
      throw error;
    }
  }

  private async readLocalGeneration(receipt: ArtifactReceipt, signal?: AbortSignal) {
    const { descriptor } = receipt;
    await this.ensurePrivateRoot(false);
    const file = await open(join(this.root, descriptor.bundleSha256),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== descriptor.byteLength) throw new ArtifactIntegrityError('Artifact type or byte length mismatch.');
      const bytes = new Uint8Array(descriptor.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new ArtifactIntegrityError('Artifact truncated while reading.');
        offset += bytesRead;
      }
      const tail = await file.read(new Uint8Array(1), 0, 1, offset);
      if (tail.bytesRead !== 0) throw new ArtifactIntegrityError('Artifact grew while reading.');
      const verified = await verifyArtifactBytes(bytes, receipt);
      signal?.throwIfAborted();
      return verified;
    } finally {
      await file.close();
    }
  }
}
