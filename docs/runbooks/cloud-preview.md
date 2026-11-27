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

The new revision requires `NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts`. This is the only permitted bucket name. Bucket provisioning and ownership, production storage IAM and readiness remain unverified. Before deployment, an authorized operator must verify private access, create and read permissions for the submission service account on this bucket, and a successful create-only upload and exact-generation readback. The publisher needs `storage.objects.create` and `storage.objects.get`. A failed publication returns HTTP 503 and the visitor can retry with the same key.

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
  --substitutions=_IMAGE=asia-southeast1-docker.pkg.dev/sprout-dev-66f08/natcut/natcut-submission:cloud-preview
```

Deploy with scale-to-zero and a maximum of three instances:

```bash
gcloud run deploy natcut-submission \
  --project=sprout-dev-66f08 \
  --region=asia-southeast1 \
  --image=asia-southeast1-docker.pkg.dev/sprout-dev-66f08/natcut/natcut-submission:cloud-preview \
  --service-account=natcut-submission@sprout-dev-66f08.iam.gserviceaccount.com \
  --set-env-vars=NATCUT_PROJECT_ID=sprout-dev-66f08,NATCUT_DATABASE_ID=natcut,NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts \
  --set-secrets=NATCUT_STATUS_TOKEN_SECRET=natcut-status-token:latest \
  --min=0 --max=3 --concurrency=10 --cpu=1 --memory=1Gi --timeout=60s \
  --allow-unauthenticated
```

The service is public at the network layer because Firebase Hosting must reach it. Submission creation still requires a Firebase anonymous-auth bearer token, while status access requires the opaque per-submission status token.

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

## Configure the V2 Mac simulator for an authorized rollout

Keep production consumption stopped until Session 2 completes the authorized bucket/IAM and named-index verification, isolated deployment, pinned-generation smoke, simulator smoke, and rollback proof. The dedicated worker service account needs `storage.objects.get` on the isolated artifact bucket. The booth Mac uses local ADC impersonation.

```bash
gcloud auth application-default login \
  --impersonate-service-account=natcut-worker@sprout-dev-66f08.iam.gserviceaccount.com

NATCUT_PROJECT_ID=sprout-dev-66f08 \
NATCUT_DATABASE_ID=natcut \
NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts \
NATCUT_SQLITE_PATH="$PWD/.local/natcut-worker.sqlite" \
NATCUT_WORKER_ID=devfest-macbook \
npm run worker:cloud:sim
```

The worker runs the simulator only. It verifies new and recovered V2 claims against the exact pinned object and persists verified bytes in the journal. Storage authentication, network and deadline failures leave the same claim waiting. Legacy claims, unknown versions and missing or corrupt evidence hold the queue head for reconciliation. Stop with `Ctrl-C` and retain `.local/natcut-worker.sqlite` across restarts.

Restart with the same worker ID and the same durable SQLite journal. Completion carries the submission, event, worker, durable execution token, manifest, validation, and exact artifact receipt/profile. The transaction advances only the matching current `printing` execution, stores those facts as `completionFence`, and releases the slot atomically.

If that transaction committed before its response was lost, the worker reports `waiting_for_cloud` and retries the same evidence. It clears the local intent and records its durable local acknowledgement only when Firestore returns `committed` or `confirmed` for an identical `ready` or `collected` completion whose slot is absent or validly belongs to a different ticket. A stale worker or token, changed receipt generation/profile, mismatched validation, malformed timestamp or slot, missing legacy journal evidence, local ready with cloud `next`, or any other fenced outcome remains `needs_reconciliation`; do not delete the journal, edit Firestore, or start the following ticket.

Restart boundaries are deliberate: a crash before begin may resume from a verified `next` claim; a crash after begin but before the local phase commit, during any simulated physical phase, or before a provable completion remains held. A transport failure before completion commit retries the same outbox intent. A lost response after commit confirms the stored fence and never re-executes simulation. Unresolved local journals, holds, and legacy intents block later tickets even if the cloud slot is missing, and they remain visible as on-hold rows on the operator desk.

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

Real printer execution remains a separate, explicitly approved milestone.
