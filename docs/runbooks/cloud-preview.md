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
  --set-env-vars=NATCUT_PROJECT_ID=sprout-dev-66f08,NATCUT_DATABASE_ID=natcut \
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

## Run the Mac simulator

The booth Mac impersonates the dedicated worker service account. This creates a local ADC file under the user's gcloud configuration, never in Git:

```bash
gcloud auth application-default login \
  --impersonate-service-account=natcut-worker@sprout-dev-66f08.iam.gserviceaccount.com

NATCUT_PROJECT_ID=sprout-dev-66f08 \
NATCUT_DATABASE_ID=natcut \
NATCUT_SQLITE_PATH="$PWD/.local/natcut-worker.sqlite" \
NATCUT_WORKER_ID=devfest-macbook \
npm run worker:cloud:sim
```

The simulator imports no USB bridge and cannot start a physical printer job. Stop it with `Ctrl-C`. Keep `.local/natcut-worker.sqlite` between restarts; deleting it while a submission is in `next` or `printing` forces operator reconciliation.

## Smoke checks

```bash
curl -fsS https://natcut.web.app/api/health
curl -sS -o /dev/null -w '%{http_code}\n' https://natcut.web.app/edit
```

Expected results are `{"ok":true}` and `200`. Then submit through the visitor UI, start the Mac simulator, and refresh the queue page until it reaches **Ready for pickup**.

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
