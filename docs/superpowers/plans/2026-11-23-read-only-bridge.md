# Read-Only Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested Node.js bridge and local webpage that can report PixCut S1 identity, status, alerts, and active job IDs without exposing any printer mutation or job-creation operation.

**Architecture:** A transport-agnostic protocol client frames and parses read-only JSON requests. A node-usb adapter owns interfaces 2 and 3 for the shortest possible session, while an HTTP service exposes a small localhost-only API and static operator page. USB access is dependency-injected so every behavior except the separately approved live smoke check is verified with fakes.

**Tech Stack:** Node.js 22+, ECMAScript modules, `node:test`, `usb` 2.x, built-in `node:http`

**Spec:** `README.md`

## Global Constraints

- This milestone must not contain job creation, file upload, print, cut, cancel, pause, resume, calibration, firmware, factory, or `set-prop` operations.
- The HTTP server binds to `127.0.0.1` by default.
- USB VID/PID are `0x302c:0x3101`; control interface is 2 with OUT `0x06` and IN `0x86`.
- Protocol requests are serialized and time out with an actionable error.
- BrenCut-derived code and behavior retain MIT attribution in source and third-party notices.
- No live printer command is run unless it is read-only under the user's standing approval.

## Review Focus

- Printer absent: CLI/API returns a clear unavailable result without crashing the server.
- USB interfaces owned elsewhere: surface `LIBUSB_ERROR_ACCESS` as an actionable connection-busy error.
- Split or noisy USB replies: parser retains partial data and matches the requested response ID.
- Printer timeout: request fails within the configured deadline and releases claimed interfaces.
- Concurrent webpage polls: serialize access so only one USB session is active at a time.

---

### Task 1: Read-only protocol core and attribution

**Files:**
- Create: `package.json`
- Create: `LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `src/protocol.mjs`
- Test: `test/protocol.test.mjs`

**Interfaces:**
- Consumes: transport `{ write(endpoint, bytes), read(endpoint, maxLength, timeoutMs) }`
- Produces: `frameJson(object)`, `takeJson(text)`, `alertCodes(value)`, and `ReadOnlyPixCut` methods `identify()`, `status()`, `activeJobs()`, `snapshot()`

- [ ] **Step 1: Write failing protocol tests**

Cover exact JSON framing, split/noisy responses, alert parsing, serialized request IDs, identity mapping, status labels, active-job parsing, event errors, and timeout behavior.

- [ ] **Step 2: Run the protocol tests and verify failure**

Run: `npm test -- test/protocol.test.mjs`
Expected: FAIL because `src/protocol.mjs` does not exist.

- [ ] **Step 3: Implement the minimum read-only protocol client**

Implement only `get-prop` and `get-job-id-list` requests plus the public methods above. Do not include generic public mutation methods or job operations.

- [ ] **Step 4: Run protocol tests**

Run: `npm test -- test/protocol.test.mjs`
Expected: all protocol tests pass.

- [ ] **Step 5: Commit**

Commit message: `feat: add read-only PixCut protocol core`

### Task 2: USB session and status CLI

**Files:**
- Create: `src/usb-session.mjs`
- Create: `src/snapshot.mjs`
- Create: `bin/status.mjs`
- Test: `test/usb-session.test.mjs`
- Test: `test/snapshot.test.mjs`

**Interfaces:**
- Consumes: `ReadOnlyPixCut` from Task 1 and injected USB module exposing `findByIds(vid, pid)`
- Produces: `openUsbSession({ usbModule }) -> { io, close }`, `readPrinterSnapshot({ openSession })`, and CLI JSON/text output

- [ ] **Step 1: Write failing USB/session tests**

Cover absent devices, both interface claims, endpoint mapping, timeout-as-empty-read, access-denied translation, interface release after success, and interface release after request failure.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- test/usb-session.test.mjs test/snapshot.test.mjs`
Expected: FAIL because the USB/session modules do not exist.

- [ ] **Step 3: Implement the USB session and snapshot boundary**

Claim only interfaces 2 and 3, translate known libusb errors, and guarantee `close()` in `finally`. Keep the real `usb` import behind the CLI entry point so tests require no hardware.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Run the approved live read-only CLI smoke check**

Run: `npm run status -- --json`
Expected: DHP700 identity, idle state, no alerts, and no active jobs; no printer movement.

- [ ] **Step 6: Commit**

Commit message: `feat: add safe USB status CLI`

### Task 3: Local read-only website bridge

**Files:**
- Create: `src/server.mjs`
- Create: `public/index.html`
- Create: `test/server.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `readPrinterSnapshot({ openSession })` from Task 2
- Produces: `createServer({ getSnapshot })`, `GET /api/health`, `GET /api/printer`, and the local operator status page

- [ ] **Step 1: Write failing HTTP tests**

Cover health response, successful printer snapshot, absent/busy/timeout error mapping, rejection of non-GET requests, unknown routes, and two concurrent status calls being serialized.

- [ ] **Step 2: Run the server tests and verify failure**

Run: `npm test -- test/server.test.mjs`
Expected: FAIL because `src/server.mjs` does not exist.

- [ ] **Step 3: Implement localhost API and minimal status page**

The page provides a single refresh action and displays connection, identity, printer/substate, alerts, and active jobs. It exposes no controls that mutate printer state.

- [ ] **Step 4: Run tests and start-server smoke check**

Run: `npm test && npm run start`
Expected: all tests pass and the service listens on `http://127.0.0.1:4173`; stop it after confirming health.

- [ ] **Step 5: Update usage and safety documentation**

Document install, `npm run status`, `npm start`, exclusive-interface behavior, and the explicit absence of job submission.

- [ ] **Step 6: Commit**

Commit message: `feat: add local read-only printer dashboard`

### Task 4: Final verification

**Files:**
- Modify if needed: files from Tasks 1-3

**Interfaces:**
- Consumes: complete read-only bridge
- Produces: verified repository state

- [ ] **Step 1: Run complete automated verification**

Run: `npm test && npm run status -- --json`
Expected: all tests pass and the live printer returns an idle read-only snapshot.

- [ ] **Step 2: Verify forbidden operations are absent**

Run: `rg -n "combo-job|print-job|cut-job|cancel-job|set-prop|pause-printer|resume-printer|cmd data|transferOut" src bin public test`
Expected: no implementation matches; test/documentation strings, if any, must explicitly assert rejection.

- [ ] **Step 3: Verify repository cleanliness and recent commits**

Run: `git status --short --branch && git log --oneline -5`
Expected: clean `main` branch with one commit per completed task.
