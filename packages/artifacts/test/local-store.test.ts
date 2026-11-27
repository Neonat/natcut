import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { DEVFEST_SG_V1 as profile, encodeLogicalSourceBundle, type LogicalSourceBundle } from '@natcut/domain';
import { LocalArtifactStore } from '../src/index.ts';

let bundle: LogicalSourceBundle;
let root: string, objectPath: string, store: LocalArtifactStore;

beforeAll(async () => {
  const { sheetWidthPx: width, sheetHeightPx: height } = profile;
  bundle = await encodeLogicalSourceBundle({
    width, height, profile, rgba: new Uint8Array(width * height * 4), mask: new Uint8Array(width * height),
    renderVersion: 'fixture-v1', geometryVersion: 'natcut-geometry-v1',
  });
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'natcut-artifacts-'));
  store = new LocalArtifactStore(root);
  objectPath = join(root, bundle.descriptor.bundleSha256);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('creates a verified object once and reuses its original inode', async () => {
  const { bytes, descriptor } = bundle;
  expect(await store.putIfAbsent(bytes, descriptor)).toBe('created');
  const original = await stat(objectPath);
  expect(await store.putIfAbsent(bytes, descriptor)).toBe('reused');
  expect((await stat(objectPath)).ino).toBe(original.ino);
  const verified = await store.readVerified(descriptor);
  expect(createHash('sha256').update(verified).digest('hex')).toBe(descriptor.bundleSha256);
});

it('detects equally sized corrupt objects without replacing them', async () => {
  const corrupt = bundle.bytes.slice();
  corrupt[0] = 2;
  await writeFile(objectPath, corrupt);
  await expect(store.putIfAbsent(bundle.bytes, bundle.descriptor)).rejects.toThrow(/digest/i);
  await expect(store.readVerified(bundle.descriptor)).rejects.toThrow(/digest/i);
  expect((await readFile(objectPath))[0]).toBe(2);
});

it('rejects oversized sparse objects before reading their contents', async () => {
  const file = await open(objectPath, 'wx');
  await file.close();
  await truncate(objectPath, 2 ** 32);
  await expect(store.readVerified(bundle.descriptor)).rejects.toThrow(/length/i);
});

it('converges concurrent publishers from different store instances', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    new LocalArtifactStore(root).putIfAbsent(bundle.bytes, bundle.descriptor)));
  expect(results.sort()).toEqual(['created', 'reused', 'reused', 'reused']);
  expect(await readdir(root)).toEqual([bundle.descriptor.bundleSha256]);
  expect((await store.readVerified(bundle.descriptor)).length).toBe(bundle.bytes.length);
});

it('never reads abandoned temporary files as complete objects', async () => {
  const abandoned = join(root, '.interrupted.tmp');
  await writeFile(abandoned, bundle.bytes.subarray(0, 30));
  await expect(store.readVerified(bundle.descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await store.putIfAbsent(bundle.bytes, bundle.descriptor)).toBe('created');
  expect((await stat(abandoned)).size).toBe(30);
});

it('rejects invalid bytes and path-like hashes before creating any files', async () => {
  const { bytes, descriptor } = bundle;
  await expect(store.putIfAbsent(bytes.subarray(1), descriptor)).rejects.toThrow(/length/i);
  await expect(store.readVerified({ ...descriptor, bundleSha256: '../elsewhere' })).rejects.toThrow();
  await expect(store.putIfAbsent(bytes, { ...descriptor, maskSha256: '1'.repeat(64) })).rejects.toThrow(/digest/i);
  expect(await readdir(root)).toEqual([]);
});

it('rejects a symlink in place of a complete object', async () => {
  const other = join(root, 'other');
  await writeFile(other, bundle.bytes);
  await symlink(other, objectPath);
  await expect(store.readVerified(bundle.descriptor)).rejects.toThrow();
  await expect(store.putIfAbsent(bundle.bytes, bundle.descriptor)).rejects.toThrow();
});

it('rejects a symlink configured as the store root', async () => {
  const linkedRoot = join(root, 'linked-root');
  await symlink(root, linkedRoot);
  const linkedStore = new LocalArtifactStore(linkedRoot);
  await expect(linkedStore.putIfAbsent(bundle.bytes, bundle.descriptor)).rejects.toThrow(/real private directory/i);
  await expect(linkedStore.readVerified(bundle.descriptor)).rejects.toThrow(/real private directory/i);
});

it('rejects an existing store root with group or world permissions', async () => {
  await chmod(root, 0o755);
  await expect(store.putIfAbsent(bundle.bytes, bundle.descriptor)).rejects.toThrow(/private permissions/i);
  await expect(store.readVerified(bundle.descriptor)).rejects.toThrow(/private permissions/i);
});
