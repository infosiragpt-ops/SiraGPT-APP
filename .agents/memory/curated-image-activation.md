---
name: Curated IMAGE model activation
description: How default-active image models are seeded/reactivated without trampling admin control
---

# Curated IMAGE model activation

`ensureStaticCatalogModels` runs on the hot path — every `/ai/models` read AND
every `/generate-image` call. Any unconditional write there (e.g. an
`updateMany(isActive:false -> true)` for the curated default IMAGE set) silently
reactivates models the admin deliberately disabled, on every request.

**Rule:** seed `isActive` only on row CREATE; gate any "reactivate pre-existing
inactive curated rows" write behind a per-instance once-per-process flag
(`_curatedImageActivationDone`), never run it unconditionally.

**Why:** the user is the sole admin and wants the curated set on by default, but
trampling a deliberate deactivation on every read is a real regression (flagged
in code review). Per-instance (not module-global) flag matters: prod uses a
singleton so it runs once per process; tests build fresh `new ModelSyncService`
instances so each test still exercises the activation path (a module-global flag
would leak state across test files in the single CI `node --test` run).

**How to apply:** when changing curated-default activation, keep the create-time
`isActive: DEFAULT_ACTIVE_IMAGE_MODEL_NAMES.has(name)` seeding and the guarded
one-time `updateMany`; the picker/generate gate stays curated-allow-list based
(`curateVisibleAdminMediaModels` must never surface broken entries).

## Concurrency: findMany→create race (P2002)

`ensureStaticCatalogModels` does a `findMany` to compute existing names, then
`create`s the missing rows. Because it runs on the hot path (`/ai/models` read,
`/admin/models/sync`), two requests can both miss a row and race to create it —
the loser throws Prisma `P2002` (unique constraint on `name`) and the whole
"Get models" request 500s.

**Rule (two layers):**
1. *Root cause — single-flight:* `ensureStaticCatalogModels` is a thin wrapper
   that keys concurrent runs by sorted+de-duplicated type signature in an
   instance `Map`, returns the shared in-flight promise for identical calls, and
   clears the entry in `.finally` (so failures are never memoized and later calls
   re-run). The real work lives in `_ensureStaticCatalogModelsImpl`.
2. *Backstop — P2002 fallback:* wrap the per-row create in try/catch; on
   `err.code === 'P2002'` fall back to an `update` WITHOUT `isActive` (treat as
   "already created", preserve admin state); rethrow non-P2002. This covers
   residual cross-scope races (e.g. all-types admin sync vs IMAGE-only read)
   that the single-flight key does not coalesce.

**Why:** single-flight alone fixes same-key concurrency (the common hot-path
case) but different type scopes touch overlapping rows, so the DB-level P2002
catch must stay. Do not assume findMany results are still accurate by write time.
