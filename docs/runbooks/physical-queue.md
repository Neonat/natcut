# Mac physical queue handoff

The cloud submission service only queues immutable jobs. On the booth Mac, use the one-shot physical worker for one named submission after confirming a fresh 4×7 sheet is loaded and reviewing the offline JPEG and PLT. Never use `worker:cloud:sim` for a live order: it advances statuses with no physical printer.

Set these variables to the production NatCut resources and durable local files. Keep the same worker ID and paths when recovering this ticket. Give each new ticket a fresh `NATCUT_SQLITE_PATH`; a prior ticket's journal must never be reused for a new physical send:

```sh
export NATCUT_PROJECT_ID=sprout-dev-66f08
export NATCUT_DATABASE_ID=natcut
export NATCUT_ARTIFACT_BUCKET=sprout-dev-66f08-natcut-artifacts
export NATCUT_WORKER_ID=devfest-macbook
export NATCUT_SQLITE_PATH="$HOME/Library/Application Support/NatCut/queue-<exact-id>.sqlite"
export NATCUT_PHYSICAL_JOURNAL_DIR="$HOME/Library/Application Support/NatCut/physical-attempts"
```

`npm run worker:cloud:physical -- --action send --submission <exact-id> --bundle <sha256> --jpeg <sha256> --plt <sha256> --confirm 'SEND ONE SHEET'` claims only the expected queue head, rereads the pinned GCS generation, verifies the local artifact and output hashes, checks the PixCut is idle or asleep/idle with no alert or active job, and obtains the exact cloud execution lease before the first USB write. The transfer journal reserves one attempt before declaration and checkpoints every frame. A second invocation cannot resend the same job.

After a fully acknowledged upload, the ticket stays `printing`. Inspect the ejected sheet for colour and ribbon registration, cut alignment, and clean peeling. Only after all pass, run `npm run worker:cloud:physical -- --action complete` with the same four identity/hash arguments and `--confirm 'PASS COLOR CUT PEEL'`. This records a durable physical pass and publishes the exact fenced `ready` transition. The completion action never opens USB and can safely retry a lost cloud response.

If transfer acknowledgement, printer state, or physical quality is uncertain, stop. Preserve both SQLite files and the sheet; do not rerun `send`. The ticket and worker slot remain held for operator reconciliation. No automatic polling or next-ticket claim occurs in this command.
