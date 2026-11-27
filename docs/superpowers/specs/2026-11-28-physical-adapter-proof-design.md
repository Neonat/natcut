# Physical Adapter Proof Design

## Intent

Turn an already verified immutable logical bundle into the exact two files a PixCut S1 job would consume. Prove the command and upload framing and exercise crash boundaries through a semantic mock port. A loaded-sheet test requires separate approval.

## Goals

- Re-verify the receipt and bundle bytes before deriving physical files.
- White-composite the 1200 × 2100 logical color raster and center-pad it to the profile's 1216 × 2128 printer raster.
- Encode a deterministic JPEG no larger than the profile's 1 MiB limit.
- Trace the verified, already-expanded binary cut mask into a PLT using the immutable profile, including `KP42`, without applying the visitor margin twice.
- Validate dimensions, digests, contour bounds, pressure, and protocol parameters before producing evidence.
- Model the exact combo declaration and PLT-first upload order. Each frame contains up to 4071 payload bytes and a four-byte, little-endian job ID. The transport attempt requires an acknowledgement and a 120 ms pause after each frame.
- Publish an atomic, create-only dry-run packet containing the JPEG, PLT, and complete evidence needed to reproduce the plan.
- Exercise durable declaration, upload, and restart behavior without a concrete printer transport.

## Non-goals and anti-goals

- No USB enumeration, interface claim, transfer, printer command, media check, or physical movement.
- No cloud queue claim, worker phase transition, public `ready` write, or synthesized printer response.
- No cancellation, calibration, firmware, factory, or arbitrary property mutation.
- No claim of printer, booth, or production readiness.
- The dry-run CLI and transport-attempt module cannot implement `PhysicalExecutor`. File evidence and mock upload acknowledgements cannot authorize fulfillment.

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

The separate `@natcut/printer/transport-attempt` export models declaration and upload through the semantic `TransportMutationPort`. It has no concrete transport and no worker or CLI wiring.

### Rejected: extend the current read-only USB client now

Adding mutation methods to `src/protocol.mjs` would put executable writes beside a status command before the loaded-media gate and make an accidental invocation easier.

### Rejected: make a dry-run `PhysicalExecutor`

The worker treats an executor's terminal transition as fulfillment evidence. A dry-run executor could therefore publish `ready` without consuming a sheet, violating the queue contract.

## Components

- `packages/printer/src/artifacts.ts`: verified-bundle decoding, padding, JPEG encoding, PLT creation, output validation, hashes and statistics.
- `packages/printer/src/protocol-plan.ts`: combo declaration, upload ordering, payload chunk plan, and exact frame binding. No transport imports.
- `packages/printer/src/dry-run.ts`: evidence schema and atomic create-only packet publication.
- `packages/printer/src/transport-attempt.ts`: durable reservation, checkpoints, and reconciliation outcomes around the declaration and acknowledgement port.
- `scripts/physical-dry-run.ts`: strict CLI over receipt JSON and bundle bytes.
- Tests use synthetic verified bundles and inspect real JPEG/PLT bytes and real framed packets.

## Transport-attempt invariants

1. Preflight snapshots the submission, event, worker, execution token, manifest hash, full artifact receipt, immutable profile, and private copies of both output files. The receipt must match the prepared artifact, including its generation. Both files must be nonempty and match their byte counts and SHA-256 digests. Invalid evidence returns `evidence_mismatch` before reservation or any transport call.
2. The journal uses an absolute persistent SQLite file path. It verifies WAL mode, sets `synchronous=FULL`, and enables `fullfsync` on macOS. A reservation enters `declaring` before the port sees any call. Any existing row blocks a reservation, even for a different submission or token.
3. A declaration reply must contain exactly one enumerable own data field, `jobId`, with a positive unsigned 32-bit integer. The journal commits that ID and phase `declared` before upload. A lost declaration response, invalid reply, or failed checkpoint requires reconciliation.
4. For each frame, commit `frame_pending` before calling the port and `frame_acknowledged` after the port acknowledges. Keep the original submission ID and evidence hash on every checkpoint. Advance only after the acknowledgement is durable and the 120 ms pace completes. An uncertain acknowledgement or checkpoint ends the attempt.
5. Restart from `declaring`, `declared`, `frame_pending`, or `frame_acknowledged` holds the prior row. Reopening the same file permits zero further transport calls. Even a fully acknowledged upload ends with `physical_observation_required`. The module cannot write `ready` or release the worker's slot. There is no operator command to clear a held attempt.

Static import tests allow only the enumerated source files, dependencies, and Node built-ins in the transport-attempt bundle graph. The reverse graph check covers the worker, cloud smoke, local simulator, dry-run and proof commands, and read-only bridge entry points.

## Failure behavior

Malformed or mismatched receipts, bytes, profiles, dimensions, padding, pressure, empty masks, oversized JPEGs, off-sheet paths, inconsistent protocol lengths, unsafe output paths, existing destinations, and non-positive job IDs all fail before any packet is published. A process interruption may leave only a separately named incomplete staging directory; it is never accepted as a complete packet.

## Approval boundary

The remaining physical work is a concrete printer transport, observation tied to the declared job ID, and an operator procedure for held attempts. USB access and every printer write require the operator to confirm loaded media and give separate explicit approval at execution time. Upload acknowledgements, global idle, and uncorrelated status codes cannot prove that a sheet printed and cut.
