# File processing state machine

Single source of truth for the per-`File` row processing pipeline.
Every uploaded file moves through a finite, persisted state machine
written to PostgreSQL on every transition, mirrored to a structured
pino log line, and surfaced to the chat UI through a polling endpoint
so the user always knows exactly where their document is.

This is the substrate behind the visible chip badges
("Validando" / "Extrayendo texto" / "Indexando" / "Listo" /
"Error: …") and the `event:'file_processing_stage'` audit log line.
It is *not* RAG retrieval, *not* the chat pipeline, *not* the agentic
runtime — those flows live next door (see `PIPELINE.md`) and consume
the `ready` state but do not write into it.

---

## 1. Stages

```
uploaded ──► validating ──► extracting ──► chunking ──► embedding ──► indexing ──► ready
    │            │              │              │            │            │
    └────────────┴──────────────┴──────────────┴────────────┴────────────┴──► failed
```

| Stage | Owner | Definition | Typical duration |
|-------|-------|------------|------------------|
| `uploaded` | upload route | Multer accepted bytes; `File` row exists. | <50 ms |
| `validating` | upload route | Magic-byte sniffer (`file-type`) is checking the real content type against `ALLOWED_MIMES`. | <100 ms |
| `extracting` | upload route | `fileProcessor.processFile(file)` is running (mammoth / pdf-parse / xlsx / jszip / Tesseract OCR). Stays here until extraction returns and the row's `extractedText` is updated. | 0.1 – 30 s depending on format and OCR |
| `chunking` | RAG worker | `setImmediate`-queued split of `extractedText` into chunks for `operationalRag.ensureIndexed`. | <1 s |
| `embedding` | RAG worker | OpenAI embeddings call for each chunk. | 1 – 10 s for typical docs |
| `indexing` | RAG worker | Vector-store write of the embeddings. | <1 s |
| `ready` | RAG worker | All indexing finished; the document is queryable end-to-end. **Terminal — happy path.** | — |
| `failed` | any owner | Any throw inside the pipeline. `processingError` carries the stage-prefixed reason. **Terminal — sad path.** | — |

The state machine is **monotonic**: a row never goes backwards. If the
row is in `embedding` and a new turn references it, callers read the
current stage; they never reset it to an earlier stage. Re-processing
a file (re-upload) creates a *new* `File` row.

---

## 2. Schema (`backend/prisma/schema.prisma`)

```prisma
model File {
  // … existing columns …
  processingStage     String?     // one of the stages above; null on legacy rows
  processingError     String?     // stage-prefixed reason when stage='failed'
  processingStageAt   DateTime?   // timestamp of the latest transition
}
```

All three columns are **nullable** so existing rows continue to load
without a backfill. The frontend treats `processingStage IS NULL` as
"legacy / pre-state-machine" and displays the file as ready — that
matches the de facto state of every row that already shipped before
this machine landed.

---

## 3. Single writer (`backend/src/services/file-processing-status.js`)

Every transition flows through one function:

```js
await fileProcessingStatus.setStage(prisma, fileId, stage, {
  userId,                       // for the audit log
  error: 'rag_indexing: …',     // required when stage === 'failed'
});
```

Contract:

- `STAGES` is the canonical ordered list; `TERMINAL_STAGES` is `Set('ready','failed')`.
- Unknown stages are rejected with `console.error` and a `false` return — they never write.
- `processingError` is **truncated to 1000 characters** so an absurd stack trace can't overflow the column.
- On **non-failed** transitions the error column is **explicitly cleared** so a row that recovered from a transient blip doesn't carry a stale error.
- A DB write failure (row vanished, column missing in a partially migrated env) is **caught and logged**, not thrown. The pipeline keeps moving.
- A structured pino log line is **always** emitted, even when the DB write fails:

  ```
  [file-status] {"event":"file_processing_stage","file_id":"…","user_id":"…","stage":"embedding","error":null,"written":true,"ts":"…"}
  ```

  This is the same shape that `request_id` middleware emits, so the
  audit trail joins cleanly on `file_id` + `request_id`.

The single-writer rule is enforced by **convention only** — there is
no DB trigger or check constraint stopping a future caller from
writing the columns directly. If you find yourself reaching for
`prisma.file.update` with `processingStage` in the data, route it
through `setStage` instead.

---

## 4. Stage transition map (call sites in production)

| Stage written | Caller | When |
|---------------|--------|------|
| `uploaded` | `routes/files.js` POST `/upload` (loop entry) | Right after `prisma.file.create` |
| `validating` | `routes/files.js` | Before `detectMime(...)` |
| `failed` (`magic_byte_mismatch: …`) | `routes/files.js` | When detected mime is not in `ALLOWED_MIMES` |
| `extracting` | `routes/files.js` | After magic-byte check passes, before `fileProcessor.processFile` |
| `failed` (`processing: …`) | `routes/files.js` catch block | Any throw inside the upload loop after the row was created |
| `chunking` | `scheduleDefaultRagIndex` (setImmediate entry) | Async path begins |
| `embedding` | `scheduleDefaultRagIndex` | Before `operationalRag.ensureIndexed` |
| `indexing` | `scheduleDefaultRagIndex` | After `ensureIndexed` succeeds |
| `ready` | `scheduleDefaultRagIndex` | Terminal happy path; or shortcut for files with no docs to index (raw images) |
| `failed` (`rag_indexing: …`) | `scheduleDefaultRagIndex` catch | Any throw inside the RAG path |

---

## 5. Read API (`GET /api/files/:id/processing-status`)

Auth-gated, owner-only polling endpoint:

```json
{
  "fileId":      "cm0xy12…",
  "name":        "contract.docx",
  "mimeType":    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "size":        12345,
  "stage":       "embedding",
  "error":       null,
  "stageAt":     "2026-04-30T05:14:22.401Z",
  "isTerminal":  false,
  "createdAt":   "2026-04-30T05:14:18.077Z"
}
```

Status codes:
- `200` — row found, payload as above.
- `403` — caller is authenticated but not the owner of this `File`.
- `404` — row does not exist.

`isTerminal` lets the frontend stop polling without hard-coding the
stage list.

---

## 6. Frontend consumer (`hooks/use-file-processing-status.ts`)

`useFileProcessingStatus(fileId)` polls the read API every 2 s while
the stage is non-terminal, with a **120-poll ceiling** (4 min) so a
wedged worker can't keep the page polling forever. The hook is
defensively tolerant: a 404 (legacy row), a 401/403 (auth blip), or
a transient network error all leave the hook idle without throwing
into the React tree.

`describeStage(stage, error)` is the single source of vocabulary for
every surface that renders state — chip in the composer, chip in the
sent message, future admin panel — they all share these strings:

| Stage | Label | Tone |
|-------|-------|------|
| `uploaded`   | "Subido"               | progress |
| `validating` | "Validando"            | progress |
| `extracting` | "Extrayendo texto"     | progress |
| `chunking`   | "Fragmentando"         | progress |
| `embedding`  | "Indexando"            | progress |
| `indexing`   | "Indexando"            | progress |
| `ready`      | "Listo"                | success  |
| `failed`     | error message verbatim | error    |

The `FileProcessingBadge` component hides itself when `stage === 'ready'`
or when there is no `fileId` yet, so a fully-processed file's chip
stays visually quiet — only progress and failure earn screen real estate.

---

## 7. Error reasons (for support / triage)

`processingError` always carries a **stage-prefixed** reason so the
on-call engineer can tell at a glance which sub-system tripped:

| Prefix | Stage | What probably broke |
|--------|-------|---------------------|
| `magic_byte_mismatch: <real mime>` | `validating` | Renamed binary; allowlist rejected the real content type |
| `processing: <err.message>` | `extracting` | Parser library threw (corrupt DOCX, bad ZIP, OCR timeout) |
| `rag_indexing: <err.message>` | RAG path | Embeddings call failed, vector store unreachable, etc. |

The frontend renders the prefix verbatim in the red error chip; do
**not** pretty-print it on the way to the user — the prefix is the
fastest signal a support ticket can carry.

---

## 8. What this state machine does NOT cover

- The chat-pipeline state machine — see `PIPELINE.md`.
- The agentic-task lifecycle (queued / worker_started / worker_finished)
  — see the BullMQ events emitted by `agent-task-runner`.
- Cost / token accounting per turn — see the LLM observability layer.
- Conversation-level state — see the storage adapters.

If you need a state for any of those, add it to the right state
machine, not this one. Coupling will hurt later.

---

## 9. Migration history

`db push`-driven (no migration files yet). The columns landed in
`eeb6ede` (Phase 2.1, schema + service + endpoint), got their
frontend consumer in `de854d8` (Phase 2.2, hook + badge), gained
pre-row coverage in `5d59401` (Phase 2.3, the `uploaded` /
`validating` / `extracting` window), and started rendering on the
sent-message chip in `762e452` (Phase 2.4).

When the team adopts a migration history, this is the first set of
columns that should ship as a real `migrate deploy` rather than a
`db push`.
