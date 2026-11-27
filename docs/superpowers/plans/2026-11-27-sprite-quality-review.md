# Sprite Quality Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline review packet that scores generated canonical sprites and exports one approved candidate per plant for the existing catalog importer.

**Architecture:** A Node 24 command validates a local manifest and publishes a new packet directory atomically. A static HTML application reads embedded packet data, owns review state in local storage, and exports the existing sprite-roster schema.

**Tech Stack:** TypeScript, Node 24, Sharp, plain HTML/CSS/JavaScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-sprite-quality-review-design.md`

## Global Constraints

- Never overwrite an existing output directory.
- Never call Firebase, an AI provider, or the printer.
- Accept only local PNG candidate files.
- Use **sprite**, never “Plantemon.”
- Keep the packet free of remote assets and telemetry.
- Export rows compatible with `scripts/import-sprites.mjs`.

## Review Focus

- A manifest path that escapes its directory must fail before packet publication.
- A corrupt, animated, empty, or non-PNG candidate must fail with its plant name.
- Two candidates with the same bytes must not become ambiguous export choices.
- Reloading the same packet must restore scores, approval, and the approved count.
- Export must remain disabled until every plant has exactly one approved candidate.

---

### Task 1: Deterministic packet generator

**Files:**
- Create: `scripts/sprite-review.ts`
- Create: `test/sprite-review.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `--input <manifest.json>` and `--out <new-directory>`.
- Produces: `index.html` plus content-addressed local images in the output directory.

- [ ] **Step 1: Write failing command tests**

Cover a valid two-plant packet, path escape, missing files, a non-PNG candidate, animation, no printable alpha, duplicate common names, duplicate candidate bytes within one plant, and an existing output directory.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test test/sprite-review.test.mjs`

Expected: FAIL because `scripts/sprite-review.ts` and `sprites:review` do not exist.

- [ ] **Step 3: Implement the packet command**

Parse a strict version-1 manifest. Resolve only relative paths beneath the manifest directory. Use Sharp to validate and normalize bounded review images. Hash every published image. Write into a sibling temporary directory, then rename it to the requested destination only after all files and `index.html` are complete.

- [ ] **Step 4: Add the command reference**

Document the manifest shape, the command, and the handoff from exported `roster.json` to `sprites:import`.

- [ ] **Step 5: Run the focused tests**

Run: `node --test test/sprite-review.test.mjs`

Expected: all packet command tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/sprite-review.ts test/sprite-review.test.mjs package.json README.md
git commit -m "feat(review): build offline sprite packets"
```

### Task 2: Review and export application

**Files:**
- Modify: `scripts/sprite-review.ts`
- Create: `e2e/sprite-review.spec.ts`

**Interfaces:**
- Consumes: embedded immutable packet data from Task 1.
- Produces: per-candidate 1–5 cuteness and accuracy scores, one approval per plant, local progress, and downloaded `roster.json`.

- [ ] **Step 1: Write failing browser tests**

Open a generated two-plant packet through a local static server. Assert common-name and scientific-name order, reference/candidate images, keyboard-accessible 1–5 controls, one approval per plant, replacement within a plant, reload restoration, packet isolation, disabled incomplete export, and the exact exported roster JSON.

- [ ] **Step 2: Run the browser test and verify it fails**

Run: `npx playwright test e2e/sprite-review.spec.ts`

Expected: FAIL because the generated page has no review controls.

- [ ] **Step 3: Implement the static application**

Embed packet data and local CSS/JavaScript in `index.html`. Use native fieldsets, radio controls, and buttons. Store `{ version: 1, scores, approved }` under a key derived from the input manifest and image hashes. Export only names, optional scientific names, and selected local PNG filenames.

- [ ] **Step 4: Verify responsive and accessible behavior**

Capture desktop and mobile screenshots. Check keyboard order, visible focus, selected labels, text wrapping, 44-pixel controls, and no horizontal overflow.

- [ ] **Step 5: Run all checks**

Run: `node --test test/sprite-review.test.mjs`

Run: `npx playwright test e2e/sprite-review.spec.ts`

Run: `npm run typecheck`

Run: `npm test`

Expected: every command passes, apart from existing environment-gated skips.

- [ ] **Step 6: Commit**

```bash
git add scripts/sprite-review.ts e2e/sprite-review.spec.ts
git commit -m "feat(review): score and approve sprite candidates"
```
