import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const PrintProfileSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.number().int().positive(),
    mediaSize: z.number().int().positive(),
    mediaType: z.number().int().positive(),
    sheetWidthPx: z.number().int().positive(),
    sheetHeightPx: z.number().int().positive(),
    rasterWidthPx: z.number().int().positive(),
    rasterHeightPx: z.number().int().positive(),
    printQuality: z.number().int().positive(),
    copies: z.number().int().positive(),
    knifePressure: z.number().int().min(1).max(100),
    cutHoles: z.boolean(),
    alphaThreshold: z.number().int().min(0).max(255),
    jpegMaxBytes: z.number().int().positive(),
  })
  .strict();

export type PrintProfile = z.infer<typeof PrintProfileSchema>;

export const DEVFEST_SG_V1 = Object.freeze(PrintProfileSchema.parse({
  id: 'devfest-sg-v1',
  version: 1,
  mediaSize: 5013,
  mediaType: 2030,
  sheetWidthPx: 1200,
  sheetHeightPx: 2100,
  rasterWidthPx: 1216,
  rasterHeightPx: 2128,
  printQuality: 4,
  copies: 1,
  knifePressure: 42,
  cutHoles: false,
  alphaThreshold: 128,
  jpegMaxBytes: 1_048_576,
}));

const publishedProfiles = Object.freeze([DEVFEST_SG_V1]);

function findProfile(id: string, version: number) {
  return publishedProfiles.find((entry) => entry.id === id && entry.version === version);
}

export function resolvePrintProfile(id: string, version: number): Readonly<PrintProfile> {
  const profile = findProfile(id, version);
  if (!profile) throw new Error(`Unknown print profile ${id} version ${version}.`);
  return profile;
}

// Artifact snapshots carry the literal published ID, including its exact spelling.
export const PublishedPrintProfileSchema = PrintProfileSchema.extend({ id: z.string().min(1) })
  .transform((snapshot, context) => {
    const profile = findProfile(snapshot.id, snapshot.version);
    if (!profile || Object.entries(snapshot).some(([key, value]) => profile[key as keyof PrintProfile] !== value)) {
      context.addIssue({ code: 'custom', message: 'Snapshot does not match a published print profile.' });
      return z.NEVER;
    }
    return profile;
  });

export function printProfileHashSync(profile: unknown): string {
  const snapshot = PrintProfileSchema.parse(profile);
  const canonical = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

export function printProfileHash(profile: unknown): Promise<string> {
  return Promise.resolve(printProfileHashSync(profile));
}
