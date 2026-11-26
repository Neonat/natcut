# Isolated Cloud Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a working NatCut visitor preview through a new Firebase Hosting site, Cloud Run API, and named Firestore database without modifying historical Sprout resources.

**Architecture:** Build the existing Vite frontend for a same-origin `/api` path, package the trusted Fastify server for Node 24 Cloud Run, and parameterize Admin Firestore access by database ID. Provision every NatCut resource under an explicit new name and deploy Hosting by target, never by the project's default site.

**Tech Stack:** Node.js 24, Vite, Fastify, Firebase Hosting/Auth/Admin, Cloud Run, Firestore Standard, Secret Manager, gcloud CLI

**Spec:** `docs/superpowers/specs/2026-11-24-cloud-preview-design.md`

## Global Constraints

- Google Cloud project is exactly `sprout-dev-66f08` (`485412794128`).
- Region and Firestore location are exactly `asia-southeast1`.
- New resource names are `natcut`, `natcut-submission`, and NatCut-specific service accounts/secrets.
- Do not deploy, edit, or delete the existing default Hosting site, Firestore databases, rules, indexes, functions, Storage, or Firebase apps.
- Cloud Run minimum instances is `0`; maximum instances is bounded.
- Browser clients never write queue records directly.
- Real printer mutation remains absent.

## Review Focus

- A deploy command without an explicit Hosting target must be impossible from the documented workflow.
- Production code must select Firestore database `natcut`, never `(default)`.
- Emulator tests must continue selecting the emulator's default database and project `demo-natcut`.
- Hosting navigation routes must return the SPA while `/api/**` reaches Cloud Run.
- Secrets and credential files must not enter Git, build output, or browser environment variables.

---

### Task 1: Production configuration boundaries

**Files:**
- Modify: `apps/submission/src/repository.ts`
- Modify: `apps/worker/src/cloud-queue.ts`
- Create: `apps/submission/test/database-selection.test.ts`
- Modify: `scripts/dev-runtime.ts`

**Interfaces:**
- Produces: database-aware factories that consume an already-selected `Firestore` instance; production entrypoints select `getFirestore(app, 'natcut')`, emulator entrypoints retain `getFirestore(app)`.

- [ ] Write failing tests proving production and emulator database selection cannot be interchanged.
- [ ] Run focused tests and verify failure.
- [ ] Implement the smallest explicit database-selection configuration.
- [ ] Run submission and worker tests and verify success.
- [ ] Commit as `feat: isolate NatCut Firestore database`.

### Task 2: Cloud Run submission service

**Files:**
- Create: `apps/submission/src/cloud-run.ts`
- Create: `Dockerfile.submission`
- Create: `.dockerignore`
- Modify: `apps/submission/package.json`
- Modify: `apps/submission/test/routes.test.ts`

**Interfaces:**
- Consumes: `NATCUT_PROJECT_ID`, `NATCUT_DATABASE_ID`, `NATCUT_STATUS_TOKEN_SECRET`, `PORT`.
- Produces: an HTTP service listening on `0.0.0.0:$PORT`, health endpoint, and existing `/v1/submissions` routes.

- [ ] Write failing configuration and health tests.
- [ ] Verify tests fail before the entrypoint exists.
- [ ] Implement Admin initialization, named Firestore selection, trusted asset loading, and Fastify listener.
- [ ] Add a Node 24 multi-stage container build containing only runtime assets and required workspaces.
- [ ] Run tests and build the container locally if Docker is available.
- [ ] Commit as `feat: package submission API for Cloud Run`.

### Task 3: Production visitor build and Hosting target

**Files:**
- Modify: `apps/visitor/src/main.tsx`
- Modify: `firebase.json`
- Create: `.firebaserc`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the new Firebase web app SDK configuration and same-origin `/api` base URL.
- Produces: `npm run build:hosting` and an explicit Hosting target named `natcut`; `/api/**` rewrites to `natcut-submission` in `asia-southeast1`, all other unknown paths rewrite to `index.html`.

- [ ] Write a visitor configuration test for production versus emulator behavior.
- [ ] Implement build-time Firebase variables without embedding secrets.
- [ ] Configure the explicit multi-site Hosting target and SPA/API rewrite order.
- [ ] Run the production build and inspect output for emulator URLs or secrets.
- [ ] Commit as `feat: configure isolated NatCut Hosting site`.

### Task 4: Cloud-connected Mac simulator

**Files:**
- Create: `scripts/cloud-worker.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `apps/worker/test/cloud-worker-config.test.ts`

**Interfaces:**
- Consumes: ADC, `NATCUT_PROJECT_ID=sprout-dev-66f08`, `NATCUT_DATABASE_ID=natcut`, durable SQLite path, worker ID.
- Produces: `npm run worker:cloud:sim`, an outbound polling loop using the existing fail-closed worker and simulator.

- [ ] Write failing configuration tests rejecting the emulator project, missing database ID, and in-memory SQLite.
- [ ] Implement explicit production configuration and bounded polling.
- [ ] Verify no USB or printer modules are imported.
- [ ] Run worker unit tests.
- [ ] Commit as `feat: add cloud queue simulator for Mac`.

### Task 5: Provision and deploy isolated cloud resources

**Files:**
- Create: `docs/runbooks/cloud-preview.md`
- Modify: `.gitignore`

**Interfaces:**
- Uses: Firebase CLI login and gcloud ADC/deployer login.
- Produces: Hosting site `natcut`, Firebase web app `natcut`, Firestore database `natcut`, Cloud Run service `natcut-submission`, dedicated identities/secret, and a tested public URL.

- [ ] Install and authenticate gcloud without storing credentials in the repository.
- [ ] Record existing project resources and verify the default Hosting URL remains untouched.
- [ ] Attempt to create Hosting site `natcut`; stop if unavailable.
- [ ] Create the NatCut web app and bind the Hosting target.
- [ ] Create the named Firestore database and dedicated service accounts/secret.
- [ ] Enable only required Google APIs and deploy Cloud Run with min `0` and bounded max instances.
- [ ] Build and deploy only Hosting target `natcut`; do not deploy Firestore or Functions.
- [ ] Enable or verify anonymous Auth.
- [ ] Smoke-test anonymous sign-in, submission, queue status, Mac simulator, and ready state.
- [ ] Verify existing Hosting site still returns its pre-deployment response and list all existing databases/apps unchanged.
- [ ] Add budget-alert instructions and recovery commands to the runbook.
- [ ] Run final unit, type, build, audit, and mutation-command verification.
- [ ] Commit as `docs: add isolated cloud preview runbook`.
