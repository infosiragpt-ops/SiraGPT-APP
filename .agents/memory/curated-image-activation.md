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

**Rule:** wrap the create in try/catch; on `err.code === 'P2002'` fall back to an
`update` WITHOUT `isActive` (treat as "already created", preserve admin state);
rethrow any non-P2002 error. Do not assume findMany results are still accurate by
the time you write.
