# Sprite quality review design

## Intent

Give the booth operator a private, offline way to compare generated canonical sprite candidates with real plant photos before importing the approved artwork into NatCut. The tool addresses the current quality problem: only about one in ten generated sprites is cute enough.

## Goals

- Show the common name above the scientific name.
- Keep each real plant photo visible beside its generated candidates.
- Record 1–5 cuteness and plant-accuracy scores for each candidate.
- Require one approved candidate per plant before export.
- Preserve review progress in the browser.
- Export the exact roster shape accepted by `npm run sprites:import`.
- Work without Firebase, AI providers, or printer access.

## Non-goals

- Generate sprites or expressions.
- Review the eight expression variants.
- Publish artwork to Firebase.
- Replace the content-addressed catalog importer.
- Expose the review page to visitors.

## Input and output

The input is a local JSON manifest. Each row has a common name, an optional scientific name, one reference image, and one or more PNG candidates. Paths are relative to the manifest.

The command copies normalized review assets into a new output directory and writes `index.html`. The page stores scores and selections under a manifest-derived local-storage key. Export downloads `roster.json` with one selected PNG filename per plant. The operator places that file in the packet directory and passes it to the existing importer.

The command never overwrites an existing output directory. It validates every path and image before publishing the packet.

## Interaction

The page is a compact desktop-first review board that also works on a phone. A plant section keeps its reference image and candidate grid together. Each candidate has visible cuteness and accuracy controls plus one **Approve sprite** control. Selecting another candidate for the same plant replaces the earlier choice.

A persistent summary shows approved plants out of the total. **Export roster** stays disabled until every plant has one approved candidate. Keyboard focus, selected state, and validation errors remain visible without relying on color alone.

## Approaches

1. **Static offline review packet. Selected.** It adds no account, database, or deployment. The operator can review the full batch on the event Mac and feed the result into the existing importer.
2. **CSV score sheet. Rejected.** It cannot keep visual comparison and selection together, which makes repeated review slower and more error-prone.
3. **Firebase review application. Rejected.** Cloud persistence and auth add cost and deployment risk to a private, single-operator task.

## Constraints

- Node 24.
- Input files stay outside the repository.
- Only PNG candidates can enter the import roster.
- The page uses **sprite**, never “Plantemon.”
- The packet contains no remote fonts, scripts, or analytics.
- No provider, Firebase, or printer call is allowed.

