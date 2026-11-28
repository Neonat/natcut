# NatCut isolated cloud preview runbook

## Resource boundary

All commands in this runbook target Google Cloud project `sprout-dev-66f08` (`485412794128`). NatCut owns only these resources:

- Firebase Hosting site and target: `natcut` (`https://natcut.web.app`)
- Firebase web app display name: `natcut`
- Firestore Standard database: `natcut` in `asia-southeast1`, with deletion protection
- Cloud Run service: `natcut-submission` in `asia-southeast1`
- Artifact Registry repository: `natcut` in `asia-southeast1`
- Service accounts: `natcut-submission` and `natcut-worker`
- Secret Manager secret: `natcut-status-token`

Never run bare `firebase deploy`, `firebase deploy --only hosting`, or any Firestore deploy from this repository. The only Firebase deployment command is:

```bash
npm run deploy:hosting
```

The wrapper rejects additional arguments, uses only `firebase.json`, and invokes the explicit `sprout-dev-66f08` / `hosting:natcut` target. The emulator rules live in `firebase.emulators.json` and are absent from the production deployment configuration.

## Session 2 rollout gates and baseline

The authorized cloud-only rollout began on 2026-11-27 with commit `eff86507c81d431c1a5cc53be5f93aa7a04b5b89` as its source baseline. Before the first cloud mutation, all local tests, all eight workspace typechecks, 56 submission emulator tests, and 95 worker emulator tests passed. The live named database had no `queued`, `next`, or `printing` ticket, `workerSlots/devfest-sg` was absent, and no local cloud simulator process was running.

The immutable rollback baseline is:

- Hosting release `sites/natcut/releases/1795455783898000`;
- Hosting version `sites/natcut/versions/c83dfb31f52e5c3e`;
- Hosting Cloud Run tag `fh-c83dfb31f52e5c3e`;
- Cloud Run revision `natcut-submission-00003-4w8`;
- Cloud Run image digest `sha256:54dd8ab17d87d8a4921d7c4ecda868460607c46dfe65cca16f0d1815ff32b60d`.

Stop before any mutation if the project, region, database, bucket, service, service account, Hosting site, or web-app identity differs from this runbook. Also stop if a runnable ticket, worker slot or simulator appears; either required index is not `READY`; the default Sprout site stops returning HTTP 404; the NatCut bucket already exists with unexpected settings; public bucket access is possible; or the proposed runtime IAM includes object deletion or bucket administration.

The preflight isolation audit confirmed the existing Sprout web apps and databases were unchanged, both NatCut indexes were `READY`, and `https://sprout-dev-66f08.web.app/` still returned HTTP 404.

## Verify a saved index inventory offline

Use an operator-supplied composite-index listing from project `sprout-dev-66f08`, database `natcut`. Keep the full resource name, query scope, ordered fields, and state of every index. Given a saved listing in JSON array format, wrap it locally with the project and database that produced it.

```bash
jq '{projectId:"sprout-dev-66f08", databaseId:"natcut", indexes:.}' named-index-list.json > inventory.json
npm run verify:indexes -- --inventory inventory.json
```

The checker reads the local inventory and `firestore.indexes.json`. It checks the project and database in each resource name and exits successfully only when the inventory reports both required `submissions` indexes as `READY`. `MISSING` identifies an absent definition. `BUILDING` means construction was underway at capture time. For a non-ready result, obtain a fresh listing after the operator has addressed the reported state.

The result describes the saved inventory at capture time. Collecting a fresh live listing requires separate authorization for the named project and database. Provisioning or repairing an index requires a separately authorized cloud change.

## Preserved Sprout baseline

Before NatCut provisioning, the project contained:

- default Hosting site `sprout-dev-66f08`, returning HTTP 404
- web apps `pwa-test`, `dev-ai-pipeline`, and `sprout-web-app`
- Firestore `(default)` in `asia-southeast1`
- Firestore `ai-studio-9ff5e055-cff5-488a-b647-e4d4dadf4987` in `us-west1`

Provisioning NatCut did not deploy to or delete any of those resources. Re-run the isolation audit after every production change:

```bash
firebase hosting:sites:list --project sprout-dev-66f08
firebase hosting:sites:get natcut --project sprout-dev-66f08
firebase apps:list WEB --project sprout-dev-66f08
firebase firestore:databases:list --project sprout-dev-66f08
curl -sS -o /dev/null -w '%{http_code}\n' https://sprout-dev-66f08.web.app/
```

The NatCut site result must include app ID `1:485412794128:web:ef3ea0d8607992e27b7f95`. The last command should remain `404` until the owner intentionally deploys Sprout there.

## Build and deploy the API

**Stop all old workers before deploying the artifact-bearing API.** An older worker can consume a version 2 submission without verifying its artifact. Keep production queue consumption stopped until a verification-capable worker has passed its rollout checks.

The new revision requires `NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts`. This is the only permitted bucket name. Session 2 created that exact Standard regional bucket in `ASIA-SOUTHEAST1` with uniform bucket-level access, public-access prevention enforced, and the platform's seven-day soft-delete policy. No public principal is bound.

Runtime bucket IAM is deliberately split:

- `natcut-submission@sprout-dev-66f08.iam.gserviceaccount.com`: `roles/storage.objectCreator` and `roles/storage.objectViewer`;
- `natcut-worker@sprout-dev-66f08.iam.gserviceaccount.com`: `roles/storage.objectViewer` only.

Neither runtime identity has an object-delete or bucket-administration role. The project owner retains administrative recovery access through the standard project-owner binding; never use it to replace or delete an accepted artifact. Soft delete is incident recovery, not an application lifecycle. A failed publication returns HTTP 503 and the visitor can retry with the same idempotency key.

For operator verification, `nathanielsim100@gmail.com` has `roles/iam.serviceAccountTokenCreator` on each of those two service accounts individually, not at project scope. This permits the checked-in smoke and local worker to prove the runtime identities without creating service-account keys.

The authorized create-only smoke published and retained this evidence:

- object `smoke/v1/736584dd4e942403f7543b12cb5610b4e150c1e4b0404c787730f9f94a6ec6e9`;
- generation `1795794073135257`;
- size `131` bytes;
- SHA-256 `736584dd4e942403f7543b12cb5610b4e150c1e4b0404c787730f9f94a6ec6e9`.

The submission identity created the object with `ifGenerationMatch=0`; a duplicate create returned precondition failure. Both submission and worker identities read that exact generation and reproduced the recorded bytes. The smoke has no update or delete path, and the object remains immutable evidence.

Authenticate the deployment CLI with the project owner account. Do not create or download a service-account key.

```bash
gcloud auth login
gcloud config set project sprout-dev-66f08
```

Build the image with the checked-in Dockerfile and its container-import smoke gate:

```bash
gcloud builds submit . \
  --project=sprout-dev-66f08 \
  --region=asia-southeast1 \
  --config=cloudbuild.submission.yaml \
  --substitutions=_IMAGE=asia-southeast1-docker.pkg.dev/sprout-dev-66f08/natcut/natcut-submission:session2-eff8650
```

Session 2 build `7d1a7de2-dd06-4135-9d29-1b43bc022e93` passed the import gate for source commit `eff8650`. Tag `session2-eff8650` resolved to immutable image digest `sha256:8ee819866f4cff9c59c70b7c676cd07b26f37e775368e94554216f0105a5266b`. Cloud Run revision `natcut-submission-00004-vrh` was deployed by that digest and became healthy with the exact NatCut project, named database, artifact bucket, secret, service account, scaling, concurrency, CPU, memory, and timeout settings shown below.

The deployment did not cut Hosting over: the public `natcut` release remained `sites/natcut/releases/1795455783898000`, pinned to tag `fh-c83dfb31f52e5c3e`, until the explicit Hosting step.

Deploy with scale-to-zero and a maximum of three instances:

```bash
gcloud run deploy natcut-submission \
  --project=sprout-dev-66f08 \
  --region=asia-southeast1 \
  --image=asia-southeast1-docker.pkg.dev/sprout-dev-66f08/natcut/natcut-submission@sha256:8ee819866f4cff9c59c70b7c676cd07b26f37e775368e94554216f0105a5266b \
  --service-account=natcut-submission@sprout-dev-66f08.iam.gserviceaccount.com \
  --set-env-vars=NATCUT_PROJECT_ID=sprout-dev-66f08,NATCUT_DATABASE_ID=natcut,NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts \
  --set-secrets=NATCUT_STATUS_TOKEN_SECRET=natcut-status-token:latest \
  --min=0 --max=3 --concurrency=10 --cpu=1 --memory=1Gi --timeout=60s \
  --allow-unauthenticated
```

The service is public at the network layer because Firebase Hosting must reach it. Submission creation still requires a Firebase anonymous-auth bearer token, while status access requires the opaque per-submission status token.

The visitor now navigates to `/queue/:submissionId` without putting that bearer in the address bar. The submitting tab keeps the token in session storage. An older `#token=...` link is imported into that tab and immediately scrubbed with `history.replaceState`; the fragment is never sent in the page request. A cleaned URL copied into another browser or reopened after the tab's session storage is lost cannot recover the ticket by itself. A portable, secret-free recovery flow needs a separate authenticated or HttpOnly-cookie design. Treat any previously copied fragment link as a bearer credential because it can read status and request queue departure.

## Build and deploy Hosting

Fetch the public SDK configuration for the NatCut web app, then inject only those public values at build time:

```bash
firebase apps:sdkconfig WEB 1:485412794128:web:ef3ea0d8607992e27b7f95 \
  --project sprout-dev-66f08

VITE_NATCUT_FIREBASE_PROJECT_ID=sprout-dev-66f08 \
VITE_NATCUT_FIREBASE_API_KEY='public Firebase web API key' \
VITE_NATCUT_FIREBASE_AUTH_DOMAIN=sprout-dev-66f08.firebaseapp.com \
VITE_NATCUT_FIREBASE_APP_ID=1:485412794128:web:ef3ea0d8607992e27b7f95 \
npm run build:hosting

npm run deploy:hosting
```

Before deployment, confirm the bundle contains no emulator endpoints:

```bash
rg 'demo-natcut|127\.0\.0\.1:(8088|9099)|NATCUT_STATUS_TOKEN_SECRET' apps/visitor/dist
```

No matches is the expected result.

Session 2 deployed only the `natcut` target after a clean production-bundle scan. Candidate release `sites/natcut/releases/1795794269237000`, version `sites/natcut/versions/8833c20787e4010a`, pins Cloud Run tag `fh-8833c20787e4010a` to revision `natcut-submission-00004-vrh`. After cutover, `/api/health` returned `{"ok":true}`, `/edit` returned HTTP 200, and the default Sprout site remained HTTP 404.

## Configure the V2 Mac simulator for an authorized rollout

Session 2 completed the authorized bucket/IAM and named-index verification, isolated deployment, pinned-generation smoke, simulator smoke, and rollback proof. Keep autonomous production consumption stopped until the later booth rehearsal explicitly starts it. The dedicated worker service account has `storage.objects.get` on the isolated artifact bucket. The booth Mac uses local ADC impersonation.

```bash
gcloud auth application-default login \
  --impersonate-service-account=natcut-worker@sprout-dev-66f08.iam.gserviceaccount.com

NATCUT_PROJECT_ID=sprout-dev-66f08 \
NATCUT_DATABASE_ID=natcut \
NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts \
NATCUT_SQLITE_PATH="$PWD/.local/natcut-worker-smoke.sqlite" \
NATCUT_WORKER_ID=session2-smoke \
NATCUT_SMOKE_SUBMISSION_ID='<accepted smoke ticket ID>' \
npm run worker:cloud:smoke
```

The smoke entry point runs `SimulatedPrinter` only. Its claim and recovery transactions compare the queue head or existing slot with `NATCUT_SMOKE_SUBMISSION_ID`; a different visitor ticket stops the smoke without claiming it. It exits after that exact ticket is acknowledged or enters a failure/reconciliation outcome, and it has a two-minute deadline. Retain `.local/natcut-worker-smoke.sqlite` across retries.

The offline transport-attempt module has a mock-tested declaration and acknowledgement port and its own SQLite journal. It has no concrete printer transport and the cloud worker has no integration with it. The simulator's `ready` proof applies to the simulation. The [physical adapter proof runbook](physical-adapter-proof.md) records the evidence still needed for printer completion and operator resolution.

Do not set `GOOGLE_CLOUD_QUOTA_PROJECT` for this impersonated worker ADC. The credential already targets `natcut-worker`; adding a quota-project header makes the storage SDK require `serviceusage.services.use`, which this deliberately narrow runtime identity does not have. Session 2 reproduced that configuration error as repeated `waiting_for_cloud`, stopped the simulator before execution, removed only the extra environment variable, and then proved the same pinned SDK read. No broader IAM role was granted.

Restart with the same worker ID and the same durable SQLite journal. Completion carries the submission, event, worker, durable execution token, manifest, validation, and exact artifact receipt/profile. The transaction advances only the matching current `printing` execution, stores those facts as `completionFence`, and releases the slot atomically.

If that transaction committed before its response was lost, the worker reports `waiting_for_cloud` and retries the same evidence. It clears the local intent and records its durable local acknowledgement only when Firestore returns `committed` or `confirmed` for an identical `ready` or `collected` completion whose slot is absent or validly belongs to a different ticket. A stale worker or token, changed receipt generation/profile, mismatched validation, malformed timestamp or slot, missing legacy journal evidence, local ready with cloud `next`, or any other fenced outcome remains `needs_reconciliation`; do not delete the journal, edit Firestore, or start the following ticket.

Restart boundaries are deliberate: a crash before begin may resume from a verified `next` claim; a crash after begin but before the local phase commit, during any simulated physical phase, or before a provable completion remains held. A transport failure before completion commit retries the same outbox intent. A lost response after commit confirms the stored fence and never re-executes simulation. Unresolved local journals, holds, and legacy intents block later tickets even if the cloud slot is missing, and they remain visible as on-hold rows on the operator desk.

Session 2 accepted immutable smoke ticket `mYalSc9Yy1wNCu3Kxkcb`, queue number 6, with object `logical/v1/f2ee3c511f5ec584709d478b2859ae6914a37004b379b75a221edaf4ccc09913`, generation `1795794508630789`, profile `devfest-sg-v1` version 1. Before execution, the harness decoded the full V2 record and the worker identity read and verified all 12,600,000 logical bytes at that exact generation.

The submission smoke verifies the supplied public API key against the exact NatCut Firebase web-app configuration before anonymous signup. It stores only non-secret attempt identity in `.local/natcut-cloud-submission-smoke.json` before posting. If a response is lost, a rerun uses the owner/event/idempotency binding to recover read-only; it never stores the bearer token and refuses to create a second ticket while the prior outcome is ambiguous. Keep that file with the rollout evidence.

Simulator `session2-smoke` completed only that ticket. Firestore ended at `ready` with no worker slot; its completion fence matches the submission ID, event, worker, durable execution token, manifest hash, validation, receipt, and completion timestamp. The retained SQLite journal is `ready` with the same token and acknowledgement timestamp, an empty completion outbox, no artifact hold, and no reconciliation state. The simulator was then stopped.

## Smoke checks

```bash
curl -fsS https://natcut.web.app/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://natcut.web.app/edit
```

Expected results are `{"ok":true}` and `200`. For the artifact-bearing API, use an authorized test submission to verify the stored generation and ticket receipt while queue consumption is stopped.

## Cost guardrail

The named Firestore database is billable because the project's one free database is already `(default)`. Cloud Run has zero minimum instances and a maximum of three. AI generation is not deployed here and cannot use AI Studio credits.

Before event rehearsal, create a Cloud Billing budget for project `sprout-dev-66f08` in **Google Cloud Console → Billing → Budgets & alerts**. Choose an amount the owner is comfortable approving, enable alerts at 50%, 90%, and 100%, and send them to the billing administrators. Budget alerts do not cap spending; monitor the Billing reports during rehearsal.

## Recovery and rollback

- Stop queue consumption: press `Ctrl-C` in the Mac worker terminal. This does not alter queued records.
- Inspect Cloud Run revisions: `gcloud run revisions list --service=natcut-submission --region=asia-southeast1 --project=sprout-dev-66f08`.
- Roll the public API back from **Firebase Console → Hosting → natcut → Release history** because Hosting pins the Cloud Run revision. Do not touch the `sprout-dev-66f08` site. Verify `/api/health` through `https://natcut.web.app` after rollback.
- Do not rotate `natcut-status-token` while any idempotency binding or public status link remains valid. The current schema does not store a per-submission key version; safe rotation requires a versioned-token migration or expiry and removal of all earlier bindings.
- Never delete the `natcut` database during incident response. It has deletion protection; export or inspect data first.

### Session 2 rollback proof

With the simulator stopped, no runnable ticket, and no worker slot, the Hosting release API repointed only site `natcut` to baseline version `sites/natcut/versions/c83dfb31f52e5c3e`. It created rollback release `sites/natcut/releases/1795794760922000`, which pinned tag `fh-c83dfb31f52e5c3e`. NatCut `/api/health` and `/edit` passed and the default Sprout site remained HTTP 404.

The same target-locked API then restored candidate version `sites/natcut/versions/8833c20787e4010a`. It created release `sites/natcut/releases/1795794788692000`, pinning tag `fh-8833c20787e4010a` to candidate revision `natcut-submission-00004-vrh`. After restoration, health and `/edit` passed, Sprout remained HTTP 404, and smoke ticket `mYalSc9Yy1wNCu3Kxkcb` remained `ready` with artifact and completion-fence generation `1795794508630789`.

The Firebase Hosting API creates a new `ROLLBACK` release when an earlier finalized version is selected; it does not modify or delete the earlier deploy or accepted Firestore/artifact evidence. The exact API contract is documented by Firebase's `sites.releases.create` reference.

Real printer execution remains a separate, explicitly approved milestone.
