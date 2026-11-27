# Trusted Artifacts and Cloud Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the locally verifiable trusted-artifact foundation and offline named-index readiness boundary without changing Firestore acceptance, cloud resources, or printer behavior.

**Architecture:** Trusted server preparation produces a strict V1 bundle from the exact rendered RGBA and combined expanded mask under a resolved immutable print profile. A local content-addressed store proves create-only publication and bounded verification; a pure checker validates expected Firestore indexes from supplied JSON.

**Tech Stack:** TypeScript, Zod, Node crypto/filesystem, Vitest, existing render and cut-geometry packages.

**Spec:** `docs/superpowers/specs/2026-11-27-trusted-artifacts-cloud-ops-design.md`

## Global Constraints

- Preserve the existing `validation.rasterHash` wire and persistence semantics.
- Do not change Firestore submission records in this tranche.
- Do not invoke Firebase, Google Cloud, USB, or printer operations.
- Keep `firebase.json` Hosting-only.
- Use additive APIs and keep existing tests passing.

## Review Focus

- Same-alpha color changes must alter only the color/bundle identities, not the mask acknowledgement identity.
- Malformed lengths, surplus bytes, non-binary masks, and digest mismatches must fail before consumers receive bytes.
- Concurrent or repeated publication must converge on one verified content-addressed object.
- Interrupted temporary files must never appear as complete objects.
- Named-database index checks must reject the default/wrong database and non-ready indexes.

---

### Task 1: Freeze profile identity and expose the exact combined mask

**Files:**
- Modify: `packages/domain/src/print-profile.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/cut-geometry/src/evaluate.ts`
- Test: `packages/domain/test/print-profile.test.ts`
- Test: `packages/cut-geometry/test/evaluate.test.ts`

**Interfaces:**
- Produces: `resolvePrintProfile(id, version)`, `printProfileHash(profile)`, and `GeometryEvaluation.combinedMask`.

- [ ] Write failing tests for exact profile lookup, unknown versions, stable profile hashes, and `combinedMask` equality with `report.rasterHash`.
- [ ] Run the targeted tests and observe failure.
- [ ] Implement the immutable registry, canonical profile hash, and returned combined mask without recomputation.
- [ ] Run targeted tests and typecheck.
- [ ] Commit the independently passing unit.

### Task 2: Define and verify logical source bundle V1

**Files:**
- Create: `packages/domain/src/print-artifact.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/test/print-artifact.test.ts`

**Interfaces:**
- Consumes: resolved `PrintProfile`, exact RGBA bytes, exact binary mask bytes.
- Produces: `encodeLogicalSourceBundle`, `decodeLogicalSourceBundle`, `LogicalSourceBundleDescriptorSchema`.

- [ ] Write failing round-trip, color-only change, corrupt digest, wrong length, surplus bytes, non-binary mask, and unknown-profile tests.
- [ ] Run the targeted tests and observe failure.
- [ ] Implement strict descriptor schemas, exact length derivation, component and bundle hashes, encoding, and bounded decoding.
- [ ] Run targeted tests and typecheck.
- [ ] Commit the independently passing unit.

### Task 3: Prepare trusted artifacts from one render/geometry evaluation

**Files:**
- Modify: `apps/submission/src/validation.ts`
- Modify: `apps/submission/src/index.ts`
- Test: `apps/submission/test/validation.test.ts`

**Interfaces:**
- Consumes: `resolvePrintProfile`, `renderServerRaster`, `GeometryEvaluation.combinedMask`, `encodeLogicalSourceBundle`.
- Produces: `createTrustedArtifactPreparer(...): PrepareTrustedArtifact`; retains `createTrustedManifestValidator` as a compatibility projection.

- [ ] Write failing tests proving trusted bytes come from server rendering, profile consistency, color/mask hashes, and unchanged legacy validation output.
- [ ] Run the targeted tests and observe failure.
- [ ] Implement one-pass preparation and keep the old validator API as `prepared.report`.
- [ ] Run submission and geometry tests plus typecheck.
- [ ] Commit the independently passing unit.

### Task 4: Add create-only local content-addressed storage

**Files:**
- Create: `packages/artifacts/package.json`
- Create: `packages/artifacts/tsconfig.json`
- Create: `packages/artifacts/src/index.ts`
- Create: `packages/artifacts/src/local-store.ts`
- Create: `packages/artifacts/test/local-store.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: encoded V1 bytes and descriptor bundle hash.
- Produces: `LocalArtifactStore.putIfAbsent(bytes, descriptor)` and `readVerified(descriptor)`.

- [ ] Write failing tests for first write, duplicate reuse, corrupt existing object, bounded read, concurrent publication, and abandoned temporary file.
- [ ] Run the targeted tests and observe failure.
- [ ] Implement exclusive temporary writes, atomic rename, path derivation from validated hashes, and read-back verification.
- [ ] Run targeted tests and workspace typecheck.
- [ ] Commit the independently passing unit.

### Task 5: Add pure named-index readiness verification

**Files:**
- Create: `scripts/verify-natcut-indexes.mjs`
- Create: `test/natcut-indexes.test.mjs`
- Modify: `package.json`
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: checked-in `firestore.indexes.json` and an operator-supplied JSON inventory.
- Produces: read-only `npm run verify:indexes -- --inventory <path>` with explicit project/database validation and actionable readiness output.

- [ ] Write failing tests for exact ready inventory, missing index, building index, wrong project/database, and any mutation-capable argument.
- [ ] Run the targeted tests and observe failure.
- [ ] Implement the pure comparison CLI; it must never spawn another process or call a network API.
- [ ] Update the runbook to separate offline verification from later authorized live listing/deployment.
- [ ] Run targeted tests, the full suite, and typecheck.
- [ ] Commit the independently passing unit.

### Task 6: Whole-slice verification and review

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: a reviewable branch whose existing submission behavior is unchanged and whose new primitives are proven locally.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Inspect one real packaged fixture bundle and verify its declared lengths and hashes.
- [ ] Run a dependency-boundary check proving the new packages do not import USB or printer bridge code.
- [ ] Review the diff for Firestore, cloud, and hardware side effects; there must be none.
- [ ] Request a fresh whole-branch code review and fix accepted findings.
