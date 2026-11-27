# Completion Fencing and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make simulator completion and restart behavior token-fenced, idempotent after a lost cloud response, and explicit when operator reconciliation is required.

**Architecture:** Replace the generic worker status write and separate acknowledgement probe with one Firestore completion transaction. The transaction advances only the exact active printing execution and stores immutable completion evidence; an identical retry may confirm a ready or collected record, while any stale or different evidence is fenced and leaves the queue slot held. The durable SQLite outbox retains the intent, and recovery rebuilds completion evidence only from the verified local journal and execution token.

**Tech Stack:** TypeScript, Firestore transactions/emulator, SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-trusted-artifacts-cloud-ops-design.md`

## Global Constraints

- Work only on completion fencing and reconciliation; do not deploy, access USB, or send printer commands.
- Preserve single-slot queue-head blocking and accepted submission immutability.
- A lost acknowledgement must never cause another physical execution or release a slot on different evidence.
- Legacy, malformed, corrupt, stale-token, and ambiguous records remain held and operator-visible.
- Produce one local reviewable commit after full verification and independent review.

## Review Focus

- A ready or collected retry confirms only the exact persisted worker, execution token, manifest, validation, and artifact receipt/profile.
- A stale worker, token, receipt generation, or queue slot cannot release the active slot.
- Crashes before begin remain resumable, while crashes after begin or during simulated execution never synthesize success.
- A local ready intent before commit retries safely; a lost response after commit clears only after exact confirmation.
- Legacy or malformed outbox/journal records block later claims and remain visible for operator reconciliation.

---

### Task 1: Fence completion and restart recovery end to end

**Files:**
- Modify: `apps/worker/src/cloud-queue.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/job-store.ts`
- Modify: `apps/worker/test/claim-race.test.ts`
- Modify: `apps/worker/test/worker.test.ts`
- Modify: `apps/worker/test/restart.test.ts`
- Modify: `apps/worker/test/operator-queue.test.ts`
- Modify: `docs/superpowers/specs/2026-11-27-trusted-artifacts-cloud-ops-design.md`
- Modify: `docs/runbooks/cloud-preview.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: verified V2 submission receipt, manifest hash, validation, active worker slot, execution lease, and durable local execution token.
- Produces: `completeExecution(...)` with `committed | confirmed | fenced` outcomes and a persisted immutable completion fence.

- [x] Write failing Firestore-emulator tests for exact completion, identical ready/collected retry, stale worker/token, mismatched artifact generation, and preserved slot/next ticket.
- [x] Run the targeted emulator tests and observe the expected failures against the generic status API.
- [x] Implement the completion transaction and remove the generic worker ready/acknowledgement APIs.
- [x] Write failing worker/restart tests for crash boundaries before begin, after begin, during execution, before completion commit, and after commit with a lost response.
- [x] Run the targeted unit tests and observe the expected failures.
- [x] Rebuild completion evidence from the verified journal/token, classify `fenced` as reconciliation and transport failure as retry, and keep pending intents durable.
- [x] Run targeted unit and emulator tests to green.
- [x] Update the spec, runbook, and README with the exact invariants and remaining authorized-rollout blocker.
- [x] Run `npm test`, `npm run typecheck`, `npm run emulators:test`, and `git diff --check`.
- [x] Request an independent whole-diff review, fix all accepted P0-P2 findings with RED-to-GREEN tests, rerun the full gates, and create one local commit.
