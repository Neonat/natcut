# Rehearse the booth without a printer

This runbook exercises the visitor queue, simulated worker, operator pickup, and survey privacy path on disposable local emulators. It never imports the printer bridge, opens USB, sends a printer command, or produces a physical sticker.

## Automated gate

Stop any process already using the NatCut development ports, including `npm run dev`. Run the rehearsal from the repository root:

```bash
npm run rehearsal:sim
```

The command runs two suites sequentially and fails at the first failure:

1. Playwright starts a disposable local stack. Two anonymous visitors join in adjacent queue positions. The desk claims and simulates the first ticket, verifies its exact execution/completion fence and released slot with read-only emulator requests, claims the second ticket, and collects the first without disturbing it. The first visitor submits a 4-star marketing opt-out; the test reads back one survey with a null email and no linked lead. The desk then simulates and collects the second ticket. Both visitor pages must say that no physical sticker was made.
2. After Playwright shuts down its stack, the worker emulator suite runs the crash/restart matrix and a 30-ticket correctness load. Thirty tickets are used only to cross the desk's 25-row pagination boundary. The gate proves strict execution order, peak executor concurrency of one, an exact completion fence and released slot for every ticket, no early follower, no pending outbox or reconciliation blocker, complete pagination, and final collection. It is not a throughput or latency SLA.

`Ctrl-C` and `SIGTERM` are forwarded to the active child command. Wait for emulator shutdown before starting another local suite. A successful run returns to the shell with no NatCut development server intentionally left running.

## Manual two-visitor observation

Use this only for visual/operator inspection; the automated gate owns the storage assertions above.

Start the local stack:

```bash
npm run dev
```

Open two independent browser profiles at [the visitor editor](http://127.0.0.1:4174/edit) and open [the simulator desk](http://127.0.0.1:8090) on the Mac.

1. Join from visitor A, then visitor B. Record both displayed ticket numbers. B should be exactly one position after A.
2. Refresh the desk. Both tickets should be **Queued** in that order.
3. Choose **Claim next**. Refresh visitor A: it should say **You’re next**, and **Leave queue** should be disabled. Visitor B remains queued.
4. Choose **Start simulation**. Refresh the desk until A shows **Ready for simulated pickup**. Refresh visitor A: it should say **Ready for pickup** and **Simulation complete. No physical sticker was made.**
5. Choose **Claim next**. B becomes **Next**. On A's ready row choose **Mark collected**. B must remain **Next**. Refresh visitor A to see **Sticker collected**.
6. On visitor A choose 4 stars and **Send feedback** without selecting product updates. The page changes to **Thanks for your feedback!** The absence of an email and lead is an automated storage assertion, not something inferred from this screen.
7. Choose **Start simulation** for B. Wait for its ready row, refresh visitor B to confirm the no-physical-sticker copy, then choose **Mark collected** and refresh B to see **Sticker collected**.
8. For a separate opt-in UX observation, use a fresh private browser session and a new ticket. Complete it through the same claim, simulation, and pickup sequence before selecting **Email me Sprout product updates**, entering an address, and sending feedback. Do not attempt opt-in after submitting the opt-out form; a collected ticket accepts its survey once.

Stop the stack with `Ctrl-C`. Confirm the emulator shutdown messages have completed before running `npm run rehearsal:sim` or another fixed-port suite.

## Hold evidence and stop rules

Stop the rehearsal immediately if a row shows **On hold**, **needs reconciliation**, or **failed**; a ticket advances out of order; more than one ticket appears active; a follower leaves **Queued** before the current ticket is ready; or any printer/USB prompt appears.

Do not retry **Claim next**, **Start simulation**, or **Mark collected** around a held ticket. Record the ticket number, public status, displayed local phase, hold notice, last operator action, and whether the process was interrupted. Preserve the terminal output. The queue head is expected to remain blocking and visible for operator reconciliation rather than synthesize success.

To run the worker interruption evidence on its own, first stop `npm run dev`, then use disposable emulators:

```bash
npm run emulators:test -- --only worker
```

The recovery tests reuse a temporary SQLite journal across controlled worker restarts. A pre-execution claim can recover. An interruption during simulated execution becomes an operator-visible reconciliation hold and keeps the next ticket queued.

## Simulation limits

This rehearsal uses fixture artwork, anonymous emulator authentication, local Firestore/Auth emulators, `LocalArtifactStore`, and `SimulatedPrinter`. It proves software ordering, fencing, pickup, pagination, restart behavior, and survey privacy under those local conditions. It does not prove JPEG/PLT fidelity on media, printer protocol compatibility, calibration, cut alignment, physical pickup handling, Wi-Fi conditions, cloud deployment, production rate limits, or production observability. A real printer write still requires loaded media and separate explicit approval.
