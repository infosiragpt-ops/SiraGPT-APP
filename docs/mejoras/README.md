# Índice — olas de mejora del motor

Documentación de las olas **engine-only**. No cubre UI / chrome de `/chat` o `/code`.

| Ola | Fecha | Qué envía | Rubric |
|---|---|---|---|
| 3H59 | 2026-08-23 | 24 helpers: repair/backoff, fingerprint cut, fact anchors, SSE leak guards, credit cancel | #388 |
| 3H60 | 2026-08-23 | 32 helpers: coerce/enum/fence, oscilación A-B-A-B, compacto fiel + prune + memory pins, checkpoint bytes + RAW hash + syntax revert, SSE Last-Event-ID replay + abort, single-writer + seq gap, credit settle on **error**, p50/p95 scripted | [3H60.md](./3H60.md) |
| Hot path #388 | 2026-08-23 | Wire live #388 names into `loop.js` + generate SSE: `retryToolWithBackoff`, `compactUntilTokenBudget`, `startCommentHeartbeat`, inclusive `honorLastEventId` | [benchmark-capacidades.md](./benchmark-capacidades.md#hot-path-388--399) |
| **3H61** | 2026-08-23 | Reexporta helpers #388/3H59 por adapter y los llama por nombre en `loop.js` + generate: `checkpointHookBeforeMutatingTool` / `rollbackHookOnTimedOutWrite` / `sandboxTimeoutThenCleanup` / `sseResumeDropsPriorListeners`… (sin overlay names nuevos) | [3H61.md](./3H61.md) · [benchmark-capacidades.md](./benchmark-capacidades.md) |
| **3H62** | 2026-08-24 | RAW + syntax revert + exact diff; Last-Event-ID persistido + resume inclusivo; checkpoint de sesión en disco; pins pgvector en compact; ledger Prisma en cancel/error; p50/p95 first-token/turn-end | [3H62.md](./3H62.md) · [benchmark-capacidades.md](./benchmark-capacidades.md) |
| **3H63** | 2026-08-24 | 35 helpers #388: cola/fair generate 503@60s; abort cascade + budget parent−1; repair fragments/incomplete; checksum/jail/diff; SSE last-id atrás; refund tokens parciales; TTFB 45s; `completeLedgerTransaction` en success; `/api/version.commit` from git HEAD not leftover `.env` | [3H63.md](./3H63.md) · [benchmark-capacidades.md](./benchmark-capacidades.md) |
| **3H64** | 2026-08-25 | 31 helpers #388: ring p50/p95 persistido + GET `/api/version/latency`; wall 120s + 3 stalls; SSE client-gone + reconnect Last-Event-ID e2e Node; sandbox grace/net/RSS; compact keep system+pins; crc32/gzip checkpoint; classify/sanitize ES | [3H64.md](./3H64.md) · [benchmark-capacidades.md](./benchmark-capacidades.md) |

UI sin cambios en 3H60, hot-path #399, 3H61, 3H62, 3H63 ni 3H64 (Empresas lock, RunTrace assistant-only, loaders celeste). DeepSeek Flash/Pro only.
