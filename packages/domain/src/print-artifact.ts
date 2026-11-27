import { z } from 'zod';
import { PublishedPrintProfileSchema, printProfileHashSync } from './print-profile.ts';
import { sha256Hex } from './sha256.ts';

const version = z.string().min(1).max(64);
const positiveInteger = z.number().int().positive();
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
// Whole ICC profiles, not mutable descriptions or an RGB channel count. First the three
// libvips built-ins, then Apple's sRGB, Display P3 and Generic CMYK profiles.
const supportedProfiles = new Map<string, 'srgb' | 'display-p3' | 'cmyk'>([
  ['c56e1685d888f5edb92fe07f2750f387f8fe8e91b32ff8fb0b56bfbbb9458353', 'srgb'],
  ['231752984cd4a5278e1b8d2390fe496767d4511fc81f54e1a5c69ae9ab4c42b5', 'display-p3'],
  ['156e7c14f244cfc4ed83a755ca4803d80e15dd249b40fae82cb127d3902e15c7', 'cmyk'],
  ['2b3aa1645779a9e634744faf9b01e9102b0c9b88fd6deced7934df86b949af7e', 'srgb'],
  ['0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0', 'display-p3'],
  ['0c8a584b288a306eac9e1d3f1e68bc1b64331c717ceb051420e6257f17b3509a', 'cmyk'],
]);

export function recognizedIccSpace(profileSha256: string) {
  return supportedProfiles.get(profileSha256);
}

export const SrgbColorEvidenceSchema = z.strictObject({
  outputSpace: z.literal('srgb'),
  pipelineVersion: z.literal('natcut-srgb-v1'),
  sourceSpace: z.enum(['srgb', 'display-p3', 'cmyk']),
  sourceProfileSha256: digest.nullable(),
  action: z.enum(['preserved', 'converted']),
}).refine(evidence => evidence.sourceSpace === 'srgb'
  ? evidence.action === 'preserved'
  : evidence.action === 'converted' && evidence.sourceProfileSha256 !== null,
{ message: 'Source profile, source space and color action must agree.' })
  .refine(evidence => evidence.sourceProfileSha256 === null || recognizedIccSpace(evidence.sourceProfileSha256) === evidence.sourceSpace,
    { message: 'The ICC profile must be recognized and match the source color space.' }).readonly();

export type SrgbColorEvidence = z.infer<typeof SrgbColorEvidenceSchema>;
// For pixels authored directly in sRGB or received through the digest-verified catalog contract.
export const NATIVE_SRGB_EVIDENCE = SrgbColorEvidenceSchema.parse({
  outputSpace: 'srgb', pipelineVersion: 'natcut-srgb-v1', sourceSpace: 'srgb',
  sourceProfileSha256: null, action: 'preserved',
});

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

const payloadFields = {
  colorByteLength: positiveInteger,
  colorSha256: digest,
  maskByteLength: positiveInteger,
  maskSha256: digest,
  byteLength: positiveInteger,
  bundleSha256: digest,
  profileSha256: digest,
};
export const LogicalSourceBundleDescriptorSchema = z.discriminatedUnion('formatVersion', [
  metadata.safeExtend({ formatVersion: z.literal(1), ...payloadFields }).strict(),
  metadata.safeExtend({ formatVersion: z.literal(2), ...payloadFields, colorEvidence: SrgbColorEvidenceSchema }).strict(),
]).refine((descriptor) => {
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

export function artifactObjectPath(descriptor: Pick<LogicalSourceBundleDescriptor, 'formatVersion' | 'bundleSha256'>): string {
  const version = z.union([z.literal(1), z.literal(2)]).parse(descriptor.formatVersion);
  return 'logical/v' + version + '/' + digest.parse(descriptor.bundleSha256);
}

type LogicalSource = z.input<typeof metadata> & { colorEvidence: SrgbColorEvidence; rgba: Uint8Array | Uint8ClampedArray; mask: Uint8Array };

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
  const colorEvidence = SrgbColorEvidenceSchema.parse(source.colorEvidence);
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
    descriptor: { formatVersion: 2, colorEvidence, ...header, ...sizes, ...hashes, profileSha256: printProfileHashSync(header.profile) },
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
