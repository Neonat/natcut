# NatCut plant-job adapter boundary

Status: offline adapter slice; no live route or deployment.

NatCut calls the private Sprout Cloud Run origin with an injectable OIDC ID-token provider whose audience is that exact origin. The v1 client sends JSON with raw `sanitizedImageBase64`, the source-photo SHA-256 and receipt, and `Idempotency-Key: generationIntentId`. It parses allowlisted create, status and outcome responses. Candidate bytes come from the authenticated same-service candidate endpoint and must match the status media type, declared length and SHA-256 before trusted sprite normalization.

`natcutPlantFlows` is NatCut-owned state. A Firestore transaction binds one event, visitor session and capture to an immutable intent ID, request fingerprint, fallback asset and absolute deadline. The sanitized photo bytes and provider details are not stored in this record. A lost create response can be retried with the original intent and deadline; a changed photo or policy with the same capture conflicts. A second transaction binds the Sprout job ID once. A final transaction commits the first local outcome. The visitor receives that local outcome immediately with a pending Sprout acknowledgement. A separate `syncOutcome` call sends the exact decision and records confirmed or reconciliation state; a lost response can be retried. The local outcome remains fixed when Sprout acknowledges late or ambiguously.

The local deadline starts with the confirmed photo intent and is capped by both the persisted UTC deadline and a process-local monotonic clock. Retrying a create or polling from another process cannot extend the persisted deadline. Status reads are bounded by the remaining wait. At 15 seconds without an on-time candidate, NatCut commits the selected approved catalog fallback only after Sprout has confirmed generation eligibility. A candidate NatCut durably observes before that deadline remains available for the visitor to preview and choose afterward; the generated outcome records `candidate_ready_before_deadline`. A candidate first observed later never changes a fallback decision. Below-threshold identification keeps its suggestions for retake or manual selection; it never auto-accepts fallback. Unknown or contradictory eligibility enters reconciliation. The operator may explicitly accept the catalog fallback from a valid review state. The coordinator does not create a print submission or reserve a printer slot.

The generated-candidate path depends on `TrustedCandidateRegistrar`. Its adapter runs the merged `normalizeSpritePng` boundary after verifying fetched bytes. The runtime writer re-normalizes the exact source PNG and checks the source digest, byte length, normalized PNG and colour evidence before staging. It creates a content-addressed object under `runtime-sprites/v1/` with an if-absent generation precondition, reads that exact generation back, and records a strict receipt in NatCut Firestore. The receipt binds the flow, Sprout job and candidate, Sprout object generation, source digest, normalized PNG digest and byte length, colour evidence, NatCut object path and exact generation. A lost upload response is recovered only when the pinned existing bytes match.

Staging remains private and unlisted, including when it finishes after a fallback wins. An exact retry after generated acceptance rechecks the existing receipt and pinned bytes without publishing again; a fallback or different candidate cannot reuse it. `runtime-catalog-v1` preparation requires the matching local `generated_accepted` decision and a confirmed Sprout acknowledgement, then rechecks the receipt identity and exact object generation before decoding through the merged trusted sRGB boundary. The old `catalog-v1` path still rejects runtime IDs. The existing public submission route uses only that old path and rejects runtime recipes before idempotency lookup.

The optional authenticated plant routes accept only a capture ID and an approved catalog fallback from the browser. A server-owned `PlantCaptureSource` resolves the confirmed capture for the authenticated Firebase UID and event, returning the sanitized tagged image bytes, exact SHA-256, dimensions, colour evidence and stable visitor session. NatCut rechecks the digest, media type, dimensions, trusted sRGB decode, and absence of EXIF/XMP/IPTC, JPEG app metadata and PNG ancillary metadata before creating a Sprout intent. Poll, acceptance and submission calls resolve ownership again; no browser-supplied photo bytes, receipt, policy version or session ID are trusted. The new runtime submission route uses the accepted flow's pinned runtime preparer, the same geometry and artifact publication gates as static submissions, and a capture-scoped idempotency key. It creates no queue ticket before generated acceptance and confirmed Sprout acknowledgement. On a lost submission response, a read-only acceptance and receipt check permits recovery of the existing ticket even if pinned object storage is temporarily unavailable; new tickets still require a full pinned read. A fallback continues through the existing static catalog route.

These optional routes are exercised with mocks and Firestore emulator, but the production Cloud Run constructor does not register them yet. The plant capture source, private Sprout service URL and OIDC token provider still require reviewed production wiring. The runtime object and receipt must be retained until the submission's physical lifecycle and reconciliation finish.

The source-photo receipt is distinct from NatCut's logical print artifact. It proves only the sanitized input supplied to Sprout. The existing portrait contracts are independent. No provider credential or private Sprout object path enters the visitor response.

## Remaining integration gates

The phone upload is `POST /api/v1/plant-captures` with a Firebase bearer token and JSON
`{captureId,imageBase64}`. The client keeps its generated capture ID across retries.
NatCut normalizes JPEG, PNG or WEBP input to a tagged sRGB JPEG, strips private metadata,
pins the exact private object generation, and records an owner-scoped receipt in
`natcutPlantCaptures`. The upload reply is `{captureId,status:"confirmed"}`.
Cloud Run registers capture upload by default. It registers plant jobs only when both
`SPROUT_PRIVATE_SERVICE_URL` and `SPROUT_POLICY_VERSION` are configured. The former
must be a private HTTPS origin. `SPROUT_REFERENCE_SET_ID` is optional. A confirmed,
owner-scoped generated sprite can be fetched with the same Firebase bearer token at
`GET /api/v1/plant-jobs/:captureId/accepted-sprite`; it is unavailable before Sprout
acknowledges the immutable acceptance. The visitor should fetch its bytes and create
a local object URL for preview.
Before choosing generated artwork, the visitor can fetch
`GET /api/v1/plant-jobs/:captureId/candidates/:candidateId` with the same bearer token.
NatCut checks capture ownership, active flow and candidate identity, downloads through
the private Sprout client with its digest and length checks, and returns a normalized
sRGB PNG. This preview neither accepts nor stages a candidate and closes at the
live deadline. If the visitor chooses the catalog while a candidate is available,
the fallback reason is recorded as `operator_fallback`.

- Wire an authenticated NatCut visitor endpoint after the phone capture lane supplies a stable sanitized photo receipt and ownership check.
- Supply a reviewed private plant capture source with owner checks and immutable sanitized receipt; the portrait capture records are separate.
- Wire the optional authenticated plant routes, runtime writer/loader and OIDC Sprout client into NatCut Cloud Run after service IAM, retention and event limits are reviewed.
- Wire the OIDC token provider, private service URL, Firestore repository and Sprout service contract after both lanes pass review.
- Set rollout controls and retention/privacy policy before deployment. No paid provider call or printer action is part of this adapter slice.
