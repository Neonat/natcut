import { CompositionManifestSchema, type CompositionManifest } from './manifest.ts';
import { GeometryIssueSchema, type GeometryIssue } from './geometry.ts';
import { sha256Hex } from './sha256.ts';

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
  return sha256Hex(bytes);
}

export async function geometryIssuesHash(issues: GeometryIssue[] | unknown[]): Promise<string> {
  const normalized = issues
    .map((issue) => GeometryIssueSchema.parse(issue))
    .map((issue) => ({
      ...issue,
      ...(issue.cutGroupIds ? { cutGroupIds: [...issue.cutGroupIds].sort() } : {}),
    }))
    .sort((left, right) => JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right))));
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(normalized)));
  return sha256Hex(bytes);
}
