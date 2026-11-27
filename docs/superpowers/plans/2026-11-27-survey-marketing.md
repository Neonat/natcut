# Survey and Marketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor submit one post-collection cuteness rating and optionally opt into Sprout product email, without coupling either action to sticker fulfillment.

**Architecture:** Extend the authenticated submission service rather than allowing direct Firestore writes or deploying a second service. A transaction keyed by event and anonymous Firebase UID creates one immutable survey and, only when a normalized email is supplied, one marketing lead whose `optionalSubmissionId` points to that survey. The collected-ticket page owns a small survey component; selfie storage remains out of scope until retention and publishing consent are defined.

**Tech Stack:** TypeScript, React, Fastify, Zod, Firebase Anonymous Auth, Firestore, Vitest, Firebase Emulator, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-23-booth-platform-design.md`

## Global Constraints

- Sticker fulfillment must work without an email, marketing lead, survey, or selfie.
- One survey is allowed per anonymous visitor session and event; the first accepted record is immutable.
- Marketing requires an explicit opt-in and a valid normalized email; no opt-in means no email is transmitted or stored.
- Marketing records use `onboardedAt`; there is no consent-text version field.
- Surveys and marketing leads are server-owned and never publicly readable.
- `selfieStoragePath` is stored as `null` in this slice; uploads and publication permission are separate later work.
- The survey is available only for a collected submission owned by the authenticated visitor.

## Approaches

- **Chosen — add an authenticated route to the existing submission service.** Reuses anonymous identity, the isolated `natcut` database, CORS, emulator coverage, and deployment boundaries.
- **Rejected — direct Firestore client writes.** Fewer server lines, but exposes a sensitive write surface and makes ownership and one-per-session enforcement harder to audit.
- **Deferred — separate survey Cloud Run service.** Strong isolation, but duplicates authentication, configuration, deployment, and observability for a small booth-scale feature.

## Review Focus

- A visitor posts a survey for another visitor’s ticket: reject without revealing whether the ticket exists.
- Two tabs submit simultaneously: store one survey and at most one lead, with deterministic first-write-wins behavior.
- Opt-out payload contains an email anyway: reject the contradictory request rather than silently retaining it.
- Email differs only by case or surrounding whitespace: normalize to one lead identity.
- Network response is lost after commit: a retry returns the existing survey and the UI reaches the thank-you state.

---

### Task 1: Transactional survey repository

**Files:**
- Create: `apps/submission/src/survey-repository.ts`
- Modify: `apps/submission/src/index.ts`
- Test: `apps/submission/test/survey-repository.test.ts`

**Interfaces:**
- Consumes: Firestore and existing `submissions` documents.
- Produces: `SurveyInput`, `SurveyRecord`, `SubmitSurveyResult`, `SurveyRepository`, and `createSurveyRepository(firestore)`.

- [ ] Write failing emulator-backed tests for collected ownership, first-write-wins retries, concurrent tabs, normalized lead identity, and no lead on opt-out.
- [ ] Run `npm run emulators:test -- --project submission` and confirm the new tests fail because the repository is absent.
- [ ] Implement the repository transaction. Use a SHA-256 document ID from `eventId + NUL + ownerUid` for the survey and `eventId + NUL + normalizedEmail` for a lead. Store `selfieStoragePath: null`.
- [ ] Run the focused emulator tests and confirm they pass.
- [ ] Commit the repository slice.

### Task 2: Authenticated survey endpoint

**Files:**
- Modify: `apps/submission/src/routes.ts`
- Modify: `apps/submission/src/cloud-run.ts`
- Modify: `scripts/dev-runtime.ts`
- Modify: `apps/submission/test/routes.test.ts`

**Interfaces:**
- Consumes: `SurveyRepository.submit({ ownerUid, eventId, stickerSubmissionId, cuteRating, marketingEmail, submittedAt })`.
- Produces: `POST /v1/surveys` and `/api/v1/surveys`, returning `{ surveyId, created }`.

- [ ] Write failing route tests for missing/invalid auth, ratings outside 1–5, invalid or contradictory email fields, wrong/uncollected submission, opt-out success, opt-in normalization, and retry success.
- [ ] Run the route test and confirm failures are caused by the missing endpoint.
- [ ] Add a strict Zod request schema with `{ stickerSubmissionId, cuteRating, marketingOptIn, email? }`; map repository ownership/state failures to a single `SURVEY_NOT_AVAILABLE` response.
- [ ] Wire the repository in local emulator runtime and Cloud Run construction.
- [ ] Run route, configuration, and emulator tests.
- [ ] Commit the endpoint slice.

### Task 3: Collected-ticket survey experience

**Files:**
- Create: `apps/visitor/src/queue/survey-card.tsx`
- Modify: `apps/visitor/src/api.ts`
- Modify: `apps/visitor/src/queue/queue-page.tsx`
- Modify: `apps/visitor/src/styles.css`
- Modify: `apps/visitor/test/queue.test.tsx`

**Interfaces:**
- Consumes: `VisitorApi.submitSurvey({ stickerSubmissionId, cuteRating, marketingOptIn, email? })`.
- Produces: an accessible 1–5 rating, optional unchecked product-update opt-in, conditional email field, retryable errors, and an immutable thank-you state.

- [ ] Write failing component tests proving the survey appears only after collection, rating is required, email is absent from opt-out requests, opt-in requires a valid email, duplicate/retry success reaches thanks, and survey failure never changes ticket status.
- [ ] Run the visitor test and confirm failures are caused by missing survey UI/API.
- [ ] Implement the API method and survey card. Keep the opt-in unchecked and show the email field only after selection.
- [ ] Add mobile-first styling without altering existing queue actions or refresh behavior.
- [ ] Run visitor tests and typechecking.
- [ ] Commit the visitor slice.

### Task 4: End-to-end proof and handoff

**Files:**
- Create: `e2e/survey.spec.ts`
- Modify: `README.md`
- Modify: `docs/runbooks/booth-rehearsal.md`

**Interfaces:**
- Consumes: collected queue tickets, visitor API, Firestore emulator.
- Produces: browser proof that an opt-out survey stores a null email and no lead, and an opt-in survey stores the normalized email and linked lead.

- [ ] Write the failing Playwright flow and inspect Firestore documents through the emulator REST API.
- [ ] Run the focused browser test and confirm it fails before the full wiring is complete.
- [ ] Add only the runbook and README instructions required to exercise and inspect the feature.
- [ ] Run `npm run typecheck`, `npm test`, `npm run emulators:test`, and `npm run test:e2e -- --reporter=line`.
- [ ] Review privacy fields in emulator documents, run `git diff --check`, and commit the proof slice.
