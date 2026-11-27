import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeLogicalSourceBundle, verifyLogicalSourceBundleDescriptor } from '@natcut/domain';

export class LocalArtifactStore {
  private readonly root: string;

  /** `directory` must live below a stable parent controlled by the process owner. */
  constructor(directory: string) {
    this.root = resolve(directory);
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

  async putIfAbsent(input: Uint8Array, descriptorInput: unknown): Promise<'created' | 'reused'> {
    const { bytes, descriptor } = await decodeLogicalSourceBundle(input, descriptorInput);
    await this.ensurePrivateRoot(true);
    const target = join(this.root, descriptor.bundleSha256);
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      // POSIX rename replaces an existing object. A same-directory hard link publishes
      // the complete inode atomically and fails with EEXIST if another writer won.
      let result: 'created' | 'reused' = 'created';
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        result = 'reused';
      }
      await this.readVerified(descriptor);
      return result;
    } finally {
      await unlink(temporary);
    }
  }

  async readVerified(descriptorInput: unknown): Promise<Uint8Array> {
    const descriptor = await verifyLogicalSourceBundleDescriptor(descriptorInput);
    await this.ensurePrivateRoot(false);
    const file = await open(join(this.root, descriptor.bundleSha256),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== descriptor.byteLength) throw new Error('Artifact type or byte length mismatch.');
      const bytes = new Uint8Array(descriptor.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) throw new Error('Artifact truncated while reading.');
        offset += bytesRead;
      }
      const tail = await file.read(new Uint8Array(1), 0, 1, offset);
      if (tail.bytesRead !== 0) throw new Error('Artifact grew while reading.');
      return (await decodeLogicalSourceBundle(bytes, descriptor)).bytes;
    } finally {
      await file.close();
    }
  }
}
