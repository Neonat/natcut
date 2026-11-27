import { z } from 'zod';
import { PublishedPrintProfileSchema, printProfileHashSync } from './print-profile.ts';
import { sha256Hex } from './sha256.ts';

const version = z.string().min(1).max(64);
const positiveInteger = z.number().int().positive();
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
const metadata = z.object({
  profile: PublishedPrintProfileSchema,
  width: positiveInteger,
  height: positiveInteger,
  renderVersion: version,
  geometryVersion: version,
}).refine(({ profile, width, height }) => width === profile.sheetWidthPx && height === profile.sheetHeightPx,
  { message: 'Logical dimensions must match the published profile sheet.' });

// The registered sheet dimensions bound allocations. Also guard arithmetic if a future profile grows.
function lengths(width: number, height: number) {
  const maskByteLength = width * height;
  const colorByteLength = maskByteLength * 4;
  const byteLength = colorByteLength + maskByteLength;
  if (!Number.isSafeInteger(byteLength)) throw new Error('Logical source length exceeds the safe integer range.');
  return { colorByteLength, maskByteLength, byteLength };
}

export const LogicalSourceBundleDescriptorSchema = metadata.safeExtend({
  formatVersion: z.literal(1),
  colorByteLength: positiveInteger,
  colorSha256: digest,
  maskByteLength: positiveInteger,
  maskSha256: digest,
  byteLength: positiveInteger,
  bundleSha256: digest,
  profileSha256: digest,
}).strict().refine((descriptor) => {
  const expected = lengths(descriptor.profile.sheetWidthPx, descriptor.profile.sheetHeightPx);
  return descriptor.colorByteLength === expected.colorByteLength &&
    descriptor.maskByteLength === expected.maskByteLength && descriptor.byteLength === expected.byteLength;
}, { message: 'Declared byte lengths must match the published profile sheet.' })
  .refine((descriptor) => descriptor.profileSha256 === printProfileHashSync(descriptor.profile),
    { message: 'Print profile digest mismatch.' });

export type LogicalSourceBundleDescriptor = z.infer<typeof LogicalSourceBundleDescriptorSchema>;
export type LogicalSourceBundle = { descriptor: LogicalSourceBundleDescriptor; bytes: Uint8Array };
export const ArtifactGenerationSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .pipe(z.string().refine(value => BigInt(value) <= 9223372036854775807n, 'Generation exceeds positive int64 range.'));
export const ArtifactReceiptSchema = z.strictObject({
  descriptor: LogicalSourceBundleDescriptorSchema,
  generation: ArtifactGenerationSchema,
});
export type ArtifactReceipt = z.infer<typeof ArtifactReceiptSchema>;

export function artifactObjectPath(bundleSha256: string): string {
  return 'logical/v1/' + digest.parse(bundleSha256);
}

type LogicalSource = z.input<typeof metadata> & { rgba: Uint8Array | Uint8ClampedArray; mask: Uint8Array };

const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)?.get;
const typedArrayName = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

function actualByteLength(value: unknown, allowedKinds: string[]): number {
  if (!typedArrayByteLength || !typedArrayName) throw new Error('Typed-array metadata is unavailable.');
  try {
    const kind = typedArrayName.call(value) as string | undefined;
    if (!kind || !allowedKinds.includes(kind)) throw new Error('Unexpected typed-array kind.');
    return typedArrayByteLength.call(value) as number;
  } catch {
    throw new Error(`Expected ${allowedKinds.join(' or ')} artifact bytes.`);
  }
}

function assertBinaryMask(mask: Uint8Array) {
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] !== 0 && mask[index] !== 255) throw new Error('Expected a binary cut mask (0 or 255).');
  }
}

async function hashPayload(bytes: Uint8Array, colorByteLength: number) {
  const mask = bytes.subarray(colorByteLength);
  assertBinaryMask(mask);
  const [colorSha256, maskSha256, bundleSha256] = await Promise.all([
    sha256Hex(bytes.subarray(0, colorByteLength)), sha256Hex(mask), sha256Hex(bytes),
  ]);
  return { colorSha256, maskSha256, bundleSha256 };
}

export async function encodeLogicalSourceBundle(source: LogicalSource): Promise<LogicalSourceBundle> {
  const rgba = source.rgba;
  const mask = source.mask;
  const header = metadata.parse(source);
  const sizes = lengths(header.width, header.height);
  if (
    actualByteLength(rgba, ['Uint8Array', 'Uint8ClampedArray']) !== sizes.colorByteLength ||
    actualByteLength(mask, ['Uint8Array']) !== sizes.maskByteLength
  ) {
    throw new Error('Logical source byte length mismatch.');
  }
  const bytes = new Uint8Array(sizes.byteLength);
  bytes.set(rgba);
  bytes.set(mask, sizes.colorByteLength);
  const hashes = await hashPayload(bytes, sizes.colorByteLength);
  return {
    descriptor: { formatVersion: 1, ...header, ...sizes, ...hashes, profileSha256: printProfileHashSync(header.profile) },
    bytes,
  };
}

export async function verifyLogicalSourceBundleDescriptor(input: unknown): Promise<LogicalSourceBundleDescriptor> {
  return LogicalSourceBundleDescriptorSchema.parse(input);
}

export async function decodeLogicalSourceBundle(input: Uint8Array, descriptorInput: unknown) {
  const descriptor = await verifyLogicalSourceBundleDescriptor(descriptorInput);
  const inputByteLength = actualByteLength(input, ['Uint8Array']);
  if (inputByteLength !== descriptor.byteLength) throw new Error('Bundle byte length mismatch.');
  // Copy through intrinsic typed-array operations. Callers can shadow properties
  // such as byteLength or methods such as slice on otherwise branded instances.
  const bytes = new Uint8Array(inputByteLength);
  Uint8Array.prototype.set.call(bytes, input);
  if (bytes.byteLength !== descriptor.byteLength) throw new Error('Bundle byte length mismatch.');
  const hashes = await hashPayload(bytes, descriptor.colorByteLength);
  if (hashes.colorSha256 !== descriptor.colorSha256) throw new Error('Color digest mismatch.');
  if (hashes.maskSha256 !== descriptor.maskSha256) throw new Error('Mask digest mismatch.');
  if (hashes.bundleSha256 !== descriptor.bundleSha256) throw new Error('Bundle digest mismatch.');
  return { bytes, descriptor, rgba: bytes.subarray(0, descriptor.colorByteLength), mask: bytes.subarray(descriptor.colorByteLength) };
}
