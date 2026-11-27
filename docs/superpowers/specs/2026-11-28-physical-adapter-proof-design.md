# Physical Adapter Proof Design

## Intent

Turn an already verified immutable logical bundle into the exact two files a PixCut S1 job would consume, then prove the command and upload framing without opening USB or claiming physical success. This closes the file-generation and protocol-design portion of Session 3 while retaining a separate approval gate for a loaded-sheet test.

## Goals

- Re-verify the receipt and bundle bytes before deriving physical files.
- White-composite the 1200 × 2100 logical color raster and center-pad it to the profile's 1216 × 2128 printer raster.
- Encode a deterministic JPEG no larger than the profile's 1 MiB limit.
- Trace the verified, already-expanded binary cut mask into a PLT using the immutable profile, including `KP42`, without applying the visitor margin twice.
- Validate dimensions, digests, contour bounds, pressure, and protocol parameters before producing evidence.
- Model the exact combo-job declaration, PLT-first/JPEG-second upload ordering, 4075-byte `EXTLEN` frames, little-endian job ID, acknowledgement requirement, and 120 ms baseline pacing as pure data and functions.
- Publish an atomic, create-only dry-run packet containing the JPEG, PLT, and complete evidence needed to reproduce the plan.

## Non-goals and anti-goals

- No USB enumeration, interface claim, transfer, printer command, media check, or physical movement.
- No cloud queue claim, worker phase transition, public `ready` write, or synthesized printer response.
- No cancellation, calibration, firmware, factory, or arbitrary property mutation.
- No claim of printer, booth, or production readiness.
- The dry-run adapter must not implement `PhysicalExecutor`; a file-only proof must never be usable as fulfillment.

## Constraints

- The receipt generation, bundle digest, color digest, mask digest, profile digest, dimensions, and versions are immutable inputs.
- The logical mask already contains the accepted cut-border expansion. PLT generation uses dilation `0`.
- JPEG quality attempts are fixed at 95, 92, 90, 85, 80, 75, 70, 60, then 50; the first output within `jpegMaxBytes` wins.
- Padding must be non-negative, centered, and integral on both axes. All transparent logical pixels and padding pixels are exact opaque white before lossy JPEG encoding; decoded 4:2:0 pixels immediately beside saturated artwork may show bounded chroma bleed, while untouched padding borders remain white.
- NatCut validates knife pressure as an integer from 1 through 100. `devfest-sg-v1` remains 42. The vendored tracer is not edited.
- A combo declaration uses the profile's media size, media type, quality, copies, JPEG and PLT byte lengths. Output names derive from the immutable bundle digest.
- Upload frame bytes cannot be finalized until the printer returns a positive job ID. Dry-run evidence therefore records payload chunks and the exact binder contract, never a fabricated declaration response.
- Output publication is create-only and atomic. Existing destinations and partial inputs fail closed.

## Approaches

### Selected: pure printer-preparation package plus standalone dry-run CLI

`@natcut/printer` accepts only verified artifact evidence, creates the JPEG/PLT in memory, validates a pure protocol plan, and can bind upload chunks to a caller-supplied positive job ID. A separate CLI verifies receipt and bundle files and writes a dry-run packet. It imports no USB module and never touches the worker journal or cloud queue.

This makes the hardware boundary reviewable and reusable by a future real adapter without letting today's proof masquerade as a completed physical job.

### Rejected: extend the current read-only USB client now

Adding mutation methods to `src/protocol.mjs` would put executable writes beside a status command before the loaded-media gate and make an accidental invocation easier.

### Rejected: make a dry-run `PhysicalExecutor`

The worker treats an executor's terminal transition as fulfillment evidence. A dry-run executor could therefore publish `ready` without consuming a sheet, violating the queue contract.

## Components

- `packages/printer/src/artifacts.ts`: verified-bundle decoding, padding, JPEG encoding, PLT creation, output validation, hashes and statistics.
- `packages/printer/src/protocol-plan.ts`: combo declaration, upload ordering, payload chunk plan, and exact frame binding. No transport imports.
- `packages/printer/src/dry-run.ts`: evidence schema and atomic create-only packet publication.
- `scripts/physical-dry-run.ts`: strict CLI over receipt JSON and bundle bytes.
- Tests use synthetic verified bundles and inspect real JPEG/PLT bytes and real framed packets.

## Failure behavior

Malformed or mismatched receipts, bytes, profiles, dimensions, padding, pressure, empty masks, oversized JPEGs, off-sheet paths, inconsistent protocol lengths, unsafe output paths, existing destinations, and non-positive job IDs all fail before any packet is published. A process interruption may leave only a separately named incomplete staging directory; it is never accepted as a complete packet.

## Approval boundary

This design ends after offline dry-run evidence. A future continuation may add a transport-backed adapter and a one-sheet procedure, but USB access and every printer write require the operator to confirm loaded media and give separate explicit approval at execution time.
