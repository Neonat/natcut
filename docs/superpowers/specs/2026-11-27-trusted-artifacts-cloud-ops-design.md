# Trusted Artifacts and Cloud Operations Design

## Outcome

NatCut will preserve the exact logical color raster and expanded cut mask produced by trusted server code, bind both to an immutable print-profile version, and let later worker code verify those bytes before execution. Cloud operations will gain a narrow, read-only index readiness boundary without changing Hosting or touching production resources.

This design does not define JPEG, PLT, registration, printer commands, or physical recovery. Those remain a separately authorized hardware milestone.

## Decisions

1. `validation.rasterHash` keeps its historic meaning: SHA-256 of the combined expanded cut mask. Existing warning acknowledgements and Firestore records remain valid.
2. A versioned logical bundle contains one fixed-format byte stream: raw row-major RGBA8 followed by the exact row-major binary cut mask. Component hashes identify the color and mask independently; a bundle hash identifies the stored bytes.
3. Object paths are derived locally from the trusted bundle hash. Firestore will never supply an arbitrary path to a worker.
4. Print profiles are resolved from an immutable `(id, version)` registry. Published profile entries are never edited; changes create a new version.
5. The first tranche uses a create-only local artifact store with bounded, verified reads. It proves the artifact contract without pretending that local files are accepted cloud evidence.
6. New acceptances publish a create-only object, verify the returned generation and then commit its receipt with the submission, counter and idempotency binding in one Firestore transaction.
7. Version 2 records require an artifact receipt. Unversioned records remain readable as legacy records. An unknown version or inconsistent receipt fails decoding.
8. Worker execution and completion are separate token-fenced transactions. Completion stores immutable evidence and releases the slot only from the exact current `printing` execution. No uncertain physical outcome may be retried automatically.
9. `firebase.json` stays Hosting-only. A pure offline checker validates the checked-in index specification and an explicitly supplied named-database inventory. It performs no deployment or account access.

## Logical bundle V1

The payload is:

```text
[width * height * 4 bytes RGBA8][width * height bytes binary mask]
```

Both spans use top-left origin and row-major ordering. RGBA bytes are exactly the output of `renderServerRaster`. Mask bytes are exactly the combined expanded mask already used to compute `validation.rasterHash`; valid values are `0` and `255`.

The strict descriptor records:

- format version `1`;
- width and height;
- color byte length and SHA-256;
- mask byte length and SHA-256;
- total byte length and SHA-256;
- render and geometry versions;
- complete immutable profile snapshot and canonical profile SHA-256.

Decoding validates the profile first, derives exact lengths with overflow-safe arithmetic, bounds allocation, verifies every digest, rejects surplus or missing bytes, and rejects non-binary mask bytes.

## First tranche boundaries

The submission preparation function resolves one profile, plans and renders once, computes masks once, and returns the raster, combined mask, contours, geometry report, profile, and logical bundle. A color-only pixel change must change the color and bundle hashes without changing the mask hash. The browser cannot supply or override any trusted artifact field.

The local store requires a stable, non-symlinked root owned by the process user with no group or world permissions. Its parent path is a deployment precondition. It writes to a temporary file using exclusive creation and publishes it through a non-clobbering same-directory hard link into a content-addressed location. Duplicate publication verifies and reuses identical bytes. Interrupted temporary files are never readable as complete artifacts. Reads are size-bounded and rehash the returned bytes.

The index checker accepts plain JSON inputs, requires project `sprout-dev-66f08`, database `natcut`, and the two exact ascending `submissions` indexes. It reports missing, building, or ready state. It cannot invoke Firebase or Google Cloud commands.

## Atomic acceptance

A new requeue request checks its source before preparation or publication and checks again inside the acceptance transaction. Queue counts read the public status of each matching ticket. Full receipt decoding applies to the requested ticket or requeue source.

The submission API allows 30 seconds for storage publication. Each GCS HTTP request has a 15-second deadline. The publisher uses the Admin bucket's credentials and abortable HTTP requests for create-only multipart uploads, metadata and pinned media. The route cancels publication at its deadline and returns HTTP 503. A late completion can leave a reusable object and cannot allocate a ticket.

An authenticated retry first looks up the owner, event and idempotency key. Its canonical manifest hash and requeue source must match the binding. A hit returns the accepted ticket and token even during a rendering or storage outage. A miss prepares one bundle, checks any warning acknowledgement against the expanded mask hash, publishes and then enters the queue transaction. The transaction repeats the binding check to resolve concurrent requests and requires a cancelled requeue source owned by the same visitor in the same event.

The private bucket selection is fixed to `NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts`. The object key is `logical/v1/<bundleSha256>`. GCS creation uses `ifGenerationMatch=0`. Verification reads only the pinned decimal-string generation and compares its bytes with the locally verified payload within the profile-derived size limit. Firestore stores `recordVersion: 2` and `artifact: { descriptor, generation }`. The storage path is derived from the digest. Storage failure returns HTTP 503 before ticket allocation. An upload followed by a lost Firestore race or failure may leave a reusable immutable object.

The local emulator runtime uses its private local create-only store, whose sole generation is `1`. Session 2 later verified production bucket ownership, runtime storage IAM, end-to-end create-only GCS behavior, and the verification-capable simulated worker rollout. Autonomous queue consumption remains stopped outside an explicitly supervised smoke or rehearsal.

## Worker artifact verification

The simulator validates each new or recovered V2 submission and recomputes its canonical manifest hash. Its read-only storage adapter requests the receipt's exact generation at the digest-derived path. The cloud request has a 15-second deadline and the worker verification attempt has a 30-second deadline. The worker retains the cloud slot during a retryable storage failure. Missing, inconsistent, unsupported or legacy evidence leaves the head held for reconciliation.

The worker journals the event, receipt, logical bytes, component and bundle hashes, verification time and immutable profile snapshot in one SQLite insert. Migration preserves historical rows and leaves their new evidence columns null. Recovery compares the journal to freshly verified cloud evidence. Immediately before simulation the worker rehashes the local payload against the prepared receipt under its execution guard. The cloud begin transaction rejects any prior execution/completion metadata, compares the receipt, validation and canonical manifest identity again, and stores that exact evidence in the execution lease before marking the ticket printing.

## Completion fencing and reconciliation

The worker has no generic ready/status writer and no terminal-status acknowledgement shortcut. Its only completion operation carries the submission ID, event ID, worker ID, durable execution token, canonical manifest hash, complete geometry validation, and exact artifact receipt including generation and immutable print-profile snapshot.

The Firestore completion transaction advances `printing` to `ready` only when all of that evidence matches the current V2 submission, its recomputed manifest hash, the evidence captured by its execution lease, and the event's active worker slot. It also rejects malformed completion timestamps. In the same transaction it stores a `completionFence` containing that evidence and deletes the slot. Any missing, malformed, stale-worker, stale-token, different-generation, different-profile, or different-validation evidence returns `fenced` without changing the submission or slot.

Completion is idempotent across a committed write whose response was lost. An identical retry against `ready` or `collected` returns `confirmed` only when the stored submission identity and `completionFence` still match and the completed submission no longer owns the event slot. The slot must be absent or a complete, valid slot for a different submission. The retry does not rewrite timestamps or delete another execution's slot. Different evidence is fenced.

The SQLite outbox and verified journal are the durable retry boundary. A transport failure returns `waiting_for_cloud` and leaves the exact ready intent pending; it is never reported as completed. Only a committed or confirmed completion atomically clears that intent and records `completionAcknowledgedAt` against the same local ready transition. A `fenced` result, malformed or legacy outbox entry, an outbox entry without a V2 journal, missing event or token evidence, a recovered printing lease with a different token, a crash after begin but before its local phase commit, an executor that returns without ready, or a restart from a simulated physical phase enters `needs_reconciliation`.

Unacknowledged local work and artifact holds block every later cloud claim even if the cloud slot is missing. Ready-intent recovery is serialized by the same SQLite execution guard as simulation, so a stale worker cannot rewrite an active executor's journal. The operator desk adds local blocker rows even when the corresponding cloud ticket is collected or missing from the paginated queue. Safe pre-begin phases may resume only while cloud state remains `next`; local execution is never inferred from a terminal public status alone.

## Authorized cloud rollout evidence

Session 2 completed the cloud-only tranche without USB or printer access. It verified both named-database indexes as `READY`, provisioned the private regional NatCut artifact bucket with public-access prevention and narrow create/read runtime IAM, and proved create-only upload plus exact-generation reads as both runtime identities. It built the artifact-bearing API from commit `eff8650`, deployed immutable image digest `sha256:8ee819866f4cff9c59c70b7c676cd07b26f37e775368e94554216f0105a5266b`, and pinned the isolated `natcut` Hosting site to healthy revision `natcut-submission-00004-vrh`.

One immutable V2 smoke ticket was accepted, its receipt and 12,600,000 logical bytes were verified at the pinned generation, and `SimulatedPrinter` completed it through the exact execution and completion fences. The local journal acknowledged the same completion with no pending outbox or reconciliation hold. A target-locked Hosting rollback to the recorded baseline and restoration to the candidate both passed while the default Sprout site remained HTTP 404.

Post-rollout review hardened repeatability: the submission smoke now allowlists the exact Firebase web-app key before signup, persists non-secret attempt identity before POST, recovers lost responses without creating another ticket, and compares the requested and stored canonical manifest hashes. A dedicated bounded worker smoke checks the expected submission ID inside claim and recovery transactions and exits after that ticket's acknowledgement or hold, so it cannot consume an unrelated visitor ticket.

This evidence establishes isolated cloud readiness for the verified logical bundle and simulator. It is not evidence of JPEG, PLT, registration, USB protocol, media loading, physical print/cut behavior, event load, or production hardening.

## Offline physical-adapter evidence

Session 3's non-printer tranche now re-verifies an exact receipt and bundle before deriving the physical files. The JPEG path white-composites the logical 1200 × 2100 RGBA raster, centers it in the immutable 1216 × 2128 printer raster, and selects the first fixed quality no larger than 1 MiB. The PLT path traces the stored expanded binary mask with no second dilation, preserves the profile's `KP42`, and rejects empty or off-sheet paths.

The dry-run packet records the combo declaration, file sizes and hashes, PLT-first upload order, and 4071-byte payload chunks. It documents the little-endian positive job-ID field, per-frame acknowledgement, and 120 ms pacing. The create-only packet uses an incomplete sentinel and records `transport: disabled-dry-run` without a job ID.

The separate transport-attempt module exercises declaration and upload through a mock port. An absolute-path SQLite WAL journal commits the exact submission and artifact evidence before declaration. The attempt commits the returned job ID before upload and checkpoints each frame intent and acknowledgement. Any existing row blocks new attempts on that journal after restart. A fully acknowledged upload requires physical observation and cannot advance cloud status. The module has no concrete printer transport or worker wiring. See the [physical adapter proof design](2026-11-28-physical-adapter-proof-design.md) for the exact invariants.

## Remaining tranches

1. Add a concrete printer transport and verify device acceptance and job-specific physical evidence. USB access and one loaded-sheet printer write require separate explicit approval at execution time.
2. Define an operator-authorized resolution procedure for held physical attempts once job-specific printer evidence is available. Public status alone cannot prove fulfillment.
3. Rehearse the full booth path and failure injection only after the physical adapter proof.
4. Complete production hardening, retention/privacy decisions, observability, cost controls, and final release audit after rehearsal.

## Safety and rollout invariants

- Static import checks keep concrete printer and cloud I/O outside the transport-attempt module and keep the module outside the worker and existing printer CLI entry points.
- Production cloud changes are restricted to the authorized isolated NatCut resources and are recorded in the cloud runbook; Sprout resources remain unchanged.
- An accepted queue record must never point at an unverified or incomplete object.
- A digest mismatch is corruption, not a reason to regenerate accepted evidence.
- Only the exact printing execution may publish ready and release its event slot.
- An identical completion retry may confirm ready or collected; stale or different evidence never releases a slot.
- Ambiguous local/cloud outcomes hold the queue head for operator reconciliation.
- Old mask hashes are never relabelled as color hashes.
- Emulator success is not evidence that a production composite index is ready.
- Existing Sprout Hosting, databases, and other resources remain out of scope.
