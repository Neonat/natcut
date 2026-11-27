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
8. Worker execution, token-fenced finish writes, operator holds, and simulation-only reconciliation form a later migration-tested tranche. No uncertain operation may be retried automatically.
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

The local emulator runtime uses its private local create-only store, whose sole generation is `1`. Production bucket ownership, storage IAM, end-to-end GCS behavior and readiness remain unverified. Stop all old workers before deploying an artifact-bearing submission API. Queue consumption requires a separately verified worker rollout.

## Later tranches

1. Verify the production bucket, IAM and pinned upload/read behavior during an authorized storage smoke.
2. Add worker verification before the execution fence. Unknown, corrupt, missing, or legacy active artifacts hold the queue head visibly.
3. Narrow begin/finish cloud writes around event, slot, claim, and execution token. Migrate SQLite additively without reinterpreting historic hash columns.
4. Run one clearly labelled simulator scheduler with a loopback operator desk. Add a simulation-only terminal reconciliation decision only after finish-versus-close and crash recovery tests pass.
5. After explicit authorization, provision IAM and indexes, verify production readiness, and deploy. Physical artifact generation and USB execution remain separate.

## Safety and rollout invariants

- No printer or USB code is imported or invoked by this slice.
- No production resource is created, changed, or deleted.
- An accepted queue record must never point at an unverified or incomplete object.
- A digest mismatch is corruption, not a reason to regenerate accepted evidence.
- Old mask hashes are never relabelled as color hashes.
- Emulator success is not evidence that a production composite index is ready.
- Existing Sprout Hosting, databases, and other resources remain out of scope.
