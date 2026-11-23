# NatCut Booth Platform Design

**Status:** Approved; implementation deferred by the owner

**Date:** 2026-11-23

## Goal

Build a mobile-first sticker-booth system for one event operator, one MacBook, and one Liene PixCut S1. Visitors create and approve a sprite sticker on their phones, submit an immutable design to a cloud queue, follow its status, and collect the physical sticker. A separate private route may add a photographed person for selected visitors when the booth has spare capacity. The Mac owns physical execution and feeds the printer one job at a time.

The visitor interface must use **sprite**, never “Plantemon.”

## Experience

1. A visitor scans the main public QR code and opens the web app without installing anything.
2. They choose an approved local sprite or request a live-generated sprite from a plant search.
3. A live-generated sprite is shown behind an “Is this cute enough?” approval gate. Rejection returns the visitor to the approved library.
4. They choose a composition theme, sprite variation, and branding placement.
5. They preview the final sticker and choose a cut-border preset or custom border slider.
6. Cut contours and overlap warnings update dynamically.
7. They submit once. The accepted composition becomes immutable.
8. They see queue status and refresh it with a button or native pull-to-refresh.
9. When ready, they collect the sticker and may complete a one-question rating plus optional selfie.

The editing choices are intentionally constrained:

- Theme: hugging, battling, side-by-side, or the default composition.
- Branding: Sprout logo; logo plus other sprites; or logo plus plant species name.
- Cut border: Tight, Standard, Wide, or Custom.

## System boundaries

```text
Visitor phone
  React web app
  local preview + cut geometry worker
          |
          v
Submission API on Cloud Run
  authentication, normalization, validation, idempotency
          |
          v
Firebase
  Firestore queue and public status
  Cloud Storage assets and optional selfies
          |
          | outbound polling/claiming
          v
Mac worker
  local SQLite physical queue
  deterministic renderer
  cut geometry validator
  PixCut protocol driver
          |
          v
Liene PixCut S1 over USB
```

The phone never talks to the printer. The printer protocol package never accepts visitor data directly. The Mac worker is the sole physical-job claimant and the sole publisher of physical progress.

## Technology choices

- Visitor and operator apps: React and TypeScript.
- Web hosting: Firebase Hosting.
- Session identity: Firebase Anonymous Authentication.
- Cloud records: Cloud Firestore Standard edition.
- Image assets and selfies: Cloud Storage for Firebase.
- Trusted submission and validation boundary: Cloud Run.
- Local worker: Node.js and TypeScript.
- Local durable state: SQLite.
- Shared deterministic rendering and geometry: framework-independent TypeScript packages.
- Development: Firebase Emulator Suite and a simulated printer.

Production requires the Firebase Blaze plan because Cloud Storage requires billing. Firestore and Hosting should remain within their no-cost allowances at booth scale if the app avoids realtime listeners and large repeated downloads. AI providers receive explicit per-session and per-event quotas because billing alerts are not spending caps.

## Repository shape

```text
apps/
  visitor/       mobile visitor workflow
  operator/      queue, warnings, reconciliation, pickup
  worker/        cloud claimant, SQLite queue, printer executor
  submission/    trusted cloud API
packages/
  domain/        schemas, state transitions, validation results
  render/        deterministic composition renderer
  cut-geometry/  masks, distance fields, contours, collision checks
  printer/       PixCut framing, USB transport, job execution
  pipeline/      later: sprite and trainer generation adapters
```

The existing read-only bridge becomes the foundation of `packages/printer` and the operator/worker health boundary. Printer mutation remains absent until a separately approved loaded-media test.

## Visitor session

Anonymous Authentication supplies a stable, opaque UID for a browser session. The app also creates an opaque session record used to enforce one survey per session. No email is required to create a sticker or receive it.

Anonymous sessions are device-local. The status link therefore contains an unguessable public status token so a visitor can reopen their job without exposing operator data or requiring an account.

## Private portrait route

Adding the visitor to the artwork is not advertised in the public flow. The operator keeps a separate portrait QR code and shows it only to selected friends or during quiet periods.

The portrait QR opens an unlisted route containing a rotatable event invite token. Scanning it creates a capture request and displays a short matching code on the visitor’s phone and operator screen. The operator must activate the request before a photo can be attached, so possession of an old QR image does not create printable work or consume AI budget.

```text
Private portrait QR
  -> capture request and matching code
  -> operator activates one request
  -> visitor stands at the fixed Sony α6000 and tripod
  -> operator captures through Sony Imaging Edge Desktop
  -> operator imports the saved JPEG into the active request
  -> trainer generation and visitor approval
  -> normal composition editor
  -> normal immutable print submission
```

The α6000 connects to the Mac over USB in PC Remote mode. The first implementation uses Sony Imaging Edge Desktop to trigger the shutter and save the JPEG, followed by a simple operator import. Direct camera control is deferred because the α6000 is not supported by Sony’s current Camera Remote SDK. A watched-folder importer may later remove the manual import step without changing the visitor flow.

Portrait capture and generation happen before print submission. They never reserve a print-queue position. If capture or generation fails, the visitor can continue with the standard sprite-only composition. The operator should normally offer this route only when the regular queue is empty or short.

## Composition manifest

The phone edits a declarative manifest rather than a flattened image:

```ts
type CompositionManifest = {
  schemaVersion: number;
  spriteAssetId: string;
  trainerAssetId: string | null;
  theme: "default" | "hugging" | "battling" | "side-by-side";
  brandingVariant: "logo" | "logo-and-sprites" | "logo-and-species";
  cutGroups: CutGroup[];
  cutMarginMm: number;
  renderVersion: string;
};
```

The final submission stores the manifest and its canonical hash. The trusted renderer reconstructs the raster from the manifest; the phone cannot upload an arbitrary printable JPEG as the authoritative artifact.

## Print profile

Operator-controlled settings live in a versioned event print profile. Visitors cannot change them.

```ts
type PrintProfile = {
  id: string;
  version: number;
  mediaSize: 5013;
  mediaType: 2030;
  sheetWidthPx: 1200;
  sheetHeightPx: 2100;
  rasterWidthPx: 1216;
  rasterHeightPx: 2128;
  printQuality: number;
  copies: 1;
  knifePressure: number;
  cutHoles: false;
  alphaThreshold: number;
  jpegMaxBytes: 1048576;
};
```

The submission API stamps the active profile ID and version onto the immutable submission. Knife pressure is encoded into the generated PLT and remains operator-only. A profile change creates a new version rather than silently changing accepted jobs.

## Cut-border editing and validation

The visitor sees presets plus a custom slider:

- Tight: 1.0 mm.
- Standard: 1.5 mm.
- Wide: 2.0 mm.
- Custom: initially constrained to 0.5–3.0 mm in 0.1 mm steps.

The range is configurable after physical testing. The UI calls this **cut border**, while the domain field is `cutMarginMm`. It is an outward dilation of the opaque artwork, not a corner radius.

Visual layers intended to become one sticker belong to the same cut group and may overlap deliberately. Expanded contours from different cut groups are checked for intersection and minimum clearance.

The shared geometry package:

1. Renders each cut group to a 1200 × 2100 alpha mask at 300 DPI.
2. Applies the print profile’s alpha threshold.
3. Converts millimetres to pixels with `mm * 300 / 25.4`.
4. Expands each mask using an elliptical/Euclidean dilation.
5. Measures inter-group clearance, edge clearance, self-intersection, contour count, point count, and total cut length.
6. Traces the expanded masks into final contours.

For responsive slider movement, the phone precomputes a distance field for each cut group. Slider movement thresholds those fields for an immediate preview. A Web Worker runs the exact contour trace after a short debounce and immediately on slider release. Revision numbers prevent stale worker results from replacing a newer preview.

Overlap, insufficient spacing, and likely quality problems are warnings rather than submission blockers. The UI highlights the affected contours, explains the risk, offers **Adjust border** and **Print anyway**, and records acknowledgement. Only structurally unprintable output is blocked: empty artwork, corrupt or untraceable geometry, artwork outside the printable sheet, excessive complexity beyond a safe hard limit, or inability to produce the required artifacts.

The submission service repeats the exact validation. The Mac verifies the same geometry version and raster hash before creating a physical job.

```ts
type GeometryReport = {
  valid: boolean;
  severity: "ok" | "warning" | "error";
  issues: GeometryIssue[];
  contourCount: number;
  pointCount: number;
  cutLengthMm: number;
  minimumContourGapMm: number | null;
  edgeClearanceMm: number;
  geometryVersion: string;
  rasterHash: string;
  acknowledgedByVisitor: boolean;
  acknowledgedAt: string | null;
};
```

## Cloud submission

The phone calls the submission API with its authenticated session, idempotency key, composition manifest, and any warning acknowledgement. The API normalizes the manifest, attaches the active print profile, rerenders, validates, stores required artifacts, and creates the Firestore record transactionally.

```ts
type Submission = {
  id: string;
  ownerUid: string;
  eventId: string;
  idempotencyKey: string;
  manifest: CompositionManifest;
  manifestHash: string;
  printSpec: {
    profileId: string;
    profileVersion: number;
    cutMarginMm: number;
  };
  validation: GeometryReport;
  publicStatus: PublicStatus;
  publicStatusTokenHash: string;
  queueNumber: number;
  jobsAhead: number;
  acceptedAt: string;
  cancelledAt: string | null;
  requeuedFrom: string | null;
  updatedAt: string;
};
```

The API, not the browser, writes server-owned fields. An idempotency key prevents double taps and network retries from creating duplicate queue entries.

## Queue semantics

Public states are deliberately simple:

```text
Joining queue
  -> In queue · N ahead
  -> You're next
  -> Printing
  -> Ready for pickup
  -> Collected
```

The internal queue contains finer states such as claimed, rendering, validating, declaring, uploading cut, uploading image, printing, laminating, cutting, ejecting, ready, failed, and needs reconciliation.

Rules:

- An accepted submission is immutable.
- A visitor may leave while joining or in queue.
- Leaving cancels that submission; rejoining creates a new submission at the back and records `requeuedFrom`.
- At **You’re next**, the Leave queue button remains visible but is greyed out and disabled.
- The Mac claims the oldest eligible submission atomically.
- `submissionId` is unique in SQLite, preventing duplicate local jobs.
- Only one physical job may be active.
- Public status is refreshed explicitly by button or native pull-to-refresh; no always-on Firestore listener is required.

## Local physical job

The local record is the recovery journal for a printer operation:

```ts
type LocalPrintJob = {
  id: string;
  submissionId: string;
  queueNumber: number;
  manifestHash: string;
  rasterHash: string;
  printProfileSnapshotJson: string;
  geometryReportJson: string;
  jpegPath: string;
  jpegSha256: string;
  jpegBytes: number;
  pltPath: string;
  pltSha256: string;
  pltBytes: number;
  state: LocalJobState;
  printerJobId: number | null;
  uploadPhase: "none" | "cut" | "image" | "complete";
  lastPrinterState: number | null;
  lastPrinterSubState: number | null;
  lastAlertsJson: string;
  acceptedAt: string;
  stateChangedAt: string;
  lastError: string | null;
};
```

The execution sequence follows the behavior established by BrenCut:

1. Generate the 1200 × 2100 composition and pad it to a 1216 × 2128 white raster.
2. Encode a JPEG no larger than 1 MiB.
3. Generate a PLT containing the contours and `KP{knifePressure}`.
4. Preflight printer state and blocking alerts.
5. Declare a combined print-and-cut job using the known media, formats, quality, and copy count.
6. Persist the returned printer job ID immediately.
7. Upload PLT first, then JPEG.
8. Use acknowledgement-paced data chunks and retain the conservative 120 ms baseline pacing.
9. Poll job and printer state through printing, laminating, feeding, cutting, and ejecting.
10. Mark ready only after confirmed completion.

If the worker crashes after declaration, the job enters `needs_reconciliation`. On restart it queries printer job state and active job IDs. It never blindly resubmits an uncertain job. The operator chooses the outcome when printer state cannot prove whether a sheet was consumed.

## Marketing and survey records

Sticker fulfillment is independent of marketing opt-in. Email is collected only when the visitor chooses product updates. Opting out creates no marketing lead and does not affect their sticker.

```ts
type MarketingLead = {
  email: string;
  eventId: string;
  onboardedAt: string;
  optionalSubmissionId: string | null;
};
```

One survey is allowed per visitor session. The Firestore document path uses the session ID as its technical uniqueness key; the session ID is not duplicated as a survey field.

```ts
type SurveySubmission = {
  email: string | null;
  eventId: string;
  stickerSubmissionId: string;
  cuteRating: 1 | 2 | 3 | 4 | 5;
  selfieStoragePath: string | null;
  submittedAt: string;
};
```

When the visitor opted into marketing, the normalized email is copied into the survey and the marketing lead’s `optionalSubmissionId` references that survey document. Otherwise the survey email is null, while the rating and optional selfie are still stored. Any future right to publish selfies must be a separate explicit choice from uploading one.

## Operator app

The operator sees:

- Printer connection, identity, alerts, and active job.
- Ordered cloud queue and local job state.
- Visitor-acknowledged geometry warnings.
- Artifact previews and hashes.
- Retry-safe actions appropriate to the current state.
- A reconciliation screen for uncertain jobs.
- Mark collected and operator cancellation actions.

The operator app must never offer firmware, factory, calibration, arbitrary property mutation, or undocumented commands.

## Failure handling

- Phone retry: submission idempotency returns the existing submission.
- Visitor refresh: status is recovered from the opaque status token.
- Mac offline: cloud submissions remain queued.
- Firestore interruption: the worker retains its SQLite job and resumes cloud synchronization later.
- USB disconnected before declaration: return job to a safe waiting state.
- USB disconnected after declaration: reconcile against the printer; do not duplicate.
- Printer alert: surface the actionable alert and hold the local job.
- Invalid trusted render: quarantine the submission for operator review.
- Optional survey/selfie failure: never affect print pickup.

## Security and privacy

- Firestore clients cannot directly claim jobs or write physical status.
- Sensitive writes go through authenticated APIs or narrowly scoped security rules.
- Status tokens are high-entropy and stored hashed.
- Selfie uploads have type and size limits and are compressed.
- Marketing and survey collections are not publicly readable.
- App Check and rate limiting are enabled before public launch.
- Retention periods for raw captures, generated trainer assets, and selfies are configured before the event.
- Secrets remain in server-side secret management, never in the visitor bundle.

## Delivery sequence

### Milestone 1: queue-first vertical slice

- Monorepo structure and shared domain package.
- Mobile submission and immutable preview manifest.
- Firebase Emulator submission queue.
- Anonymous session and opaque status link.
- Deterministic fixture renderer.
- Cut-border presets, custom slider, live contour preview, and warnings.
- Mac worker claim into SQLite.
- Simulated physical-job phases through ready.
- Refresh and pull-to-refresh status.
- End-to-end test from submission to ready.

### Milestone 2: operator workflow and recovery

- Operator queue and warning review.
- Local failure injection and reconciliation.
- Pickup and collected state.
- Survey, optional selfie, and marketing opt-in.

### Milestone 3: controlled printer proof

- Offline artifact generation and review.
- One separately approved loaded-sheet print-and-cut.
- Registration, knife pressure, pacing, and timing measurements.
- Conservative profile calibration and recovery documentation.

### Milestone 4: generation pipeline

- Approved sprite library.
- Existing Sprout backend adapter tests.
- Live sprite generation with cuteness approval and library fallback.
- Golden-set quality evaluation and provider cost controls.

### Milestone 5: private portrait add-on

- Separate private QR route and rotatable invite token.
- Operator-approved capture requests and matching codes.
- Sony α6000 setup through Imaging Edge Desktop.
- Manual JPEG import into the active capture request.
- Trainer generation, approval, and controlled portrait layouts.
- Sprite-only fallback without losing the visitor session.

### Milestone 6: production readiness

- Firebase deployment, App Check, rate limits, budgets, and observability.
- Load and queue soak tests.
- Event runbook, backup assets, and manual recovery process.

## Explicitly deferred from the first vertical slice

- Live AI generation.
- Real printer writes.
- Push notifications.
- Multi-printer scheduling.
- Transfer-speed optimization.
- Unbounded freeform layout editing.
- Importing the existing Sprout frontend.
- Private portrait route and camera integration.

## Upstream attribution

NatCut is inspired by [BrenCut](https://github.com/LTKMN/brencut) and its PixCut S1 protocol, raster preparation, cut tracing, and job sequencing work. BrenCut is MIT licensed. Reused code must retain its license and attribution. Protocol behavior is also informed by PixCut-App and the honeymaro/pixcut contour implementation as documented in the repository notices.

## Acceptance criteria for this design

- A visitor can complete the workflow without an account or email.
- The public workflow never requires or advertises portrait capture.
- A private portrait session cannot enter the print queue before its final design is approved.
- Preview geometry changes dynamically with the cut-border control.
- Quality risks warn and can be acknowledged; structurally invalid output cannot print.
- Accepted designs cannot be edited.
- Leaving and rejoining cannot reorder an existing immutable job.
- One Mac safely serializes all physical work.
- A crash cannot silently create a duplicate physical print.
- Marketing opt-out never prevents sticker fulfillment or survey storage.
- The initial build can be verified end-to-end without printer media or paid AI calls.
