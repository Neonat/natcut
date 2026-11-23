import { CompositionManifestSchema, type CompositionManifest } from './manifest.ts';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalManifestJson(manifest: unknown): string {
  const parsed = CompositionManifestSchema.parse(manifest);
  return JSON.stringify(canonicalize(parsed));
}

export async function manifestHash(manifest: CompositionManifest | unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifestJson(manifest));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
