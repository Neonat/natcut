# Generation and physical QC design

## Goal

NatCut must prove that a trusted print image is sRGB, keep print pixels separate from the cut artifact, compare the encoded JPEG with its canonical preview, and record printer-internal ribbon registration as a separate physical observation. The completed physical attempt remains locked and cannot be resent.

## Scope

This slice changes local artifact preparation, trusted logical artifact metadata, the physical-attempt journal, the local operator page, and their tests and documentation.

It does not deploy resources, access USB, send a printer command, resend the completed attempt, or authorize another physical attempt. The production-hardening branch and its limiter work are outside this branch.

## Existing evidence

The owner reported this result for the completed physical attempt:

- Transport passed.
- Cut alignment passed.
- Kiss cut passed.
- Print quality failed because of printer ribbon registration.
- The attempt is permanently locked. No resend is allowed.

The checked-in owner report is unbound. It contains the reported date, the observed outcomes and the locked disposition. The original journal identity, exact observation time, photo and channel-specific evidence were unavailable. Only the original transport checkpoint can bind this report. [Source observation](../../evidence/physical-attempt-2026-11-28.json)

## Domain split

Software generation QC and physical-print QC answer different questions.

Software generation QC proves that NatCut accepted or converted source pixels to sRGB, composed a canonical sRGB preview, encoded that preview as JPEG, and measured the decoded JPEG against the preview. It can reject color-space ambiguity, a channel swap, a large color drift, an unexpected raster size, or a cut overlay that entered print pixels before transport.

Physical-print QC records what the operator sees after printing. Cyan, magenta, and yellow ribbon-registration artifacts arise inside the printer. Software generation QC does not prevent or diagnose them. A physical QC result never changes the trusted artifact, clears the transport fence, or authorizes a resend.

## Color contract

Every new logical artifact uses format version 2 and carries `colorEvidence`:

```ts
type SourceColorEvidence = {
  sourceSpace: 'srgb' | 'display-p3' | 'cmyk';
  sourceProfileSha256: string | null;
  action: 'preserved' | 'converted';
};

type SrgbColorEvidence = {
  outputSpace: 'srgb';
  pipelineVersion: 'natcut-srgb-v1';
  sources: readonly SourceColorEvidence[];
};
```

`sources` is a nonempty, deduplicated, canonical-order set. Composition forms the union of every layer's source evidence. It does not discard native sRGB evidence or reject a valid composition merely because its layers came from different recognized profiles. The canonical order makes the receipt and its manifest deterministic.

The trusted image boundary accepts a recognized sRGB, Display P3, or CMYK ICC digest or an unambiguous PNG sRGB chunk. It converts recognized non-sRGB input through Sharp to sRGB. It rejects an untagged or ambiguous external image. Packaged catalog artwork is accepted only through the existing digest-addressed import path and records that the catalog importer normalized it to sRGB. A direct import and a reviewed import both preserve their original source evidence in the catalog entry and logical receipt after composition with native branding.

Reviewed packets keep the normalized preview and `sources/<sha256>.png` containing the original tagged candidate. The exported roster pins its source digest and color evidence. Import normalizes the original again and requires the same preview and evidence.

Version 1 receipts and `logical/v1` objects remain readable for historical verification. New encoding emits format version 2 at `logical/v2/<bundleSha256>`. Physical preparation requires a v2 descriptor. A v1 receipt cannot acquire color evidence retroactively.

The canonical preview is the opaque, white-composited, centered, padded, sRGB RGB8 raster that is fed to the JPEG encoder. The visitor DOM preview and the red operator cut overlay are display aids. Neither is the generation QC reference.

## Typed physical outputs

Artifact preparation returns separate roles:

```ts
type PreparedPrintArtifact = {
  kind: 'print-raster-jpeg';
  bytes: Uint8Array;
  sha256: string;
  quality: number;
  preview: CanonicalPrintPreview;
  colorEvidence: SrgbColorEvidence;
  generationQc: GenerationQcResult;
};

type PreparedCutArtifact = {
  kind: 'cut-path-plt';
  bytes: Uint8Array;
  sha256: string;
  sourceMaskSha256: string;
  stats: PltStats;
};

type PreparedPhysicalArtifacts = {
  receipt: ArtifactReceipt;
  profile: Readonly<PrintProfile>;
  print: PreparedPrintArtifact;
  cut: PreparedCutArtifact;
};
```

Only RGBA pixels and color evidence enter the print constructor. Only a binary mask enters the cut constructor. The cut preview consumes already prepared print and cut artifacts and cannot be used as print input. Transport accepts the typed pair and maps it to PLT first and JPEG second.

The arbitrary-PNG proof input was removed. The diagnostic generates independent color and mask arrays. A process-local registry identifies pairs issued by verified preparation. The planner checks membership, roles and digests before constructing the declaration or upload payloads.

## Deterministic generation QC

The JPEG QC implementation decodes the final JPEG through Sharp to sRGB RGB8. It requires the exact canonical preview dimensions. It compares decoded bytes with the canonical preview using integer arithmetic and records:

- The mean absolute error for each channel.
- The 99th percentile of the maximum channel error per pixel.
- The fraction of pixels whose maximum channel error exceeds 32.
- The worst pixel coordinate, expected RGB, actual RGB, and delta.
- Stable reason codes for size, channel, mean error, tail error, and high-error fraction failures.

The result also reports the largest absolute signed channel bias over a 16 × 16 tile, including its position, size, channel and signed error. This detects localized systematic color errors that can pass sheet-wide limits.

| Inclusive `natcut-jpeg-qc-v1` limit | Value |
| --- | ---: |
| Per-channel mean absolute error in thousandths of an RGB8 level | 19,313 |
| Nearest-rank p99 of per-pixel maximum channel error | 96 |
| Fraction of pixels above 32 RGB8 levels in parts per million | 201,249 |
| Worst tile bias in RGB8 levels | 9 |

Five fixtures at nine qualities give 45 independent comparisons. Nine full-sheet cases verify every first-fitting production quality. The measurements cover software encoding only. Swapped channels, gamma-like drift and a localized red contour each fail the calibrated comparison. A lossy JPEG can pass with small pixel differences. [Calibration maxima, margins and diagnostics](../../../packages/printer/test/jpeg-qc-calibration.md)

```sh
npx vitest run --project printer test/qc-calibration.test.ts test/generation-qc.test.ts
```

## Append-only physical records

The existing `transport_attempts` row remains the no-resend fence. No new API may update or delete it.

`PhysicalAttemptOutcome` is an immutable record bound to the existing attempt's evidence hash, submission ID, and printer job ID. Recording requires the attempt to be in `needs_reconciliation` with reason `physical_observation_required`, no pending frame, and every derived PLT and JPEG frame acknowledged. The stored result is:

```ts
type PhysicalAttemptOutcome = {
  recordVersion: 1;
  evidenceHash: string;
  submissionId: string;
  printerJobId: number;
  observedAt: string;
  transport: 'passed';
  cutAlignment: 'passed';
  kissCut: 'passed';
  printQuality: { status: 'failed'; cause: 'printer_ribbon_registration' };
  disposition: 'locked_no_resend';
};
```

The same payload is an idempotent retry. A different payload conflicts and changes nothing.

`RibbonRegistrationQc` is a separate append-only record:

```ts
type PhysicalQcStatus = 'pass' | 'fail' | 'uncertain';

type RibbonRegistrationQc = {
  recordVersion: 1;
  evidenceHash: string;
  recordedAt: string;
  channels: { cyan: PhysicalQcStatus; magenta: PhysicalQcStatus; yellow: PhysicalQcStatus };
  evidence: Array<{ kind: 'photo_reference' | 'operator_note'; reference: string }>;
  notes: string | null;
};
```

The derived overall result is fail if any channel fails, uncertain if no channel fails and at least one is uncertain, and pass otherwise. The known result does not identify a specific channel, so the source evidence records cyan, magenta, and yellow as uncertain until an operator supplies channel evidence.

SQLite migration adds observation tables and lock triggers to an existing transport journal. Each insert reads and verifies the exact transport checkpoint in the same immediate transaction. The first outcome seals the transport row against insert, update, deletion and replacement even from already-open connections. Identical retries return the stored record across restarts and concurrent handles.

## Operator behavior

The operator page reloads the journal evidence and shows `Attempt locked. No resend.` It displays the passed transport and cut checks, the failed print quality with cause `printer ribbon registration`, and a separate CMY physical QC form with pass, fail, and uncertain values plus evidence and notes.

The page states that ribbon registration is printer-internal and is not an image-generation failure. Recording QC cannot call the coordinator, WebUSB client, transport mutation port, or a send route. No reset or resend control is present.

The local API serves `GET /api/physical-proof/evidence`, `POST /api/physical-proof/record-completed` and `POST /api/physical-proof/physical-qc`. The read exposes a frozen safe checkpoint including the derived `fullyUploaded` flag, optional observations and overall CMY status. The execution token and raw transport evidence stay private. The app opens and closes the QC journal per request. Invalid JSON or shape returns 400, conflicting or stale evidence returns 409, and unavailable or corrupt storage returns 503. No default journal is created. The dashboard requires an explicit actual UTC observation time before binding the owner report.

## Safety and verification

Behavioral tests must prove:

- Recognized non-sRGB input is converted with evidence, and ambiguous input is rejected.
- New artifacts carry format version 2 while existing version 1 receipts still verify.
- Mask-only changes leave JPEG bytes and hash unchanged while changing PLT bytes and hash.
- Color-only changes leave PLT bytes and hash unchanged while changing JPEG bytes and hash.
- Overlay pixels, swapped channels, drift, wrong dimensions, and wrong roles fail before transport.
- The deterministic JPEG QC accepts every calibrated codec fallback and produces actionable failure evidence.
- The completed outcome and CMY record survive restart and identical retries.
- Stale or different evidence cannot replace either record.
- The locked attempt remains non-repeatable through direct, browser, refresh, restart, duplicate, and concurrent paths.
- The operator UI restores the locked result and contains no resend path.
