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
- Upload order is `cut.plt` then `print.jpg`; each chunk carries at most 4071 payload bytes inside `EXTLEN=4075`, requires an acknowledgement, and records 120 ms baseline pacing.
- `requiresPrinterJobIdAfterDeclaration` is true and no `jobId` field exists. Actual upload frames cannot be finalized before a real declaration returns a positive job ID.

The automated proof uses real bundle verification, Sharp JPEG decoding, PLT parsing, exact declaration comparison, byte framing, failure cleanup, and create-only publication:

```bash
npm exec --offline -- vitest run --project printer
node --import tsx --test test/physical-dry-run.test.mjs
```

The encoder white-composites every transparent logical pixel and constructs every padding pixel as exact opaque white before JPEG encoding. JPEG is intentionally lossy 4:2:0, so decoded pixels immediately beside saturated artwork can show bounded chroma bleed; untouched padding borders must still decode as white.

## Provenance and pressure ruling

The transport contract was audited against BrenCut commit `e62f2d66a3dc1cc65891e8110420a9e3bf1c0cc7`. Its combo job uses the same print and cut document fields, uploads PLT before JPEG, frames 4071 payload bytes with a little-endian job ID, requires an acknowledgement per frame, and uses 120 ms pacing. The cut generator remains the unmodified `honeymaro/pixcut` source recorded in `vendor/pixcut-trace/SOURCE.md` at commit `08580a69cc8cd6823ad58297f9594000e6ad06ff`.

The vendored tracer comments describe `KP` as `0–3`, but the current device-level sources use `1–100`; BrenCut records that `KP1` did not lower its blade and that the official Liene sticker-paper setting is `42`. NatCut therefore validates `1–100` at its wrapper and preserves the published `devfest-sg-v1` value `42` without modifying vendored code.

## Stop boundary

Stop after inspecting this packet. It does not prove media loading, print placement, cut registration, cut depth, USB recovery, or physical completion.

The next continuation may prepare a transport-backed adapter and one controlled sheet procedure, but it must remain inert until the operator confirms the correct media is loaded and separately approves that exact printer write. The physical attempt must persist the returned job ID before upload, retain the token-fenced queue slot through ambiguity, and reconcile printer evidence rather than resubmit after a crash.
