# Queue-First Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile visitor flow that previews a fixture sprite with a live cut border, submits one immutable job to a local Firebase queue, lets a Mac worker claim it into SQLite, and advances it through simulated printing to pickup-ready status.

**Architecture:** Convert the repository into npm workspaces while preserving the existing read-only printer bridge. A React visitor app calls a trusted TypeScript submission service backed by Firebase emulators; shared domain, render, and cut-geometry packages keep manifests and validation consistent. A separate Node worker atomically claims cloud submissions, journals them in SQLite, and uses a simulated printer adapter only—no USB mutation is added in this milestone.

**Tech Stack:** Node.js 22+, npm workspaces, TypeScript, React, Vite, Vitest, Playwright, Fastify, Firebase Auth/Firestore emulators, Firebase Admin SDK, Zod, Sharp, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-11-23-booth-platform-design.md`

## Global Constraints

- Preserve the existing read-only CLI, localhost bridge, and all 28 legacy tests.
- Do not add or invoke printer job creation, data upload, cancellation, calibration, firmware, factory, or arbitrary `set-prop` commands.
- Use **sprite**, never “Plantemon,” in visitor-facing copy.
- The public workflow requires no email and does not expose the private portrait route.
- Accepted submissions are immutable; leaving and rejoining creates a new submission later, not an edit.
- The visitor may leave only during `joining` or `queued`; at `next`, Leave queue is visible and disabled.
- Cut overlap and insufficient spacing are acknowledgement-required warnings, not blockers.
- Empty, out-of-bounds, untraceable, corrupt, or hard-complexity-limit geometry is blocked.
- Knife pressure is operator-only and comes from print profile `devfest-sg-v1`; the visitor controls only `cutMarginMm`.
- Use Firebase demo project ID `demo-natcut`; tests and local development must not contact production Firebase.
- Store no selfie, survey, marketing lead, camera capture, or AI generation data in this milestone.

## Review Focus

- Two simultaneous requests with the same owner UID and idempotency key must return one submission and one queue number; Task 5 pins this with an emulator integration test.
- Two worker processes racing to claim the oldest job must produce one Firestore claim and one SQLite row; Task 7 pins this with a claim-race test.
- A slow geometry worker response must never overwrite a newer slider value; Task 6 pins this with revision-order tests.
- A warning acknowledgement must cover the exact `manifestHash` and geometry issues being submitted; Task 5 rejects stale acknowledgements in an API test.
- Restarting after a local simulated job enters an uncertain phase must mark it `needs_reconciliation`, not start a second execution; Task 7 pins this with a restart test.

---

## File Structure

```text
apps/
  submission/
    src/auth.ts              verify Firebase ID tokens
    src/repository.ts        Firestore transactions and status tokens
    src/routes.ts            HTTP request/response boundary
    src/server.ts            Fastify composition root
    test/                    route and emulator integration tests
  visitor/
    src/api.ts               typed submission/status client
    src/editor/              fixture editor and live cut controls
    src/queue/               immutable status and leave behavior
    src/workers/             cut-preview Web Worker
    test/                    React component and hook tests
  worker/
    src/cloud-queue.ts       atomic claim/status repository
    src/job-store.ts         SQLite journal
    src/simulated-printer.ts deterministic fake physical phases
    src/worker.ts            claim and execution coordinator
    test/                    claim, restart, and state tests
packages/
  domain/src/               schemas, hashes, state transitions
  render/src/               deterministic layout and mask rendering
  cut-geometry/src/         distance fields, warnings, contours
vendor/pixcut-trace/         pinned MIT contour implementation
fixtures/assets/             approved local development sprite assets
e2e/                         Playwright full-flow tests
firebase.json                emulator ports and rules configuration
firestore.rules              deny direct visitor queue mutation
firestore.indexes.json       worker queue index
```

### Task 1: Workspace and TypeScript test foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `apps/submission/package.json`
- Create: `apps/visitor/package.json`
- Create: `apps/worker/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/render/package.json`
- Create: `packages/cut-geometry/package.json`
- Create: one `tsconfig.json` in every new workspace
- Test: `test/workspace-smoke.test.mjs`

**Interfaces:**
- Consumes: current root Node ESM project and `npm test` contract
- Produces: workspace commands `npm run test:legacy`, `npm run test:unit`, `npm run typecheck`, `npm test`, and package imports `@natcut/domain`, `@natcut/render`, `@natcut/cut-geometry`

- [ ] **Step 1: Write the failing workspace smoke test**

Assert that each workspace package exists, is private, declares ESM, exposes `src/index.ts`, and that the root `test` script includes both legacy Node tests and Vitest.

- [ ] **Step 2: Run the smoke test and verify failure**

Run: `node --test test/workspace-smoke.test.mjs`

Expected: FAIL because the workspace manifests do not exist.

- [ ] **Step 3: Add npm workspaces and shared tooling**

Keep the existing `start` and `status` commands. Add TypeScript strict mode, Vitest workspace discovery, and dependencies required by later tasks. Create empty typed entry points only where the smoke test requires them; do not move the printer bridge yet.

- [ ] **Step 4: Verify the foundation**

Run: `npm install && npm run test:legacy && npm run test:unit && npm run typecheck`

Expected: 28 legacy tests pass, workspace smoke passes, and all empty workspaces typecheck.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.workspace.ts apps packages test/workspace-smoke.test.mjs
git commit -m "chore: add typed workspace foundation"
```

### Task 2: Shared domain model and queue state machine

**Files:**
- Create: `packages/domain/src/manifest.ts`
- Create: `packages/domain/src/print-profile.ts`
- Create: `packages/domain/src/geometry.ts`
- Create: `packages/domain/src/submission.ts`
- Create: `packages/domain/src/state-machine.ts`
- Create: `packages/domain/src/canonical-hash.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/domain.test.ts`

**Interfaces:**
- Consumes: Zod and Web Crypto-compatible SHA-256 input
- Produces: `CompositionManifestSchema`, `PrintProfileSchema`, `GeometryReportSchema`, `SubmissionSchema`, `DEVFEST_SG_V1`, `GEOMETRY_LIMITS`, `canonicalManifestJson(manifest): string`, `manifestHash(manifest): Promise<string>`, `canTransitionPublicStatus(from, to): boolean`, and `canVisitorLeave(status): boolean`

- [ ] **Step 1: Write failing schema and transition tests**

Test exact manifest values, nullable `trainerAssetId`, `cutMarginMm` range `0.5..3.0`, profile raster `1216x2128`, logical sheet `1200x2100`, JPEG maximum `1048576`, media size `5013`, media type `2030`, quality `4`, copies `1`, knife pressure `42`, alpha threshold `128`, `cutHoles: false`, public states, legal transitions, and Leave queue enabled only for `joining` and `queued`.

- [ ] **Step 2: Write failing canonical-hash tests**

Assert that key-order differences hash identically, array-order differences do not, unknown fields are rejected, and `-0`, `NaN`, and infinite numbers cannot enter a valid manifest.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `npm run test:unit -- --project domain`

Expected: FAIL because the domain modules are absent.

- [ ] **Step 4: Implement the domain package**

Define the public states as `joining | queued | next | printing | ready | collected | cancelled`. Set `GEOMETRY_LIMITS` to safety gap `1.5 mm`, preferred edge clearance `3.0 mm`, maximum `64` contours, and maximum `50,000` contour points. Keep detailed physical phases out of `PublicStatus`. Canonicalize only schema-parsed values before hashing.

- [ ] **Step 5: Verify domain behavior**

Run: `npm run test:unit -- --project domain && npm run typecheck`

Expected: all domain tests pass with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat: define submission and queue domain"
```

### Task 3: Deterministic fixture layout and cut-group masks

**Files:**
- Create: `fixtures/assets/sprite-fixture.png`
- Create: `packages/render/src/assets.ts`
- Create: `packages/render/src/layout.ts`
- Create: `packages/render/src/masks.ts`
- Create: `packages/render/src/server-raster.ts`
- Modify: `packages/render/src/index.ts`
- Test: `packages/render/test/render.test.ts`
- Test: `packages/render/test/fixtures/expected-layout.json`

**Interfaces:**
- Consumes: validated `CompositionManifest`, `PrintProfile`, and decoded RGBA assets
- Produces: `planComposition(manifest, profile): PlannedComposition`, `renderCutGroupMasks(plan, assets): CutGroupMask[]`, and `renderServerRaster(plan, assets): Promise<RenderedRaster>` where `RenderedRaster` includes width, height, RGBA bytes, and SHA-256

- [ ] **Step 1: Write failing layout tests**

Assert fixed layer positions for the default fixture, deterministic ordering, rejection of missing assets, and that the plan never exceeds `1200x2100`.

- [ ] **Step 2: Write failing mask and raster tests**

Assert one mask per declared cut group, identical raster hashes across repeated renders, transparent pixels outside artwork, and a hard error when any planned layer crosses the printable boundary.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `npm run test:unit -- --project render`

Expected: FAIL because renderer modules are absent.

- [ ] **Step 4: Implement shared layout and mask rendering**

Keep layout arithmetic and alpha-mask compositing pure TypeScript. Use Sharp only in the server raster adapter for color asset decoding/composition. Do not introduce fonts or platform-dependent text rendering in this milestone.

- [ ] **Step 5: Verify deterministic output**

Run: `npm run test:unit -- --project render && npm run typecheck`

Expected: layout, boundary, mask, and stable-hash tests pass.

- [ ] **Step 6: Commit**

```bash
git add fixtures/assets packages/render
git commit -m "feat: add deterministic fixture renderer"
```

### Task 4: Live cut geometry and overlap warnings

**Files:**
- Create: `vendor/pixcut-trace/` from BrenCut commit `b153c614f441dbc663e2fafeb66ef1f731191872`
- Modify: `THIRD_PARTY_NOTICES.md`
- Create: `packages/cut-geometry/src/distance-field.ts`
- Create: `packages/cut-geometry/src/dilate.ts`
- Create: `packages/cut-geometry/src/collisions.ts`
- Create: `packages/cut-geometry/src/contours.ts`
- Create: `packages/cut-geometry/src/evaluate.ts`
- Modify: `packages/cut-geometry/src/index.ts`
- Test: `packages/cut-geometry/test/geometry.test.ts`

**Interfaces:**
- Consumes: `CutGroupMask[]`, `cutMarginMm`, and `PrintProfile`
- Produces: `buildDistanceField(mask): DistanceField`, `previewExpandedMask(field, marginMm, dpi): BinaryMask`, and `evaluateCutGeometry(groups, marginMm, profile): GeometryEvaluation` containing contours plus the domain `GeometryReport`

- [ ] **Step 1: Vendor the pinned contour source and attribution**

Copy only the MIT-licensed tracer files required for alpha contour extraction, preserve its license and `SOURCE.md`, and record BrenCut plus the pinned commit in `THIRD_PARTY_NOTICES.md`.

- [ ] **Step 2: Write failing distance and dilation tests**

Use tiny synthetic masks to assert `marginPx = marginMm * 300 / 25.4`, elliptical expansion, stable zero-margin output, and monotonic expansion as the slider increases.

- [ ] **Step 3: Write failing validation tests**

Cover separate groups that remain at least `1.5 mm` apart, groups whose expanded masks overlap, clearance below `1.5 mm`, edge clearance below `3.0 mm`, empty mask error, out-of-bounds error, more than `64` contours, and more than `50,000` points. Assert overlap, low clearance, and preferred-edge violations have severity `warning`, while empty, out-of-bounds, and complexity violations have severity `error`.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `npm run test:unit -- --project cut-geometry`

Expected: FAIL because NatCut geometry modules are absent.

- [ ] **Step 5: Implement distance fields, collision measurement, and contour extraction**

Compute per-group fields once, threshold them for each margin, and measure inter-group minimum clearance before combining contours. Use the pinned tracer only for contour extraction; NatCut owns warning classification and clearance calculation.

- [ ] **Step 6: Verify geometry**

Run: `npm run test:unit -- --project cut-geometry && npm run typecheck && git diff --check`

Expected: all geometry tests pass and third-party attribution is present.

- [ ] **Step 7: Commit**

```bash
git add vendor/pixcut-trace THIRD_PARTY_NOTICES.md packages/cut-geometry
git commit -m "feat: add cut geometry validation"
```

### Task 5: Trusted submission API and Firebase emulator queue

**Files:**
- Create: `firebase.json`
- Create: `firestore.rules`
- Create: `firestore.indexes.json`
- Create: `apps/submission/src/auth.ts`
- Create: `apps/submission/src/repository.ts`
- Create: `apps/submission/src/validation.ts`
- Create: `apps/submission/src/routes.ts`
- Create: `apps/submission/src/server.ts`
- Test: `apps/submission/test/routes.test.ts`
- Test: `apps/submission/test/emulator.test.ts`

**Interfaces:**
- Consumes: Firebase bearer token, manifest, idempotency key, optional exact warning acknowledgement, renderer, and geometry evaluator
- Produces: `POST /v1/submissions`, `GET /v1/submissions/:id/status` using header `X-NatCut-Status-Token`, `POST /v1/submissions/:id/leave`, `createSubmissionRepository(firestore)`, and `buildSubmissionServer(deps)`

- [ ] **Step 1: Write failing route tests with injected fakes**

Cover missing/invalid authentication, malformed manifest, structurally invalid geometry, unacknowledged warnings, stale acknowledgement hash, successful creation, opaque status-token lookup through the header, wrong token, jobs-ahead calculation, leave while queued, leave while next, a valid `requeuedFrom` cancelled submission, rejection of another visitor’s `requeuedFrom`, and mutation attempts against accepted manifest fields.

- [ ] **Step 2: Write failing emulator integration tests**

Using project `demo-natcut`, assert anonymous auth works, direct visitor writes to queue records are denied, two concurrent identical idempotency requests create one record and queue number, and a second distinct request receives the next queue number.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `npm run emulators:test -- --only submission`

Expected: FAIL because the API and emulator configuration are absent.

- [ ] **Step 4: Implement authenticated submission creation**

Parse with shared schemas, rerender and re-evaluate on the server, stamp `DEVFEST_SG_V1`, generate a 256-bit status token, store only its SHA-256, validate an optional `requeuedFrom` against the same owner and a cancelled state, and use one Firestore transaction for idempotency, queue sequencing, and record creation.

- [ ] **Step 5: Implement status and leave routes**

Return only public status fields, including the count of non-cancelled unfinished queue numbers ahead. Leaving changes `joining|queued` to `cancelled`; it returns `409` for `next` or later and never deletes the immutable record.

- [ ] **Step 6: Verify API and rules**

Run: `npm run emulators:test -- --only submission && npm run typecheck`

Expected: route and emulator tests pass without contacting production Firebase.

- [ ] **Step 7: Commit**

```bash
git add firebase.json firestore.rules firestore.indexes.json apps/submission
git commit -m "feat: add trusted submission queue"
```

### Task 6: Mobile visitor editor and immutable queue screen

**Files:**
- Create: `apps/visitor/index.html`
- Create: `apps/visitor/src/main.tsx`
- Create: `apps/visitor/src/app.tsx`
- Create: `apps/visitor/src/api.ts`
- Create: `apps/visitor/src/editor/editor-page.tsx`
- Create: `apps/visitor/src/editor/cut-border-control.tsx`
- Create: `apps/visitor/src/editor/cut-preview.tsx`
- Create: `apps/visitor/src/editor/use-cut-preview.ts`
- Create: `apps/visitor/src/workers/cut-preview.worker.ts`
- Create: `apps/visitor/src/queue/queue-page.tsx`
- Create: `apps/visitor/src/queue/use-pull-to-refresh.ts`
- Create: `apps/visitor/src/styles.css`
- Test: `apps/visitor/test/editor.test.tsx`
- Test: `apps/visitor/test/queue.test.tsx`
- Test: `apps/visitor/test/cut-preview-order.test.ts`

**Interfaces:**
- Consumes: shared fixture manifest, geometry worker, Firebase anonymous auth, and submission API
- Produces: public routes `/`, `/edit`, `/queue/:submissionId`; presets Tight `1.0`, Standard `1.5`, Wide `2.0`; custom slider `0.5..3.0` step `0.1`; explicit refresh; pull-to-refresh; and warning acknowledgement UI

- [ ] **Step 1: Write failing editor component tests**

Assert visitor copy uses “sprite,” presets set exact millimetres, Custom reveals the slider, preview requests change while dragging, overlap displays a warning without disabling `Print anyway`, and submission sends the exact acknowledged manifest hash.

- [ ] **Step 2: Write the failing worker-order test**

Deliver revision `2` before revision `1` and assert only revision `2` updates the preview. Assert slider release requests an immediate exact evaluation while movement uses the debounced path.

- [ ] **Step 3: Write failing queue screen tests**

Assert explicit Refresh reloads status; pull-down invokes the same function once; queued shows an enabled Leave queue button; next shows `You're next` with the button visible and disabled; cancelled offers `Rejoin queue`; rejoining creates a new submission with `requeuedFrom`; printing/ready copy contains no internal printer jargon; and no editor control is rendered after submission.

- [ ] **Step 4: Run focused tests and verify failure**

Run: `npm run test:unit -- --project visitor`

Expected: FAIL because the visitor app is absent.

- [ ] **Step 5: Implement the editor and cut-preview worker**

Render the fixture artwork, reuse precomputed distance fields, show approximate contours during slider movement, and replace them with the exact worker result after debounce or release. Keep a monotonically increasing revision counter at the worker boundary.

- [ ] **Step 6: Implement submission and queue status**

Put the returned status token in the URL fragment as `/queue/:submissionId#token=...` so it is not sent in HTTP requests or referrer headers, and mirror it to session storage. Send it to the status API only through `X-NatCut-Status-Token`. After success, discard editable draft state. Rejoin starts a fresh fixture draft carrying only `requeuedFrom`; it does not clone or unlock the accepted manifest. Do not use a Firestore realtime listener.

- [ ] **Step 7: Verify visitor behavior**

Run: `npm run test:unit -- --project visitor && npm run typecheck && npm run build --workspace @natcut/visitor`

Expected: component tests pass and Vite produces a production bundle.

- [ ] **Step 8: Commit**

```bash
git add apps/visitor
git commit -m "feat: add mobile submission experience"
```

### Task 7: SQLite Mac worker and simulated physical execution

**Files:**
- Create: `apps/worker/src/cloud-queue.ts`
- Create: `apps/worker/src/job-store.ts`
- Create: `apps/worker/src/simulated-printer.ts`
- Create: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/main.ts`
- Test: `apps/worker/test/job-store.test.ts`
- Test: `apps/worker/test/claim-race.test.ts`
- Test: `apps/worker/test/worker.test.ts`
- Test: `apps/worker/test/restart.test.ts`

**Interfaces:**
- Consumes: Firestore queued submissions, shared state rules, SQLite path, and injected `PhysicalExecutor`
- Produces: `claimNextSubmission(workerId): Promise<ClaimedSubmission | null>`, `JobStore`, `SimulatedPrinter`, `runWorkerOnce(deps): Promise<WorkerResult>`, and local states `claimed | rendering | validating | ready_to_declare | declaring | uploading_cut | uploading_image | printing | cutting | ready | failed | needs_reconciliation`

- [ ] **Step 1: Write failing SQLite journal tests**

Assert schema creation is idempotent, `submissionId` is unique, every transition updates `stateChangedAt`, artifacts/profile/geometry JSON are retained, and reopening the database preserves jobs.

- [ ] **Step 2: Write the failing Firestore claim-race test**

Start two claimers against one queued record and assert exactly one returns the submission, the cloud record has one worker lease, and inserting both results cannot create two SQLite rows.

- [ ] **Step 3: Write failing simulated execution tests**

With an injected fake clock, assert the exact phase order and public mappings: claimed/rendering/validating remain `next`; uploading and physical processing map to `printing`; completed execution maps to `ready`.

- [ ] **Step 4: Write the failing restart test**

Persist a job in `declaring`, `uploading_cut`, `uploading_image`, `printing`, or `cutting`, reopen the store, and assert startup changes it to `needs_reconciliation` without calling the executor. Safe pre-declaration states may resume.

- [ ] **Step 5: Run focused tests and verify failure**

Run: `npm run emulators:test -- --only worker`

Expected: FAIL because worker modules are absent.

- [ ] **Step 6: Implement cloud claim and local journal**

Claim the oldest eligible record in a Firestore transaction with a lease owner and timestamp. Insert into SQLite before starting simulated work. Use dependency injection for time, Firestore, and executor.

- [ ] **Step 7: Implement simulated phase progression and restart classification**

The simulator emits deterministic phases and never imports `src/protocol.mjs` or opens USB. Cloud status updates are monotonic and failures retain the local journal.

- [ ] **Step 8: Verify worker behavior**

Run: `npm run emulators:test -- --only worker && npm run typecheck`

Expected: claim race, lifecycle, persistence, and restart tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/worker
git commit -m "feat: add durable simulated print worker"
```

### Task 8: End-to-end queue proof and developer runbook

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/queue-flow.spec.ts`
- Create: `e2e/leave-and-requeue.spec.ts`
- Create: `scripts/dev.mjs`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Firebase emulators, submission API, Vite visitor app, and simulated worker
- Produces: `npm run dev`, `npm run test:e2e`, and one documented local path from browser submission to pickup-ready status

- [ ] **Step 1: Write the failing primary Playwright test**

Open the visitor app, sign in anonymously, adjust Custom border, observe the contour update, acknowledge an overlap warning, submit once, verify editing disappears, run the worker, press Refresh, and observe `You're next`, `Printing`, then `Ready for pickup`.

- [ ] **Step 2: Write the failing leave/requeue Playwright test**

Submit two sessions, leave the first while queued, assert it becomes cancelled, use `Rejoin queue` to create a new immutable submission, and assert the new queue number is behind the second session. Move the second to `next` and assert its Leave queue button is disabled.

- [ ] **Step 3: Run E2E and verify failure**

Run: `npm run test:e2e`

Expected: FAIL because orchestration and Playwright configuration are absent.

- [ ] **Step 4: Implement local orchestration**

Start Auth and Firestore emulators, submission API, visitor Vite server, and worker simulator with explicit ports and cleanup handlers. Reject startup unless every process uses project `demo-natcut`.

- [ ] **Step 5: Document the vertical slice**

Update the README with prerequisites, install, emulator startup, test commands, browser URL, simulated-worker behavior, data reset, and an explicit statement that no printer mutation exists.

- [ ] **Step 6: Run complete verification**

Run: `npm test && npm run typecheck && npm run test:e2e && git diff --check`

Expected: all legacy, unit, emulator, and Playwright tests pass; the E2E run reaches ready without a printer.

- [ ] **Step 7: Verify mutation commands remain absent**

Run: `rg -n "combo-job|print-job|cut-job|cancel-job|set-prop|cmd data" src bin public apps packages`

Expected: no executable printer-mutation implementation; documentation/test assertions may mention forbidden strings only as safety checks.

- [ ] **Step 8: Commit**

```bash
git add playwright.config.ts e2e scripts README.md package.json package-lock.json
git commit -m "test: prove queue-first vertical slice"
```

## Self-Review Notes

- The plan intentionally implements only Milestone 1 from the approved platform design. Operator workflow, survey/marketing, real printer writes, AI generation, and the private Sony α6000 route each remain separate follow-up plans.
- Every visitor-controlled field is parsed in the shared domain and revalidated by the submission service.
- Rendering, geometry, API, UI, and worker tasks have stable interfaces in dependency order.
- The highest-risk concurrency, stale-result, acknowledgement, and restart behaviors are each pinned by a named test.
- The physical printer boundary remains read-only throughout this plan.
