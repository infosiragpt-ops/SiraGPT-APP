---
name: Document chunk persistence whitelist
description: Why analyzeFile must whitelist DocumentChunk columns instead of spreading raw chunk objects
---

# Document chunk persistence must whitelist model columns

In `backend/src/services/document-intelligence.js`, `analyzeFile()` persists
chunks via `prisma.documentChunk.createMany`. The in-memory chunk objects carry
extra **structural** fields (`sectionLevel`, `sectionPath`) that are NOT columns
on the Prisma `DocumentChunk` model — they are duplicated inside the chunk's
`metadata` JSON. Persist by **explicitly listing model columns**, never by
spreading the raw chunk (`...chunk`).

**Why:** spreading made `createMany` throw `Unknown argument sectionLevel` for
any sectioned document (DOCX/markdown). That made `analyzeFile` throw, so the
`docintel_analyze`/`docintel_retrieve` agent tools errored, the agent-task
retried ~15 steps (~111s) before falling back to `rag_retrieve`, and the user
saw the "Resumiendo puntos clave…" placeholder forever. Document analysis was
broken for every sectioned file.

**How to apply:**
- Any record builder feeding a Prisma `createMany`/`create` must emit only real
  model columns. If a builder adds derived/structural fields, either whitelist
  before persisting or stash them in a JSON `metadata` column.
- Consumers that read those structural fields from **stored** rows must read
  from `metadata` (e.g. `retrieveEvidence` reads `chunk.metadata?.sectionPath`),
  because the top-level field only exists on freshly-built in-memory chunks, not
  on DB rows.
- `documentTable.createMany` uses `...table` safely **only because**
  `buildTables()` emits exactly the `DocumentTable` columns. If a future table
  field is added that isn't a column, it will break the same way — whitelist it.
