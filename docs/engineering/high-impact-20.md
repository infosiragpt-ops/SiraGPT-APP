# Reliability improvements for /agentes

This delivery implements the ten frontend and ten backend improvements authorized after the product audit. It preserves the canonical `/agentes` surface and the user's selected model. It does not change credentials, DNS, the production origin, or the publisher's schema gate.

## Frontend

| ID | Improvement | Main implementation |
| --- | --- | --- |
| F1 | Preserve explicit model selection during catalog refresh; serialize saves with confirmation and rollback | `catalog-model.ts`, `model-selection-writer.ts`, chat context/composer |
| F2 | Bound OCR pixel allocation and concurrency; reuse work for the same file | `ocr-budget.ts`, `ocr-preprocess.ts` |
| F3 | Resume uploads by verified owner and chunk hashes; replay completion without duplicate File rows | `chunked-upload.ts`, API client, chunk store and file routes |
| F4 | Never evict accepted composer queue entries; retain drafts/files when persistence fails | `composer-queue.ts`, composer |
| F5 | Persist `/goal` turns, recover after reload, honor selected model, and acknowledge Stop | `use-research-goal.ts`, research client, research coordinator/routes |
| F6 | Execute `/summarize` against attachments or the latest useful message | `summarize-command.ts`, composer |
| F7 | Share file-status requests; batch at most 50 IDs, pause hidden/offline, invalidate on retry | `use-file-processing-status.ts` |
| F8 | Recover stale bundles once, flushing the current draft before reload | error boundary, bundle recovery, draft hook |
| F9 | Load optional message renderers and research workbench on demand | message component, composer dynamic imports |
| F10 | Remove duplicate file dialog; accessible expanded table with Escape/focus restoration | expanded table dialog, table controls, message component |

## Backend

| ID | Improvement | Main implementation |
| --- | --- | --- |
| B1 | Atomically reserve/settle media quota under a user row lock, respecting quota epochs and partial results | media job store |
| B2 | Durable video/voice jobs with leases, checkpoints, fencing and restart recovery | media worker, video runner, durable voice queue |
| B3 | Replay explicit idempotency keys without repeating provider submissions; independent identical turns remain distinct | media admission, one-shot provider submission |
| B4 | Separate commercial units from provider tokens; unknown costs are nullable and pricing has provenance | pricing, media settlement, nullable ApiUsage cost |
| B5 | Acknowledge compositor image admission with HTTP 202, poll the durable job and persist cancellation | AI route, image-job client, image status/cancel routes |
| B6 | Incremental bounded Redis SSE storage and absolute replay cursors with resync | stream-resume service and AI route |
| B7 | Buffered asynchronous task snapshots with explicit durable barriers before terminal acknowledgement | task-store writer and callers |
| B8 | Durable webhook outbox with bounded concurrency, retries and lease fencing | outbox, dispatcher, trigger registry |
| B9 | Bounded, abortable media streaming with backpressure and partial-file cleanup | transfer utilities and media callers |
| B10 | Execute populated BASE-to-HEAD migrations, preserve data/constraints/history, reject new schema drift | migration safety/upgrade scripts and required CI job |

## Verification and limits

Behavioral tests cover model-save races, queue persistence, upload resume/cancel, image admission/Stop, OCR limits, shared polling, research recovery and modal focus. Database tests use an isolated loopback PostgreSQL with synthetic records; no production database or paid model provider is used. CI additionally exercises real Redis replay.

The migration rehearsal exposes inherited drift instead of hiding it with `db push`. Its populated fixtures check preservation, constraints, idempotent deploy and absence of new drift; this is not a production-volume lock test or a rollback rehearsal. See [migration upgrade gate](migration-upgrade-gate.md).

Important boundaries:

- The legacy `/api/images/jobs` generation endpoint retains its existing inline execution/credit ledger. HTTP 202 admission applies to the compositor `/api/ai/generate-image` flow.
- A provider acceptance outcome that cannot be proven is terminal `unknown`; the worker does not automatically resubmit and risk a second charge.
- Research results survive reload and can finalize a saved result after process loss. Interrupted research stages are reported as interrupted, not silently re-executed. Research/upload files require the existing persistent shared volume.
- Buffered task progress can be lost on SIGKILL before a flush; creation, checkpoints and terminal barriers await durable writes.
- Webhook delivery is at-least-once; receivers deduplicate `X-SiraGPT-Delivery`. File-backed task terminal state and SQL outbox enqueue are not one atomic transaction.
- SSE fallback without Redis is process-local. A cursor outside the retained window explicitly requires resync.

## Production release gate

Two additive migrations create media jobs/events and webhook deliveries, and allow unknown API usage cost. Existing migration bytes are preserved. The media migration does **not** mark legacy running voice jobs failed: release preparation must drain them before switching workers.

`deploy/iliagpt/publish-reviewed.sh` refuses schema/migration changes. That guard is unchanged. A successful PR CI run does not authorize bypassing it. Deployment needs a separately reviewed database release with exact SQL, a verified backup/restore, legacy-worker drain, compatible application rollback and Lenovo SHA/readiness proof. This document does not claim those production steps have happened.
