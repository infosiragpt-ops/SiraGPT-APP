# Feature 01 — Flag y modelos de datos

**Fase:** F1 · **Depende de:** — · **Plan TDD:** `docs/superpowers/plans/2026-06-12-codex-agent-v2-f1-foundations.md` Tasks 1–2

## Descripción

La base de todo el subsistema: el feature flag `CODEX_AGENT_V2` y los seis modelos Prisma `codex_*` con su migración. Nada de Codex V2 existe para el sistema si el flag está apagado, y todo el estado del subsistema (proyectos, corridas, timeline, checkpoints, métricas) vive en estas tablas.

## Requisitos

1. **Flag:** `isCodexV2Enabled(env)` en `backend/src/services/codex/flags.js`. Encendido solo con `CODEX_AGENT_V2` ∈ {`1`, `true`, `on`} (case-insensitive, trimmed). Apagado por defecto y ante cualquier otro valor.
2. **Modelos** (en `backend/prisma/schema.prisma`, `@@map` a snake_case, ids `cuid()`):
   - `CodexProject` → `codex_projects`: userId, name, status (`provisioning|ready|error`), workspacePath, previewUrl, brief Json, error, timestamps. FK a User con `onDelete: Cascade`.
   - `CodexRun` → `codex_runs`: projectId, userId, mode (`plan|build`), status (`queued|running|waiting_approval|done|error|cancelled`), jobId `@unique`, model, tier, planRunId, error, createdAt/startedAt/finishedAt/updatedAt.
   - `CodexEvent` → `codex_events`: runId, seq Int, type, payload Json, createdAt. **Append-only**, `@@unique([runId, seq])` — fuente única de verdad del timeline.
   - `CodexAction` → `codex_actions`: runId, kind (`terminal|file_read|file_write|reasoning|web`), command, path, outputSummary (cap 30k), status, durationMs, linesRead, groupId.
   - `CodexCheckpoint` → `codex_checkpoints`: runId, projectId, commitSha, title, createdAt.
   - `CodexRunMetric` → `codex_run_metrics`: runId `@unique` (1:1), timeWorkedMs, actionsCount, itemsReadLines, additions, deletions, tokensIn/Out, costUsd, costSource (`provider_exact|openrouter_generation|estimated`), costOriginalUsd, costAppliedUsd.
3. **Back-relations en `User`:** `codexProjects CodexProject[]` y `codexRuns CodexRun[]`.
4. **Índices:** `codex_projects(userId, updatedAt)`, `codex_runs(projectId, createdAt)` y `(userId, status, updatedAt)`, `codex_events(runId, createdAt)` + unique `(runId, seq)`, `codex_actions(runId, createdAt)`, `codex_checkpoints(projectId, createdAt)`.
5. **Migración:** carpeta `backend/prisma/migrations/20260612120000_add_codex_tables/migration.sql` con SOLO el DDL `codex_*`, extraído de `prisma migrate diff --from-empty` (los nombres de tabla referenciados en FKs salen del diff, no se escriben a mano). El historial local está drifted: aplicar local con `npx prisma db push`, nunca `migrate dev`.

## Pasos técnicos

Seguir literalmente el plan TDD, Tasks 1–2 (tests primero, código exacto incluido allí):
1. Test + implementación del flag; registrar `tests/codex-flags.test.js` en el script `test` de `backend/package.json`.
2. Añadir los seis modelos + back-relations; `npx prisma format && npx prisma validate && npx prisma generate`.
3. Generar y extraer el SQL de migración; `db push` local si la DB está arriba.
4. Commits convencionales por paso (mensajes en el plan).

## Criterios de aceptación

- [ ] `node --test tests/codex-flags.test.js` verde (3 tests: default off, valores on, valores basura off).
- [ ] `npx prisma validate` y `npx prisma generate` sin errores.
- [ ] `migration.sql` contiene exactamente: 6 `CREATE TABLE "codex_*"`, sus índices y sus FKs — nada más.
- [ ] `npx prisma db push` sincroniza limpio contra la DB local dockerizada.
- [ ] La suite completa (`npm test`) sigue verde — la migración es puramente aditiva.
