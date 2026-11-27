# Physical adapter proof

This runbook covers only the offline portion of Session 3. It creates the exact JPEG and PLT and a reviewable protocol transcript from an immutable verified logical bundle. It must not enumerate USB, open the printer, claim an interface, send a command, change a cloud ticket, or mark a sticker ready.

## Inputs

Use these two files from the same accepted submission:

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

Tests drive the transport-attempt module through `declareCombo` and `sendFrameAndWaitForAck` mocks. The module has no concrete printer transport, worker integration, or CLI. A dedicated journal record binds the submission, event, worker, durable execution token, manifest, full artifact receipt and generation, profile, and exact JPEG and PLT byte counts and digests.

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

## Stop boundary

Stop after inspecting this packet. It does not prove media loading, print placement, cut registration, cut depth, USB recovery, or physical completion.

A controlled sheet procedure needs a concrete transport and evidence tied to the declared job ID. Confirm the correct media is loaded and obtain separate explicit approval before USB access or a printer write. The operator clear flow is still missing. Preserve any held journal and keep the token-fenced queue slot held until the printer evidence can resolve the attempt.
