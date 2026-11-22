# NatCut

NatCut is an open-source-friendly control and workflow project for the Liene PixCut S1. The immediate goal is simple: press a button on a local website and send a reliable print-and-contour-cut job to a PixCut S1 connected to the same Mac by USB, without using Liene Photos.

The longer-term goal is a fast sticker-booth workflow:

`customer capture -> preset/theme -> generated sticker sheet -> preview -> queue -> local USB bridge -> PixCut S1`

Customer-facing features are intentionally deferred until the printer connection is proven reliable.

## Current state

- The test machine is a MacBook connected to a powered-on PixCut S1 over USB-C.
- macOS detects it as `Liene PixCut S1` with USB VID/PID `0x302c:0x3101`.
- The device exposes four interfaces: Print (0), Debug (1), vendor control (2), and vendor data (3).
- Interfaces 2 and 3 match the endpoints documented by existing open-source PixCut projects.
- No print or cut test has been performed yet, and no sticker sheets are currently loaded.

## Direction

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

Exit condition: the Mac can open the expected interfaces, receive valid protocol replies, and close cleanly.

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

### 3. Local website bridge

- Run a localhost HTTP service on the USB-connected computer.
- Provide endpoints for health, printer status, job submission, job status, and cancellation.
- Enforce a single active printer job and persist enough state to recover after a page or service restart.
- Build a minimal operator page with Connect/Status, file preview, Print & Cut, progress, and errors.
- Bind to localhost by default; LAN access must be an explicit configuration choice.

Exit condition: an operator can submit a prepared sheet from the website and watch it complete.

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

1. Run the upstream read-only status tool and save the identity/status result.
2. Record the printer firmware, hardware revision, and any active alerts or jobs.
3. Audit the upstream status and job-submission paths before copying code.
4. Add NatCut's initial package structure and mocked protocol tests.
5. Prepare a single conservative test-sheet fixture and review it before loading paper or creating a job.

## License

The NatCut license has not yet been selected. MIT is the likely choice because the main upstream references are MIT licensed. Add a license before redistributing code.
