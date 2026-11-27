# Generation and physical QC implementation plan

Implemented on a local branch based on the PR #9 merge. The original journal remains unavailable for binding the historical owner report.

**Goal:** Prove the sRGB print artifact before transport, keep cut data out of the JPEG, and record the completed printer attempt and ribbon-registration QC without enabling resend.

**Architecture:** Version the trusted color contract in the logical bundle, prepare typed print and cut artifacts from separate inputs, and gate the final JPEG against a canonical sRGB preview. Extend the existing SQLite journal with append-only observation tables and expose only read and record operations to the local operator UI.

**Tech Stack:** TypeScript, Node.js, Sharp, Zod, better-sqlite3, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-28-generation-qc-design.md`

## Global constraints

- No deployment, USB access, printer command, resend, second physical attempt, push, or merge.
- Do not import or modify the production-hardening branch.
- Version 1 trusted artifacts remain readable and keep their existing object paths.
- New trusted artifacts emit version 2 with explicit sRGB evidence.
- The print JPEG and cut PLT are separate typed outputs. A cut overlay is never printable input.
- Ribbon registration is printer-internal physical QC, not image-generation QC.
- The existing `transport_attempts` row remains immutable and permanently blocks resend.
- Do not invent a journal evidence hash, printer job ID, or CMY channel result for the historical attempt.

## Shipped contracts

Reviewed import pins original candidate bytes in `sources/` and checks that re-normalizing the original reproduces the reviewed PNG and color evidence. The logical receipt retains the canonical set of these source profiles and the native branding. A verified v2 bundle supplies the typed print JPEG and cut PLT. The print raster never consumes the mask or display overlay. The final JPEG is checked against its actual padded RGB8 encoder input.

The inclusive software limits for `natcut-jpeg-qc-v1` are MAE 19,313 thousandths per channel, p99 of 96, 201,249 ppm above 32, and 9 levels of tile bias. Rerun the corpus with `npx vitest run --project printer test/qc-calibration.test.ts test/generation-qc.test.ts`. [Calibration report](../../../packages/printer/test/jpeg-qc-calibration.md)

The completed physical attempt failed print quality due to printer-internal ribbon registration. The checked-in owner report records three uncertain channel assessments and the permanent lock. Local append-only endpoints record the exact outcome and post-print CMY record only against the original journal. Software encoding limits cannot prevent ribbon registration defects. [Source evidence](../../evidence/physical-attempt-2026-11-28.json)

## Review focus

- An untagged external PNG must fail at the trusted boundary rather than inherit Sharp's default color interpretation. Task 1 tests this.
- A format version 1 receipt must keep verifying at `logical/v1`, while new format version 2 receipts use `logical/v2`. Task 1 tests this.
- A red cut overlay or a mask-only change must not change final JPEG pixels. Task 2 tests this.
- The JPEG QC thresholds must remain tied to deterministic calibration fixtures and still reject channel swaps and drift. Task 2 tests this.
- A second journal handle or duplicate HTTP request must not mutate the locked attempt or re-enable a send path. Tasks 3 and 4 test this.

---

### Task 1: Trusted sRGB logical artifacts

**Files:**
- Modify: `packages/domain/src/print-artifact.ts`
- Modify: `packages/render/src/assets.ts`
- Modify: `packages/render/src/server-raster.ts`
- Modify: `packages/artifacts/src/reader.ts`
- Modify: callers that create or parse logical bundles
- Test: `packages/domain/test/print-artifact.test.ts`
- Test: `packages/render/test/assets.test.ts`
- Test: `packages/artifacts/test/reader.test.ts`

**Interfaces:**
- Produces: `SrgbColorEvidence`, a versioned logical descriptor union, version-aware `artifactObjectPath`, and trusted sRGB RGBA assets whose evidence survives composition.
- Preserves: read compatibility for every format version 1 descriptor and receipt.

- [x] Write failing tests for tagged sRGB preservation, Display P3 or CMYK conversion, ambiguous external input rejection, evidence propagation, version 2 encoding, version 1 reading, and version-aware object paths.
- [x] Run the focused domain, render, and artifact tests and confirm the new cases fail for missing behavior.
- [x] Add the descriptor union and strict `SrgbColorEvidence` schema. Make new bundle encoding emit version 2 and keep a version 1 decoder.
- [x] Add one trusted image decode boundary that converts recognized profiles to sRGB and rejects ambiguous external images. Carry immutable color evidence through server composition.
- [x] Migrate bundle creation and receipt parsing callers. Do not change existing version 1 identities.
- [x] Run the focused tests and all TypeScript workspace checks.
- [x] Commit with `feat: bind trusted artifacts to sRGB evidence`.

### Task 2: Typed print and cut outputs with calibrated JPEG QC

**Files:**
- Modify: `packages/printer/src/artifacts.ts`
- Modify: `packages/printer/src/protocol-plan.ts`
- Modify: `packages/printer/src/physical-proof.ts`
- Modify: `packages/printer/src/dry-run.ts`
- Modify: printer callers and exports
- Create: `packages/printer/src/generation-qc.ts`
- Test: `packages/printer/test/artifacts.test.ts`
- Test: `packages/printer/test/physical-proof.test.ts`
- Test: `packages/printer/test/protocol-plan.test.ts`

**Interfaces:**
- Consumes: versioned logical artifacts and `SrgbColorEvidence` from Task 1.
- Produces: `PreparedPrintArtifact`, `PreparedCutArtifact`, `CanonicalPrintPreview`, and `GenerationQcResult` using `natcut-jpeg-qc-v1`.

- [x] Write failing public-interface tests for mask-only and color-only independence, role confusion, overlay injection, canonical preview dimensions, decoded JPEG comparison, and actionable QC failures.
- [x] Add deterministic calibration fixtures for flat colors, gradients, sharp edges, transparency, and seeded high detail. Record all chosen JPEG qualities, observed valid maxima, the integer margin, and the adversarial failures.
- [x] Run the focused tests and confirm the separation and QC cases fail before implementation.
- [x] Split preparation into a print constructor that consumes only sRGB RGBA and a cut constructor that consumes only a binary mask. Return the typed pair and migrate every transport and dry-run caller.
- [x] Build the canonical padded sRGB RGB8 preview once. Encode the JPEG from it, decode the final bytes to sRGB RGB8, compute the versioned integer QC metrics, and reject threshold failures before returning artifacts.
- [x] Remove the arbitrary PNG from the trusted send path. Keep the SVG cut overlay display-only.
- [x] Run printer tests and all TypeScript workspace checks.
- [x] Commit with `feat: separate print and cut generation QC`.

### Task 3: Immutable completed-attempt and ribbon-registration records

**Files:**
- Modify: `packages/printer/src/transport-attempt.ts`
- Create: `packages/printer/src/physical-qc.ts`
- Modify: `packages/printer/src/index.ts`
- Test: `packages/printer/test/transport-attempt.test.ts`
- Create: `packages/printer/test/physical-qc.test.ts`

**Interfaces:**
- Consumes: exact `TransportAttemptRecord` identity and stored transport evidence.
- Produces: `recordCompletedAttempt`, `recordRibbonRegistrationQc`, `getPhysicalAttemptEvidence`, and derived CMY status without a transport mutation method. The safe checkpoint includes a derived `fullyUploaded` flag.

- [x] Write failing tests for completed-frame preconditions, restart recovery, identical retry, conflicting retry, stale identity, invalid channel values, derived CMY result, two journal handles, and permanent reservation failure.
- [x] Run the focused tests and confirm the append-only operations do not exist.
- [x] Add the two tables with additive initialization. Parse database rows strictly at the boundary.
- [x] Implement transactional idempotent inserts bound to the exact attempt and expose read-only evidence. Never update or delete the transport row.
- [x] Run the printer journal tests and all TypeScript workspace checks.
- [x] Commit with `feat: record immutable physical print QC`.

### Task 4: Restore locked evidence in the operator UI and document the boundary

**Files:**
- Modify: `src/physical-proof-runtime.mjs`
- Modify: `src/browser-physical-coordinator.mjs`
- Modify: `src/server.mjs`
- Modify: `public/index.html`
- Create: `src/physical-evidence.mjs` for per-request QC journal access and mutation guards
- Modify: `test/server.test.mjs`
- Modify: `test/browser-physical-coordinator.test.mjs`
- Create: `docs/evidence/physical-attempt-2026-11-28.json`
- Modify: `docs/runbooks/physical-adapter-proof.md`
- Modify: `docs/superpowers/specs/2026-11-27-trusted-artifacts-cloud-ops-design.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3 journal read and record operations.
- Produces: local read and append-only QC HTTP endpoints plus an operator view with no resend control.

- [x] Write failing server and browser tests for refresh, restart, duplicate requests, direct and browser send rejection, locked copy, no resend control, physical QC validation, and zero transport or WebUSB calls.
- [x] Run the focused server tests and confirm the new cases fail.
- [x] Add journal evidence GET and append-only outcome and CMY POST routes. Return conflict for stale or different evidence and never route these operations through the printer queue.
- [x] Restore the locked outcome on page load. Show the passed checks, failed printer ribbon registration, CMY form, evidence, and notes. State that the defect is printer-internal and is not an image-generation failure.
- [x] Update the trusted-artifact spec, physical runbook, README, and historical source evidence. State that the real journal identity is unavailable in the repository and remains an operator reconciliation blocker.
- [x] Run the focused server and UI tests.
- [x] Run `npm test`, `npm run typecheck`, `npm run emulators:test`, and `git diff --check`.
- [x] Commit with `feat: add generation and physical QC gates`.
