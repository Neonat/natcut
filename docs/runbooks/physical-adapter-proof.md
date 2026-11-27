# Physical adapter proof

Use this runbook to inspect generation offline or reconcile the completed physical proof from its original journal. All inspection and observation steps run without USB or printer commands. The completed attempt is permanently locked.

## Inputs

Physical generation requires a version 2 logical descriptor carrying sRGB evidence. Version 1 receipts remain readable for historical verification. Use these two files from the same accepted submission:

- `receipt.json`: the exact `{ descriptor, generation }` artifact receipt stored on the submission.
- `logical-bundle.bin`: the bytes read from that receipt's exact object generation.

Do not substitute the latest object generation, reconstruct a missing bundle, or edit a profile snapshot. A missing or mismatched input is reconciliation work, not permission to regenerate accepted evidence.

## Build the packet

Choose a path that does not exist:

```bash
npm run physical:dry-run -- \
  --receipt /path/to/receipt.json \
  --bundle /path/to/logical-bundle.bin \
  --out /tmp/natcut-physical-dry-run
```

A complete packet contains exactly:

```text
cut.plt
evidence.json
print.jpg
```

Treat the packet as incomplete if `.incomplete` exists or any file is missing. Never remove the sentinel to make a partial packet look complete; discard the directory and rerun from the same immutable inputs. The command refuses to replace an existing directory.

## Inspect the evidence

```bash
test ! -e /tmp/natcut-physical-dry-run/.incomplete &&
shasum -a 256 \
  /tmp/natcut-physical-dry-run/print.jpg \
  /tmp/natcut-physical-dry-run/cut.plt &&
jq '{label, transport, input, outputs, protocol}' \
  /tmp/natcut-physical-dry-run/evidence.json
```

Verify all of the following:

- `transport` is `disabled-dry-run` and the label says no printer command was sent.
- Input generation and all four input digests (bundle, logical color, expanded mask, and profile) match the accepted receipt.
- JPEG dimensions are 1216 × 2128, its byte count does not exceed 1,048,576, and its recorded digest matches the file.
- PLT digest and byte count match the file, its pressure is the immutable profile value `42`, and every cut point is inside the 4 × 7 cut canvas.
- Declaration file sizes, media size `5013`, media type `2030`, quality `4`, and copies `1` match the immutable profile and the output bytes.
- Upload order is `cut.plt` then `print.jpg`. Each chunk carries at most 4071 payload bytes plus a four-byte job ID. The plan requires an acknowledgement and 120 ms pacing per frame.
- `requiresPrinterJobIdAfterDeclaration` is true and no `jobId` field exists. Actual upload frames cannot be finalized before a real declaration returns a positive job ID.

The automated proof uses real bundle verification, Sharp JPEG decoding, PLT parsing, exact declaration comparison, byte framing, failure cleanup, and create-only publication:

```bash
npm exec --offline -- vitest run --project printer
node --import tsx --test test/physical-dry-run.test.mjs
```

The encoder white-composites every transparent logical pixel and constructs every padding pixel as exact opaque white before JPEG encoding. JPEG is intentionally lossy 4:2:0, so decoded pixels immediately beside saturated artwork can show bounded chroma bleed; untouched padding borders must still decode as white.

## Inert transport-attempt proof

Tests drive the transport-attempt module through `declareCombo` and `sendFrameAndWaitForAck` mocks. The local proof adapter exercises the same journal. The queue worker continues to run simulated jobs. A dedicated journal record binds the submission, event, worker, durable execution token, manifest, full artifact receipt and generation, profile, and exact JPEG and PLT byte counts and digests.

The following invariants are automated:

- Malformed bindings and empty or mismatched payloads fail preflight before a journal reservation or mock call.
- The journal requires an absolute file path. It verifies SQLite WAL mode and uses `synchronous=FULL` and macOS `fullfsync` before it accepts a reservation.
- Declaration intent is durable before the mock can receive a declaration.
- A single positive unsigned 32-bit printer job ID is durable before the first PLT frame.
- Each frame intent is durable before its mock write, and each acknowledgement is durable before the next frame.
- PLT precedes JPEG and every acknowledged frame is followed by the recorded 120 ms baseline pace.
- Any row in the same journal blocks another reservation. Reopening from `declaring`, `declared`, `frame_pending`, or `frame_acknowledged` leaves that row intact and makes zero transport calls.
- An invalid reply, lost acknowledgement, uncertain checkpoint, or completed upload requires reconciliation. Fully acknowledged uploads return `physical_observation_required`. The module has no access to publish `ready` or release a queue slot.
- Static bundle checks allow only the reviewed imports for the transport-attempt module and confirm that the worker and existing printer CLI entry points do not import it.

This proves local ordering and crash fencing only. The mocks cannot prove that firmware accepts the declaration or frames, that an acknowledgement belongs to a particular frame, that a job ID survives device restart, that paper was loaded or consumed, or that printing, cutting, ejection, registration, and pressure succeeded. Global idle, an empty job list, upload acknowledgement, or an uncorrelated `9000` state is not fulfillment evidence.

## Provenance and pressure ruling

The transport contract was audited against BrenCut commit `e62f2d66a3dc1cc65891e8110420a9e3bf1c0cc7`. Its combo job uses the same print and cut document fields, uploads PLT before JPEG, frames 4071 payload bytes with a little-endian job ID, requires an acknowledgement per frame, and uses 120 ms pacing. The cut generator remains the unmodified `honeymaro/pixcut` source recorded in `vendor/pixcut-trace/SOURCE.md` at commit `08580a69cc8cd6823ad58297f9594000e6ad06ff`.

The vendored tracer comments describe `KP` as `0–3`, but the current device-level sources use `1–100`; BrenCut records that `KP1` did not lower its blade and that the official Liene sticker-paper setting is `42`. NatCut therefore validates `1–100` at its wrapper and preserves the published `devfest-sg-v1` value `42` without modifying vendored code.

## Software generation QC

For a reviewed sprite, retain the preview PNG, `roster.json` and its original tagged PNG under `sources/`. Import re-verifies the original digest and normalization. Unknown ICC profiles, conflicting declarations, untagged external artwork, and higher bit-depth samples fail. Normalize a 16-bit source to tagged 8-bit sRGB before review. Recognized Display P3 and CMYK 8-bit inputs convert to sRGB. Existing packaged artwork is accepted through its digest-addressed normalized catalog. The v2 receipt includes the canonical set of source spaces, ICC digests and preserve/convert actions from all composed layers.

Inspect `outputs.jpeg.colorEvidence` and `outputs.jpeg.generationQc` in `evidence.json`. Only trusted RGBA8 enters the print raster. Only the verified binary mask enters the PLT. The red overlay is created for display from these two finished artifacts. A standalone uploaded PNG cannot be used in the physical proof.

The generation reference is the white-composited, centered and padded sRGB RGB8 raster. Its SHA-256 and the measured errors accompany the decoded final JPEG. The inclusive limits for `natcut-jpeg-qc-v1` are 19,313 thousandths per-channel mean absolute error, p99 of 96, 201,249 ppm of pixels whose largest channel error exceeds 32, and 9 levels of signed channel bias in a 16 × 16 tile. For a failed comparison inspect the reason codes, worst pixel with expected and actual RGB, and the worst tile’s origin, channel and signed bias. Check source tags and the print-only composition against the reference before accepting new artwork. [Calibration corpus, margins and examples](../../packages/printer/test/jpeg-qc-calibration.md)

```sh
npx vitest run --project printer test/qc-calibration.test.ts test/generation-qc.test.ts
```

## Physical attempt and ribbon registration

The owner reported the completed sheet on 28 November 2026. Transport, cut alignment and kiss cut passed. Print quality failed due to printer ribbon registration. The attempt is permanently locked against resend. No channel-specific observation, photo, exact observation time or journal identity accompanied the report. The checked-in source records cyan, magenta and yellow as uncertain. [Owner observation](../evidence/physical-attempt-2026-11-28.json)

The recording workflow requires the **original transport journal** at the existing absolute path configured in `NATCUT_TRANSPORT_JOURNAL`. Preserve its WAL and evidence. The repository contains no such journal. While binding is unavailable, retain the owner report and the reconciliation hold. Never substitute a new journal, a guessed timestamp, another sheet, or a generated fingerprint.

From the repository root, use the original journal’s absolute path and open the dashboard at `http://127.0.0.1:4173`. Startup, evidence, QC and preview routes do not load the native USB binding.

```sh
NATCUT_TRANSPORT_JOURNAL=/absolute/path/to/original-journal.sqlite npm start
```

1. Open the local operator dashboard with the journal configured. The page reads `GET /api/physical-proof/evidence` without a printer connection. An inconsistent or unavailable journal returns 503. A checkpoint shows the exact submission ID, evidence hash and printer job ID. The execution token and raw journal JSON stay private.
2. Verify the displayed identity matches this observation and independently confirm the actual observation time. **Record completed attempt** appears only at `needs_reconciliation / physical_observation_required` with a positive job ID, no pending frame and exactly every PLT and JPEG frame acknowledged. Supply the actual UTC observation timestamp. The page posts the fixed owner-reported outcome to `/api/physical-proof/record-completed`.
3. The dashboard restores **Attempt locked. No resend.** from the journal on every load. The outcome seals the transport row, including writes from already-open SQLite connections. Every direct send and browser mutation checks the journal before transport. No public status, queue slot or receipt changes.
4. In **Post-print ribbon registration QC**, choose pass, fail or uncertain independently for cyan, magenta and yellow. Leave a channel uncertain if evidence is missing. Supply an evidence reference and notes where available. The form posts to `/api/physical-proof/physical-qc`. The API accepts up to eight references of at most 512 characters each and up to 2,000 note characters. Overall is fail if any channel fails, uncertain if any remaining channel is uncertain, otherwise pass.
5. Identical POST retries return the original record. A different timestamp, QC result or evidence binding returns 409. Malformed inputs return 400. If an acknowledgement is lost, reload to read the committed record. No append operation calls WebUSB or transport.

These software thresholds cover image encoding only. Cyan, magenta and yellow ribbon-registration artifacts arise inside the printer and require post-print physical QC. They are not an image-generation failure and cannot be prevented by generation QC. This runbook ends with the evidence and its binding status.
