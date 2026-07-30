# Autonomous Company Scorecard — `/code`

Fecha: 2026-07-29  
Base: `production-main` (company brain + missions landed)

Escala 0–5: 0 no existe · 3 usable con huecos · 5 producción autónoma confiable.

| # | Capacidad | Score | Realidad (evidencia) |
|---|---|---:|---|
| 1 | Mejor agente de código por instrucciones | **3.5** | Chat de código + apply/preview/engine fuertes (`ai-code-chat-panel`, `code-agent/*`). Aún no es “mejor del mundo”: verificación post-write y self-debug incompletos. |
| 2 | Miles de agentes en paralelo | **2.5** | UI muestra cientos/miles *lógicos*. Swarm real: research concurrency hasta ~64–128; **writers de código** limitados por `configuredRunCap` (default **1** salvo flags de aislamiento). `fleet-orchestrator` + `swarm-orchestrator`. |
| 3 | CEO Office misión/visión/OKRs/proactivo | **4.0** | Company brain + missions + OKRs + profile + proactive engine (`company-mission-orchestrator`, `proactive-engine`, OKR routes). |
| 4 | Departamentos + derivación de tareas | **3.5** | Departamentos, pools, chats, command center. Derivación existe; ejecución full-auto por depto aún irregular. |
| 5 | Publicar en redes | **2.5** | `social-company/*`, publishing tool, resources. No es un loop autónomo confiable 24/7. |
| 6 | Buscar clientes / cerrar ventas solo | **1.5** | Depts Sales/Growth + misiones; no hay closer autónomo con CRM real end-to-end. |
| 7 | Analizar si algo no está listo | **3.5** | Readiness + business analyzer + command center checks. |
| 8 | Correos pendientes del negocio | **2.0** | Gmail connectors / business-channels; no es un inbox ops loop CEO confiable. |
| 9 | Responder comentarios de redes con contexto | **1.5** | Pairing/canales empezados; reply contextual no cerrado. |
| 10 | Crear/gestionar landing | **3.0** | Scaffold/build + missions website; bootstrap automático de gap→landing parcial. |
| 11 | Respuestas resumen ejecutivas | **3.5** | CEO brief paths + spoken summary. |
| 12 | Audio resumen en chat | **3.5** | `BrowserVoicePlayer` + `spoken-summary` en turns. |
| 13 | Streaming en vivo de ediciones de código | **2.5** | Phases/activity existen; stream compacto “escribiendo path…” incompleto. |
| 14 | Research web real para objetivos de negocio | **3.5** | Web grounding + business analyzer search/fetch. |

**Promedio global ~ 2.9 / 5** — base de empresa autónoma **real**, no humo; el salto a “millones de agentes / cierra ventas solo” es de **infra de ejecución + loops de negocio**, no de más UI.

## Top 10 (impacto × factibilidad, 48h)

1. Subir concurrency de research/swarm y ser honesto con writers (este PR).
2. En VPS: habilitar aislamiento de runs (`CODEX_RUN_*` + worktrees) para writers >1.
3. Live stream de files escritos en chat CEO/eng.
4. Gap→misión landing automática desde business analyzer.
5. Self-debug post-build cuando preview falla.
6. Inbox business: pending emails → misión Customer Success.
7. Social queue: draft→approve→publish con evidencia.
8. Sales loop mínimo: lead research → outreach draft (sin auto-send sin permiso).
9. Heartbeat proactivo CEO cada N min con resumen + next mission.
10. Métricas reales de swarm en command center (active/queued/writers vs logical).

## Honestidad sobre “100 / millones de agentes”

- **Agentes lógicos**: ya se pueden planear cientos–mil.
- **Tareas research en paralelo**: subiendo a decenas.
- **Mutaciones de código concurrentes**: bloqueadas a propósito sin aislamiento OS/worktree; sin eso, 100 writers se pisan el repo.
- “Millones” no es el objetivo útil: el objetivo útil es **throughput verificable** (misiones cerradas / hora con evidencia).
