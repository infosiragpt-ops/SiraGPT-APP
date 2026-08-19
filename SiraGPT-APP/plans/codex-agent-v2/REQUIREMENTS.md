# Codex Agent V2 — Requisitos e índice de features

**Iniciativa:** Experiencia agéntica tipo Replit Agent en el módulo `/code`, detrás del flag `CODEX_AGENT_V2`.
**Spec aprobado:** `docs/codex-agent-ux.md` (estándar UX + arquitectura + decisiones). Este folder lo descompone en unidades de trabajo trazables.
**Plan TDD detallado de la fase F1:** `docs/superpowers/plans/2026-06-12-codex-agent-v2-f1-foundations.md` (cubre features 01–03 paso a paso con código).

## Objetivo

El usuario crea un proyecto (workspace aislado con git en el runner), describe qué quiere construir, recibe **primero un plan aprobable**, y al ejecutar el build el chat **narra en tiempo real en primera persona (español)** intercalando chips de acciones agrupadas, bloques de razonamiento con duración, y al cierre tarjetas **"Checkpoint made X ago"** (commit git real: Rollback / Changes / View preview) y **"Worked for N minutes"** (métricas y costo reales). El timeline se reconstruye completo al recargar.

## Decisiones vinculantes (del brainstorming, registradas en el spec §1.3)

| Decisión | Resolución |
|---|---|
| Stack | Adaptado a siraGPT: Prisma (no Drizzle), módulo `/code` (no "Codex"), runner OpenCode/Bun como sandbox, BullMQ existente |
| Referencia visual | Patrón Replit Agent (no hay capturas) |
| Alcance UI | Todo, por fases: motor primero con la UI actual, composer/tabs mobile-first al final |
| Costos | Multi-proveedor con `costSource` explícito (`provider_exact` / `openrouter_generation` / `estimated`) |
| Motor | Subsistema nuevo server-driven: modelos `codex_*` + cola BullMQ + worker; cero tablas compartidas con flujos existentes |

## Restricciones globales

1. **Flag total:** `CODEX_AGENT_V2` off ⇒ `/api/codex/*` → 404 (salvo `/health`, siempre 200 con `{ enabled }`), worker no registrado, UI idéntica a hoy. Ningún flujo existente se modifica.
2. **CI verde por feature:** `npm test` + `npm run lint` + `npx tsc --noEmit --skipLibCheck` antes de cada push; commits convencionales con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; `git pull --rebase` antes de push directo a main.
3. **Tests offline y deterministas** (node --test backend, vitest en `tests/lib/` frontend): LLM falso, fetch mockeado, git real solo en repos temporales.
4. **El runner es el único proceso con acceso al filesystem del sandbox** — git y comandos del agente corren ahí, nunca en el backend.
5. **Runner single-tenant** (un dev server activo, puerto 5173): workspaces multi-proyecto por subdirectorio, preview on-demand. Registrado en spec §6/§13.
6. **Seguridad:** ids/paths sanitizados (sin traversal), exec con allowlist de binarios, texto de usuario escapado en todo HTML generado, API keys nunca en payloads.

## Features

| # | Feature | Fase | Depende de | Estado |
|---|---|---|---|---|
| 01 | [Flag y modelos de datos](features/01%20-%20flag-y-modelos-de-datos.md) | F1 | — | Plan TDD listo (Tasks 1–2) |
| 02 | [Workspace API del runner](features/02%20-%20workspace-api-del-runner.md) | F1 | 01 | Plan TDD listo (Tasks 3–5) |
| 03 | [Provisioning y rutas de proyectos](features/03%20-%20provisioning-y-rutas-de-proyectos.md) | F1 | 01, 02 | Plan TDD listo (Tasks 6–11) |
| 04 | [Protocolo SSE persistido](features/04%20-%20protocolo-sse-persistido.md) | F2 | 01 | Pendiente de plan TDD |
| 05 | [Motor de corridas BullMQ](features/05%20-%20motor-de-corridas-bullmq.md) | F2 | 01, 04 | Pendiente de plan TDD |
| 06 | [Loop del agente: plan y build](features/06%20-%20loop-del-agente-plan-y-build.md) | F2 | 02, 04, 05 | Pendiente de plan TDD |
| 07 | [Checkpoints git, rollback y diff](features/07%20-%20checkpoints-git-rollback-y-diff.md) | F3 | 02, 05, 06 | Pendiente de plan TDD |
| 08 | [Métricas y costos multi-proveedor](features/08%20-%20metricas-y-costos-multiproveedor.md) | F3 | 05, 06 | Pendiente de plan TDD |
| 09 | [Errores accionables y diagnósticos benignos](features/09%20-%20errores-accionables-y-diagnosticos.md) | F3 | 04, 06 | Pendiente de plan TDD |
| 10 | [UI: timeline de corrida](features/10%20-%20ui-timeline-de-corrida.md) | F4 | 04, 06 | Pendiente de plan TDD |
| 11 | [UI: tarjetas y aprobación de plan](features/11%20-%20ui-tarjetas-y-aprobacion-de-plan.md) | F4 | 07, 08, 09, 10 | Pendiente de plan TDD |
| 12 | [UI: composer réplica](features/12%20-%20ui-composer-replica.md) | F5 | 10 | Pendiente de plan TDD |
| 13 | [UI: barra de tabs mobile-first](features/13%20-%20ui-barra-de-tabs-mobile-first.md) | F5 | 10, 11 | Pendiente de plan TDD |
| 14 | [i18n del namespace codex](features/14%20-%20i18n-namespace-codex.md) | F5 | 10–13 | Pendiente de plan TDD |
| 15 | [Integración E2E y hardening](features/15%20-%20integracion-e2e-y-hardening.md) | F6 | todas | Pendiente de plan TDD |

**Orden de ejecución:** estrictamente por número dentro de cada fase; las fases son secuenciales (F1 → F2 → F3 → F4 → F5 → F6). F0 (spec `docs/codex-agent-ux.md`) ya está entregada.

**Flujo de trabajo por fase:** al llegar a una fase sin plan TDD, escribirlo primero (skill writing-plans, contra el código real del momento) siguiendo el formato del plan F1, y luego ejecutar feature por feature.

## Criterio de cierre de la iniciativa

Flujo completo verificado por test de integración: crear proyecto → describir contexto → plan propuesto → aprobar → build con streaming → checkpoint → rollback → preview; cada tipo de evento SSE renderizado; métricas y costos correctos; suite completa, lint, typecheck y CI en verde; flag off sin ninguna regresión.
