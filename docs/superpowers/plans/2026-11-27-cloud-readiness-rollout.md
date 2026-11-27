# Isolated Cloud Readiness and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and roll out the trusted-artifact submission path in NatCut's isolated cloud resources, prove exact-generation storage and simulator behavior, and prove rollback without USB or printer access.

**Architecture:** Keep the existing Hosting pin as the public cutover boundary. Provision one private regional artifact bucket with create/read-only runtime identities, build the submission image under a commit-derived tag, deploy it by immutable digest, and only then repin the isolated `natcut` Hosting site. A dedicated accepted smoke ticket remains immutable evidence; the simulated worker consumes it only after the deployed receipt and exact object generation have been inspected.

**Tech Stack:** Google Cloud Storage, Cloud IAM, Cloud Build, Artifact Registry, Cloud Run, Firebase Hosting, named Firestore database `natcut`, Node.js/TypeScript simulator.

**Spec:** `docs/superpowers/specs/2026-11-27-trusted-artifacts-cloud-ops-design.md`

## Global Constraints

- Target only project `sprout-dev-66f08` and NatCut resources named in `docs/runbooks/cloud-preview.md`.
- Preserve the default Sprout Hosting site, existing Sprout web apps, and non-NatCut databases.
- Keep queue consumption stopped until storage, deployed receipt, and worker-read checks pass.
- Never import or invoke USB or printer code; the only executor allowed in this session is `SimulatedPrinter`.
- Never edit or delete an accepted submission or its artifact.
- Build and deploy by immutable image digest; do not deploy a mutable `latest` image.
- Stop on any unexpected resource identity, active worker slot, runnable pre-existing ticket, public bucket access, mismatched generation, corrupt artifact, or reconciliation hold.
- Do not claim production readiness; physical output and event rehearsal remain later sessions.

## Observed read-only baseline (2026-11-27, Asia/Singapore)

- Firestore database `natcut` is Standard, `asia-southeast1`, and deletion-protected.
- Both required `submissions` composite indexes report `READY`.
- Cloud Run `natcut-submission` is healthy on revision `natcut-submission-00003-4w8` and does not yet define `NATCUT_ARTIFACT_BUCKET`.
- Firebase Hosting site `natcut` is bound to app `1:485412794128:web:ef3ea0d8607992e27b7f95`; the default Sprout site still returns HTTP 404.
- Artifact Registry repository `natcut`, service accounts `natcut-submission` and `natcut-worker`, and secret `natcut-status-token` exist.
- Bucket `sprout-dev-66f08-natcut-artifacts` does not exist.
- The named database contains five historical tickets: four `ready`, one `cancelled`, none `queued`, `next`, or `printing`; `workerSlots/devfest-sg` is absent.
- No local `worker:cloud:sim` process is running.

## Review Focus

- A command aimed at the wrong project, database, region, bucket, service, or Hosting site must stop before mutation.
- Bucket policy must enforce public-access prevention and uniform bucket-level access; runtime identities must not receive delete or bucket-admin permissions.
- A duplicate upload to an existing object name must fail and an exact-generation read must return the original bytes.
- Hosting cutover must pin the new Cloud Run revision without changing the default Sprout site.
- A lost or fenced completion response must leave the simulator journal and queue visibly blocked rather than synthesizing success.

---

### Task 1: Freeze the rollout baseline and gates

**Files:**
- Modify: `docs/runbooks/cloud-preview.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: current Git commit, live read-only resource inventories, current Hosting release and Cloud Run revision.
- Produces: recorded baseline identities and a preflight checklist that blocks unsafe rollout.

- [ ] Run the full local unit, typecheck, submission emulator, worker emulator, and diff checks before any cloud mutation.
- [ ] Save fresh named-index inventory and pass it through `npm run verify:indexes`.
- [ ] Record current Cloud Run revision/image digest and current `natcut` Hosting release as rollback targets.
- [ ] Verify zero `queued`, `next`, and `printing` submissions, no worker slot, and no local simulator process.
- [ ] Re-run the Sprout isolation audit and require the default Hosting site to return HTTP 404.
- [ ] Document all stop conditions and the immutable rollback targets.

### Task 2: Provision the private artifact boundary

**Files:**
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: absent exact bucket name and existing NatCut service-account identities.
- Produces: private bucket `sprout-dev-66f08-natcut-artifacts` in `asia-southeast1` with submission create/get and worker get permissions only.

- [ ] Recheck that the exact bucket is absent, then create it in project `sprout-dev-66f08`, region `asia-southeast1`, with uniform bucket-level access and public-access prevention enforced.
- [ ] Grant `roles/storage.objectCreator` and `roles/storage.objectViewer` to `natcut-submission`; grant only `roles/storage.objectViewer` to `natcut-worker`.
- [ ] Read back the bucket and IAM policy; fail if any public principal appears or either runtime identity can delete/administer objects.
- [ ] Update the runbook with the exact policy and recovery boundary.

### Task 3: Prove create-only and pinned-generation storage

**Files:**
- Create: `scripts/cloud-storage-smoke.mjs`
- Create: `test/cloud-storage-smoke.test.mjs`
- Modify: `package.json`
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: explicit project/bucket/service-account identities and injected token/fetch adapters in tests.
- Produces: `npm run smoke:storage` that writes one unique `smoke/v1/<sha256>` object with generation precondition zero, verifies the returned decimal generation, rejects duplicate creation, reads that exact generation as submission and worker identities, and never deletes the object.

- [ ] Write failing argument, wrong-resource, duplicate-create, generation-mismatch, byte-mismatch, and identity-read tests.
- [ ] Run the targeted test and observe the expected failures.
- [ ] Implement the smallest smoke command with hard-coded NatCut resource boundaries and no delete/update path.
- [ ] Run the targeted test, full unit suite, and typecheck.
- [ ] Run the authorized live smoke and record the object name, generation, digest, and both read identities.

### Task 4: Build and stage the submission API by digest

**Files:**
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: verified source commit, checked-in Dockerfile/Cloud Build import gate, verified artifact bucket.
- Produces: a commit-derived Artifact Registry image and a healthy Cloud Run revision configured for the isolated database and bucket, not yet publicly repinned by Hosting.

- [ ] Submit the build with a commit-derived tag and require the container-import gate to pass; resolve that tag to a digest before deployment.
- [ ] Resolve the resulting image digest and deploy `natcut-submission` by digest with the exact service account, database, bucket, secret, scale, and timeout settings.
- [ ] Verify the new revision is healthy and its effective image digest, environment, service account, limits, region, and public network policy match the plan.
- [ ] Verify the existing Hosting pin still serves the baseline revision until the explicit Hosting deployment.

### Task 5: Deploy the isolated Hosting release

**Files:**
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: public NatCut Firebase SDK values and healthy staged Cloud Run revision.
- Produces: visitor bundle and `natcut` Hosting release pinned to the staged revision.

- [ ] Build Hosting with only the NatCut public SDK values.
- [ ] Scan the bundle for emulator endpoints and server secrets; require no matches.
- [ ] Run only `npm run deploy:hosting`.
- [ ] Verify `https://natcut.web.app/api/health`, `/edit`, the pinned Cloud Run tag/revision, and the unchanged default Sprout site.

### Task 6: Prove an accepted V2 ticket and simulator completion

**Files:**
- Create: `scripts/cloud-submission-smoke.ts`
- Create: `scripts/cloud-worker-smoke.ts`
- Create: `test/cloud-submission-smoke.test.mjs`
- Modify: `apps/worker/src/cloud-queue.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/test/claim-race.test.ts`
- Modify: `package.json`
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: anonymous Firebase identity, deployed same-origin API, packaged sprite manifest, isolated named database, durable temporary SQLite journal.
- Produces: one durably identified immutable smoke submission whose canonical manifest, Firestore receipt, and pinned object generation match, plus a transaction-scoped simulator that can claim only that ticket and exits after its acknowledgement or hold.

- [ ] Write failing tests for fixed endpoint/project/event, allowlisted Firebase app key, durable lost-response recovery, canonical manifest identity, receipt/generation inspection, expected-ticket transaction fencing, no-printer dependency boundary, and reconciliation stop behavior.
- [ ] Run the targeted test and observe the expected failures.
- [ ] Implement the bounded smoke harness; persist non-secret attempt identity before POST, recover a lost response read-only, submit and inspect only its own generated ticket, and never delete or rewrite it.
- [ ] Submit one ticket while queue consumption is stopped; inspect its V2 receipt, object digest, exact generation, and immutable profile before starting the simulator.
- [ ] Start `worker:cloud:smoke` with the expected ticket ID, fresh durable SQLite path, and dedicated worker identity; its claim/recovery transaction must reject another queue head and the process must stop after acknowledgement, failure, or reconciliation.
- [ ] Verify Firestore `ready`, absent worker slot, matching `completionFence`, acknowledged local outbox, and no reconciliation hold.

### Task 7: Prove rollback and restore the candidate

**Files:**
- Modify: `docs/runbooks/cloud-preview.md`

**Interfaces:**
- Consumes: recorded baseline Hosting release/revision and verified candidate release/revision.
- Produces: evidence that the public NatCut site can return to the baseline and then restore the candidate without touching Sprout or accepted evidence.

- [ ] Keep the worker stopped and verify no runnable ticket or active slot.
- [ ] Roll only the `natcut` Hosting site back to the recorded baseline release.
- [ ] Verify baseline `/api/health`, `/edit`, pinned revision, and default Sprout HTTP 404.
- [ ] Restore only the candidate `natcut` Hosting release.
- [ ] Verify candidate `/api/health`, `/edit`, pinned revision, smoke ticket status/receipt, and default Sprout HTTP 404.
- [ ] Record both release identifiers and observed revision tags in the runbook.

### Task 8: Close Session 2 without opening hardware scope

**Files:**
- Modify: `docs/runbooks/cloud-preview.md`
- Modify: `docs/superpowers/specs/2026-11-27-trusted-artifacts-cloud-ops-design.md`
- Modify: `README.md`
- Modify only other files required by accepted review findings.

**Interfaces:**
- Consumes: all rollout evidence.
- Produces: one reviewable local commit and an explicit Session 3 blocker.

- [ ] Run `npm test`, `npm run typecheck`, `npm run emulators:test -- --only submission`, `npm run emulators:test -- --only worker`, and `git diff --check`.
- [ ] Re-run bucket/IAM, indexes, Cloud Run, Hosting, queue/slot, and Sprout isolation audits.
- [ ] Request an independent whole-diff review and fix all accepted P0-P2 findings.
- [ ] Document that Session 3 still requires separately approved JPEG/PLT/protocol dry-run work and, later, separately approved loaded-media printer execution.
- [ ] Commit Session 2 locally and stop; do not push, merge, access USB, or send a printer command.
