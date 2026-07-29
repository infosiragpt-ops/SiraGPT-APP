# OpenClaw → siraGPT — carta de porte (fusión por reescritura)

> 2026-07-26. Gobierna la reescritura nativa de OpenClaw (MIT,
> github.com/openclaw/openclaw, ~800k líneas TS medidas en clon sparse)
> dentro de siraGPT. Ejecuta la fase P2 y amplía el
> [company-os-master-plan](./company-os-master-plan.md).

## Reglas del porte (no negociables)

1. **Reescribir, nunca copiar-pegar.** Se lee el módulo de referencia, se
   extrae su contrato y sus decisiones (TTLs, formatos, edge cases), y se
   reescribe nativo: Express/CommonJS/Prisma/Redis en `backend/`, Next en
   superficies nuevas. Cero dependencias de su runtime.
2. **En el idioma del repo, no en un dialecto opaco.** Código que solo
   entiende una IA no pasa CI ni auditoría y bloquea a los demás agentes.
   La complejidad va en la arquitectura; el código queda mantenible.
3. **Atribución MIT**: entrada en THIRD_PARTY_LICENSES / NOTICES por cada
   módulo portado ("architecture derived from OpenClaw, MIT").
4. Cada módulo portado: servicio puro inyectable + tests offline
   (descubiertos por el sharder) + CI verde + push. Flag-gated si toca
   rutas vivas.

## Mapa de fusión (prioridad de porte)

| # | Módulo OpenClaw (líneas) | Destino siraGPT | Qué se porta | Prioridad |
|---|---|---|---|---|
| 1 | `src/pairing` (1.5k) | `backend/src/services/business-channels/pairing.js` | Códigos de emparejamiento, allowlist store, aprobación, TTL — el modelo de seguridad de canales entero | **P0 — primero** (pequeño, autocontenido, prerequisito de canales) |
| 2 | `src/channels` (45k) | `business-channels/adapters/*` | SOLO el contrato adapter + 5 canales (telegram, email, whatsapp-twilio, slack, discord) — no los 25 | P0 |
| 3 | `src/cron` (28k) | `ScheduledAgentTask` + worker (cowork E4) | Modelo de job, catch-up de ejecuciones perdidas, jitter, historial | P1 |
| 4 | `src/sessions` (7k) | ampliar `cowork/session-manager.js` | sessions_list/history/send como tools del agente + draft sessions | P1 |
| 5 | `src/routing` | router canal→departamento | Reglas peer/account→agente aislado | P1 |
| 6 | `src/skills` (25k) | ampliar `skills-registry.js` | SKILL.md por carpeta de workspace + skills gestionadas | P2 |
| 7 | `src/gateway` (225k) | **NO se porta entero** | Solo patrones: heartbeat de salud, doctor de config, exposure checks → `business-channels/doctor.js` | P2 |
| 8 | `src/agents` (356k) | **NO se porta** | Codex ya ES el runtime de agentes; se cosechan ideas puntuales (compaction CJK, tool-loop guards) como issues | — |
| 9 | `src/memory` + memory-core ext | `active-memory.js` | Patrón "dreaming jobs" (consolidación nocturna de memoria) | P2 |
| 10 | apps macOS/iOS/Android (Swift/Kotlin) | **fuera de alcance** | siraGPT es web; nodos móviles no aplican | — |

Referencia de lectura: clon sparse en scratchpad de sesión
(`openclaw-ref/`, solo `src/ packages/plugin-sdk docs/`). No se commitea
al repo — se re-clona cuando haga falta (`git clone --depth 1
--filter=blob:none --sparse`).

## Orden de ejecución

1. **Porte #1 (pairing)** — desbloquea la seguridad de TODOS los canales.
2. Porte #2 contrato + adapter telegram (promueve el bridge desplegado).
3. Porte #3 cron por usuario (cowork E4 con las decisiones de OpenClaw).
4. Portes #4/#5 (sesiones como tools + routing).
5. En paralelo continuo: A1 worktrees → A2 cap → A3 fleet (master plan) —
   la escala del motor de código NO espera al porte de canales.
