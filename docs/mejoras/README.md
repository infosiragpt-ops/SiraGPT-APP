# Índice — olas de mejora del motor

Documentación de las olas **engine-only**. No cubre UI / chrome de `/chat` o `/code`.

| Ola | Fecha | Qué envía | Rubric |
|---|---|---|---|
| 3H59 | 2026-08-23 | 24 helpers: repair/backoff, fingerprint cut, fact anchors, SSE leak guards, credit cancel | #388 |
| 3H60 | 2026-08-23 | 32 helpers: coerce/enum/fence, oscilación A-B-A-B, compacto fiel + prune + memory pins, checkpoint bytes + RAW hash + syntax revert, SSE Last-Event-ID replay + abort, single-writer + seq gap, credit settle on **error**, p50/p95 scripted | [3H60.md](./3H60.md) |
| Hot path #388 | 2026-08-23 | Wire live #388 names into `loop.js` + generate SSE: `retryToolWithBackoff`, `compactUntilTokenBudget`, `startCommentHeartbeat`, inclusive `honorLastEventId` | [benchmark-capacidades.md](./benchmark-capacidades.md#hot-path-388--399) |
| **3H61** | 2026-08-23 | Fail-closed wiring of leftover #388 helpers: checkpoints/rollback, sandbox timeout+orphan reap, cancel token settle, classified ES errors, SSE resume/cancel leftovers, subtask no-progress + token slice | [3H61.md](./3H61.md) · [benchmark-capacidades.md](./benchmark-capacidades.md) |

UI sin cambios en 3H60, hot-path #399 ni 3H61 (Empresas lock, RunTrace assistant-only, loaders celeste). DeepSeek Flash/Pro only.
