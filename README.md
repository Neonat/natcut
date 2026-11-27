# NatCut

NatCut is an open-source-friendly sticker-booth workflow for one event operator, one Mac, and one Liene PixCut S1. Visitors approve a sprite sticker on their phones, submit an immutable design, and refresh a public queue screen while the Mac serializes production.

The longer-term goal is a fast sticker-booth workflow:

`customer capture -> preset/theme -> generated sticker sheet -> preview -> queue -> local USB bridge -> PixCut S1`

The current vertical slice proves the phone-to-cloud-to-Mac queue using Firebase emulators and a simulated printer. Physical printer execution remains intentionally absent.

## Current state

- The test machine is a MacBook connected to a powered-on PixCut S1 over USB-C.
- macOS detects it as `Liene PixCut S1` with USB VID/PID `0x302c:0x3101`.
- The device exposes four interfaces: Print (0), Debug (1), vendor control (2), and vendor data (3).
- Interfaces 2 and 3 match the endpoints documented by existing open-source PixCut projects.
- A read-only protocol check successfully identified model `DHP700`, SKU `DHP700W#EU1`, firmware `1.0.15_0054`, and hardware revision `x05`.
- At discovery time the printer reported `idle / idle`, no alerts, and no active jobs.
- NatCut now has a tested read-only protocol core, USB status CLI, localhost API, and operator status page.
- NatCut also has a mobile editor, dynamic cut-border preview, trusted submission API, Firestore queue, SQLite Mac journal, and a Mac simulator desk for running tickets through pickup.
- No print or cut test has been performed yet, and no sticker sheets are currently loaded.

## Run the queue-first vertical slice

Prerequisites:

- Node.js 24.12 or newer (required by the locked Firebase packages).
- Java 21 for the Firestore emulator. On this Mac, `brew install openjdk@21` is sufficient; the project runner sets `JAVA_HOME` without changing shell startup files.
- Playwright Chromium for browser tests.

This repository pins Node `24.22.3` in both `.nvmrc` and `.node-version`. If this Mac still reports Node 22, either run `nvm use` or install Homebrew's Node 24 and put it first for the current shell:

```bash
brew install node@24
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version
```

The project commands stop with a clear version error if the shell is still using Node 22.

Install once:

```bash
npm install
npx playwright install chromium
```

Start the entire local stack:

```bash
npm run dev
```

Open `http://127.0.0.1:4174`. The runner uses only Firebase project `demo-natcut` and fixed local ports:

- Visitor app: `4174`
- Submission API: `8088`
- Simulated worker control: `8090`
- Firestore emulator: `8080`
- Auth emulator: `9099`

Open the [simulator desk](http://127.0.0.1:8090) on the Mac. Choose **Claim next**, then **Start simulation**. Refresh the desk to see the worker phase. Once the ticket is ready, choose **Mark collected** on its row. The visitor can refresh their ticket after each action. The [booth rehearsal runbook](docs/runbooks/booth-rehearsal.md) covers two visitors and worker recovery.

For terminal control, obtain the current desk session and use its capability on each command. Starting a new worker rotates the capability.

```bash
desk_url=http://127.0.0.1:8090
desk_cap=$(curl -fsS "$desk_url/session" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).capability')
curl -fsS -X POST -H "X-NatCut-Control: $desk_cap" -H 'Content-Type: application/json' "$desk_url/claim"
curl -fsS -X POST -H "X-NatCut-Control: $desk_cap" -H 'Content-Type: application/json' "$desk_url/start"
```

Tap **Refresh** on the visitor screen between steps. Claiming changes the public state to **You’re next**. The simulator then advances to **Ready for pickup** and the ticket explains that the rehearsal produced no physical sticker.

After the desk marks a ticket collected, the visitor can leave a 1–5 cuteness rating. Product-update email is a separate, unchecked opt-in; opting out sends and stores no email and never affects the sticker. One immutable survey is accepted per anonymous visitor session. Selfie upload remains disabled until retention and publication consent are defined.

Stopping either development command resets the in-memory Firebase emulators and the temporary SQLite journal. Both commands use only the `demo-natcut` Firebase project.

### Rehearse from a phone on private Wi-Fi

Connect the phone and the Mac to the same trusted Wi-Fi network, then run:

```bash
npm run dev:lan
```

Scan the terminal QR after the stack is ready, or type the printed visitor URL into the phone browser. The command picks the lowest available private IPv4 address. To select a different address assigned to this Mac, set it explicitly before launching:

```bash
NATCUT_LAN_IP=192.168.1.25 npm run dev:lan
```

Use only the bundled fixture art and anonymous emulator sign-in. Keep photos, personal details, and real account credentials out of the rehearsal. The visitor, submission API, and Auth emulator accept connections from the local network. Firestore and the simulated worker controls stay on `127.0.0.1`. Use the same `curl` commands from the Mac to advance a ticket.

If the phone cannot load the URL, check whether the network blocks connections between devices. Guest and conference Wi-Fi may have peer isolation enabled. Check the macOS firewall prompt for Node and allow inbound connections on the trusted rehearsal network. If the Mac changes IP addresses, stop the stack and rerun `npm run dev:lan` to get a new QR. Stop the stack after the rehearsal.

To exercise the private IPv4 browser flow and verify listener reachability from the Mac, run:

```bash
NATCUT_E2E_LAN=1 npm run test:e2e -- e2e/lan-rehearsal.spec.ts
```

Scan the QR on a real phone to verify the network between devices.

### Import a named sprite roster

Monstera and Prickly pear are the two rehearsal fixtures. To supply event artwork, put a JSON roster beside the source PNGs in a local folder outside the repository. Each row names one sprite and its PNG. A scientific name is optional.

```json
[
  { "name": "Monstera", "scientificName": "Monstera deliciosa", "file": "monstera.png" },
  { "name": "Prickly pear", "file": "prickly-pear.png" }
]
```

```bash
npm run sprites:import -- --input /path/to/approved-art/roster.json
```

Each batch supplies the complete picker roster. The importer fits each image on a transparent square up to 760 pixels across and publishes the catalog in `packages/render/catalog`. Use `--out <directory>` to inspect a separate catalog. Commit the generated index and PNGs together. Changed names or artwork receive new IDs. Earlier IDs retain their artwork for accepted tickets and offline proof.

### Review sprite candidates offline

Save a version 1 manifest outside the repository. List one still reference photo and one or more still PNG candidates per plant. Keep image paths relative to the manifest and use distinct candidate artwork across the batch. Scientific names are optional.

```json
{
  "version": 1,
  "plants": [
    {
      "name": "Monstera",
      "scientificName": "Monstera deliciosa",
      "reference": "photos/monstera.jpg",
      "candidates": ["generated/monstera-a.png", "generated/monstera-b.png"]
    }
  ]
}
```

On macOS, build the packet in a new directory and open its `index.html` in your browser. Score candidates from 1 to 5 for cuteness and accuracy. Export is available once each plant has an approved sprite with both scores. Save the downloaded `roster.json` beside `index.html` and the packet PNGs before importing.

```bash
npm run sprites:review -- --input /path/to/manifest.json --out /path/to/new-review
npm run sprites:import -- --input /path/to/new-review/roster.json
```

### Replay the Sprout stream offline

`@natcut/pipeline` reads synthetic response bytes for Sprout's `POST /api/pipeline/run-stream` with `pauseAt2b: false`. Run `npm exec --offline -- vitest run --project pipeline` to replay the contract. Fresh scans yield a validated PNG after a successful model render and cutout. Cache hits yield an untrusted HTTPS reference. Cancellation and failed or incomplete runs yield a fallback reason. The booth still uses its approved catalog.

Before enabling live generation, resolve how a plant search supplies Sprout's required image, authenticate booth requests, and enforce per-session and per-event provider budgets. Test quality on the golden set, add visitor approval with a library fallback, and import approved artwork under an immutable catalog ID before a submission can reference it.

### Generate an offline sheet proof

Create a review packet from the current fixture without connecting to Firebase or the printer:

```bash
npm run proof:sheet -- --out /tmp/natcut-sheet-proof
```

To reproduce an accepted design, save the ticket’s `manifest` object in a local JSON file and run the command with `--manifest`.

```bash
npm run proof:sheet -- --manifest /path/to/manifest.json --out /tmp/natcut-selected-proof
```

The new directory contains `sheet.jpg`, `cut-overlay.svg`, and `evidence.json`. The JPEG is the padded 1216 × 2128 review raster; the SVG places the traced contour over those same coordinates; the evidence file records distinct hashes for the manifest, logical color raster, expanded cut mask, JPEG, and contours. The command reserves the path without replacement and uses a `.incomplete` sentinel while moving the fully built packet into place. Treat the packet as complete only when all three files exist and the sentinel does not; an interrupted run can leave an empty reserved directory. The resulting packet is a normal movable directory.

This packet is explicitly an **offline preview, not print-ready**. Centered padding is an unverified registration assumption. It contains no PLT, knife pressure, USB call, network call, or printer instruction.

## Build the isolated cloud preview

NatCut's public preview uses its own Firebase Hosting target (`natcut`), Cloud Run service (`natcut-submission`), and named Firestore database (`natcut`) inside `sprout-dev-66f08`. Existing Sprout Hosting and databases are not deployment targets.

After creating the separate NatCut Firebase web app, provide its public SDK values and build the visitor bundle:

```bash
VITE_NATCUT_FIREBASE_PROJECT_ID=sprout-dev-66f08 \
VITE_NATCUT_FIREBASE_API_KEY='public Firebase web API key' \
VITE_NATCUT_FIREBASE_AUTH_DOMAIN='sprout-dev-66f08.firebaseapp.com' \
VITE_NATCUT_FIREBASE_APP_ID='NatCut Firebase web app ID' \
npm run build:hosting
```

The production visitor always calls the same-origin `/api` route and never connects to Firebase emulators. Deploy Hosting only with the repository's explicit target command:

```bash
npm run deploy:hosting
```

Do not run bare `firebase deploy` in this project. The cloud provisioning and recovery commands are recorded in [`docs/runbooks/cloud-preview.md`](docs/runbooks/cloud-preview.md).

**Stop every legacy cloud worker before deploying the version 2 submission API.** Keep the cloud simulator stopped after activation. Queue consumption can resume with a worker that verifies stored artifacts. Follow the deployment gates in the [cloud preview runbook](docs/runbooks/cloud-preview.md).

The following booth Mac command is for the legacy API and legacy queue only.

```bash
gcloud auth application-default login \
  --impersonate-service-account=natcut-worker@sprout-dev-66f08.iam.gserviceaccount.com
NATCUT_PROJECT_ID=sprout-dev-66f08 \
NATCUT_DATABASE_ID=natcut \
NATCUT_SQLITE_PATH="$PWD/.local/natcut-worker.sqlite" \
NATCUT_WORKER_ID=devfest-macbook \
npm run worker:cloud:sim
```

This cloud worker uses only `SimulatedPrinter`; it does not import or open the USB printer bridge. It processes one queue record at a time and stops if a job needs operator reconciliation.

Run verification independently:

```bash
npm test
npm run typecheck
npm run emulators:test -- --only submission
npm run emulators:test -- --only worker
npm run test:e2e
```

**Safety boundary:** the queue-first stack contains no printer job declaration, upload, print, cut, cancel, or property-mutation implementation. The simulated worker never imports the USB protocol or opens the printer. The existing hardware bridge remains read-only.

## Run the read-only bridge

Requires Node.js 24.12 or newer.

```bash
npm install
npm test
npm run status -- --json
npm start
```

Open `http://127.0.0.1:4173` after starting the server. The current API exposes only `GET /api/health` and `GET /api/printer`; it cannot create, upload, confirm, cancel, pause, resume, print, or cut a job.

USB interfaces are exclusive. Close BrenCut, Liene Photos, and any Chrome tab that has connected to the printer before using the CLI or dashboard. NatCut reports a connection-busy error instead of detaching another process.

## Direction

The agreed mobile booth, cloud queue, live cut-preview, marketing, and Mac-worker architecture is specified in [`docs/superpowers/specs/2026-11-23-booth-platform-design.md`](docs/superpowers/specs/2026-11-23-booth-platform-design.md).

NatCut will use a local bridge rather than making the website own the USB connection.

```text
Local operator website
        |
        v
NatCut HTTP API + single-job queue
        |
        v
USB driver / protocol adapter
        |
        v
Liene PixCut S1
```

The first implementation target is Node.js so the website, queue, protocol adapter, and upstream BrenCut-derived ideas can share one language. Direct browser WebUSB remains useful as a hardware sanity check, but it is not the intended production architecture because printing should survive page refreshes and eventually run independently of the customer UI.

## Upstream credit

NatCut is inspired by and builds on the reverse-engineering work in [BrenCut](https://github.com/LTKMN/brencut) by LTKMN/Brennan. BrenCut demonstrated direct browser-based print and kiss-cut support for the PixCut S1 and provides a clean JavaScript protocol abstraction, WebUSB transport, Node USB adapter, sheet preparation, and a vendored cut-path tracer. BrenCut is MIT licensed; any code reused from it must retain its license and attribution.

Protocol behavior and recovery ideas are also informed by [PixCut-App](https://github.com/popcornhax/PixCut-App), and contour generation work by [honeymaro/pixcut](https://github.com/honeymaro/pixcut). Their licenses and notices must be preserved wherever their code is reused.

NatCut is not affiliated with Liene or Hannto. PixCut and Liene are trademarks of their respective owners.

## Known protocol baseline

- USB VID/PID: `0x302c:0x3101`
- Control interface 2: bulk OUT `0x06`, bulk IN `0x86`
- Data interface 3: bulk OUT `0x04`, bulk IN `0x84`
- Control messages are ASCII commands with compact JSON and a trailing newline.
- Data is transferred in ACK-paced chunks; observed implementations use `EXTLEN=4075` and about 120 ms pacing.
- A combo job uploads a JPEG print document plus a PLT cut document.
- Logical artwork is 1200 x 2100 px at 300 DPI and is padded to 1216 x 2128 px for printer registration.
- JPEG payloads must remain at or below 1 MiB.
- Only one physical printer job may run at a time.

These details are empirical and must be validated against this specific printer and firmware. NatCut must avoid firmware, factory, calibration, and undocumented mutation commands during initial development.

## Roadmap

### 0. Safe discovery

- Confirm USB identity, interfaces, and endpoints.
- Run identity/status/active-job queries only.
- Record printer firmware/hardware information and initial state.
- Do not create jobs or send mutation commands during discovery.

Exit condition: the Mac can open the expected interfaces, receive valid protocol replies, and close cleanly. **Completed.**

### 1. Controlled hardware proof

- Audit the exact BrenCut job sequence and safety boundaries.
- Prepare one known 1200 x 2100 test image and a simple, clearly previewed contour.
- Load one sheet and use a conservative kiss-cut pressure agreed before testing.
- Submit one print-and-cut job while recording raw replies and timings.
- Verify print placement, cut registration, cut depth, completion state, and clean USB release.

Exit condition: one sheet prints and contour-cuts correctly without Liene Photos.

### 2. NatCut driver core

- Isolate protocol framing from USB transport.
- Add typed identity, status, job submission, progress, cancellation, and recovery operations.
- Validate all artwork dimensions, JPEG size, media settings, and PLT data before USB transfer.
- Use sequential ACK-paced uploads with explicit timeouts and actionable errors.
- Keep dangerous or undocumented commands out of the public API.
- Add protocol framing tests with mocked USB I/O.

Exit condition: repeatable driver tests plus a small CLI that can query status and submit a prepared job.

Read-only foundation completed: protocol framing/parsing, identity, status, active-job listing, USB lifecycle, and a tested status CLI. Job creation and upload remain intentionally absent.

### 3. Local website bridge

- Run a localhost HTTP service on the USB-connected computer.
- Provide endpoints for health, printer status, job submission, job status, and cancellation.
- Enforce a single active printer job and persist enough state to recover after a page or service restart.
- Build a minimal operator page with Connect/Status, file preview, Print & Cut, progress, and errors.
- Bind to localhost by default; LAN access must be an explicit configuration choice.

Exit condition: an operator can submit a prepared sheet from the website and watch it complete.

Read-only foundation completed: localhost health/status endpoints and an operator dashboard. Submission controls remain intentionally absent.

### 4. Reliability and throughput

- Test consecutive jobs, USB reconnects, printer restarts, timeouts, cancellation, stale job IDs, malformed files, and out-of-paper states.
- Prevent accidental duplicate submissions.
- Record initialization, upload, print, cut, eject, and ready-for-next-job timings.
- Optimize JPEG size, contour complexity, and pacing only after a stable baseline exists.

Exit condition: a documented recovery path exists for every expected failure and repeated jobs complete reliably.

### 5. Booth workflow

- Add mobile capture, limited themes/presets, automatic sheet composition, preview, confirmation, and queue numbers.
- Keep customer interaction under roughly 30-45 seconds; printing continues independently.
- Separate customer submission from production and pickup status.
- Add duplicate protection, retries, timestamps, completion tracking, and an operator queue screen.

Exit condition: customers submit quickly while the single printer processes jobs safely in order.

## Safety rules

- Never print or cut without explicit operator confirmation and loaded media.
- Preview raster and contours before submission.
- Start with status-only commands, then one controlled test job.
- Never experiment with firmware, factory, calibration, or arbitrary `set-prop` commands.
- Do not reduce transfer pacing until baseline reliability is measured.
- Avoid perf-cut during early testing because it can wear the cutting strip.
- Log the command, job ID, printer response, and outcome for every hardware operation.
- Make cancellation available, but do not assume cancellation is instantaneous or always safe mid-motion.

## Immediate next steps

1. Audit the upstream job declaration, data upload, acknowledgement, polling, and recovery paths without adding them to the executable API.
2. Design the job safety gate: validated fixture, explicit armed state, loaded-media confirmation, and duplicate prevention.
3. Prepare a single conservative test-sheet fixture and review its raster and contour offline.
4. Defer all physical job execution until a sheet is intentionally loaded and the operator separately approves the test.

## License

NatCut is MIT licensed. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
