# Indice vivo (oleadas)

- Rubrica motor: `/opt/siragpt/docs/mejoras/benchmark-capacidades.md` (v3H42 live, 2026-08-21 06:57 Lima).
- Ultima ola live: `/opt/siragpt/docs/mejoras/ola-3h-20260821-0657.md` (3H42, tool id unique across resume + schema min/max clamp + missing-brace JSON repair + refund hold if 0 tokens + pin last tool error + SSE replay last 32 + reject identical prompt inflight + refuse write >2MiB + skip empty embeddings + never charge observation loops + turn wall 120s + case-insensitive enum repair + strip zero-width args + array cap 256 + Retry-After jitter 50-150ms + ckpt tombstone + stderr 64KiB + drop tool results >6 steps + reject whitespace tool name + id strings stay strings + event seq increase + abort siblings on cancel token + redact emails + max 8 heartbeats/min + refuse symlink read + plan step failed twice + restore last SSE id, frontend untouched)
- Anterior live: `/opt/siragpt/docs/mejoras/ola-3h-20260821-0057.md` (3H41)
- 3H41 previa diferida: `/opt/siragpt/docs/mejoras/ola-3h-20260820-2157.md` (21:57 Lima: DeepSeek 402; no se aplico codigo).
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-1857.md` (3H40)
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-1557.md` (3H39)
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-1257.md` (3H38)
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-0957.md` (3H37)
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-0657.md` (3H36)
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-0357.md` (3H35)
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260820-0057.md` (3H34)
- Analisis clones: `/opt/siragpt/docs/mejoras/analisis-repos-agentes.md`
- Ola OSS rewrite: `/opt/siragpt/docs/mejoras/ola-oss-rewrite-20260818.md`
- Anterior: `/opt/siragpt/docs/mejoras/ola-3h-20260818-1757.md` (3H22)

---

# Índice — mejoras SiraGPT (cómo se mapea y cómo ejecutar)

Documento de gobierno para los catálogos:

- Frontend: `/workspace/siragpt-mejoras-frontend.md` — **1093 ítems**
- Backend: `/workspace/siragpt-mejoras-backend.md` — **1101 ítems**
- Copia en VPS: `/opt/siragpt/docs/mejoras/` (solo docs, sin rebuild).
- Fuente: SSH a `/opt/siragpt` el 2026-08-15 (America/Lima). No se clonó el repo. No se tocó compose ni deploy.

## Mapa a la estructura que el producto ya usa

| Superficie / fase viva | Dónde está hoy | Catálogo |
|---|---|---|
| `/chat` AgentRunner, SSE, Word/PPT, live activity, multi-chat | `app/chat`, `components/chat-interface-enhanced.tsx` (13158), `components/chat/*`, `lib/live-activity.ts`, `lib/sse-reconnect.ts` | FE § /chat |
| `/code` depts, oficina 3D, composer, canvas, PCs, Panel/Controlar/Archivos/Recursos | `app/code`, `components/code/*`, `lib/code-workspace-context.tsx`, `lib/workspace-tools-registry.ts` | FE § /code |
| Admin modelos + chrome | `app/admin/models/page.tsx`, `components/admin/admin-chrome.tsx` | FE § Admin |
| Gateway F11 / skills / MCP / memoria | `components/gateway/*`, `backend/src/services/agent-gateway/*`, `agent-runner/{mcp,memory,skills}` | FE § Gateway + BE § Gateway |
| Sandbox gVisor F5 / R2 | `doc-agent/sandbox.js`, `orchestration/r2-storage.js` | FE § Sandbox + BE § Sandbox/R2 |
| Auth, billing, orgs, invites | `app/auth/*`, `app/orgs/invitation`, `backend/src/routes/{auth,orgs,payments}.js` | FE/BE § Auth |
| Mobile PWA/APK | `components/mobile/*`, `app/api/mobile/*`, `capacitor.config.ts`, `android/` | FE § Mobile |
| Candado DeepSeek Flash/Pro | `native-llm.js`, `agent-gateway/index.js`, `lib/code-agent/model-policy.ts` | FE/BE § DeepSeek |
| F0–F5 ya shipped | `ROADMAP.md` + `STATE.md` (F5 COMPLETED, pendiente gVisor en daemon) | no reabrir; higiene/regresión sí |
| F6–F12 siguientes | stubs `agent-runner/browser`, `multimodal`, `mcp`, `memory`, `evals` | FE § Oleadas + BE § Oleadas |

## Conteos por sección

### Frontend

- 151 — /chat — AgentRunner, SSE, Word/PPT, live activity, multi-chat
- 136 — /code — departamentos, oficina 3D, composer, canvas, computadoras, Panel/Controlar/Archivos/Recursos
- 29 — Admin — catálogo de modelos y chrome
- 18 — Gateway / skills / MCP / memoria (UI)
- 15 — Sandbox / gVisor / artefactos R2 (UI)
- 35 — Auth, billing, orgs, invitaciones (UI)
- 25 — Mobile PWA / APK
- 34 — Candado DeepSeek V4 Flash/Pro (UI) — nunca OpenRouter como generate
- 18 — Oleadas post-F5 (F6–F12 en la UI, respetando ROADMAP/STATE)
- 59 — A11y — controles reales sin etiquetar (scan vivo)
- 123 — Capas de ruta — loading.tsx / error.tsx faltantes en app/
- 73 — Higiene del árbol vivo — .bak y AppleDouble (FE)
- 38 — Partir god-files frontend (líneas vivas)
- 23 — TypeScript — `any` en módulos vivos
- 15 — Fugas OpenRouter en frontend (candado DeepSeek)
- 20 — Tests frontend faltantes (módulos grandes sin suite colocada)
- 54 — Perf y observabilidad frontend
- 227 — Otras superficies vivas (projects, gpts, thesis, voice, search, cowork)
- **Total FE: 1093**

### Backend

- 51 — AgentRunner /chat /doc — loop, tools, traces F0–F4, candado DeepSeek
- 45 — Documentos Word/PPT, pipeline, R2, verify
- 43 — Codex /code, departamentos, host-runner, git
- 29 — Gateway F11 / skills / MCP / memoria
- 25 — Auth, billing, orgs, invitaciones, créditos
- 14 — Sandbox gVisor F5
- 20 — Observabilidad, colas, health, métricas
- 20 — Candado DeepSeek — fugas OpenRouter en generate
- 128 — Rutas y servicios vivos restantes
- 104 — Higiene del árbol vivo — .bak, AppleDouble y .env.bak (BE/ops)
- 67 — Partir god-files backend (líneas vivas)
- 51 — Fugas OpenRouter en backend (generate path)
- 14 — Observabilidad — console.log ruidosos en backend
- 19 — TODOs/FIXME reales en backend/src
- 30 — Tests backend — rutas y módulos críticos
- 30 — Oleadas F6–F12 backend (stubs ya en el árbol vivo)
- 411 — Módulos backend grandes aún no partidos (ítem por archivo vivo)
- **Total BE: 1101**

## Cómo ejecutar en oleadas de 20

Una oleada = 20 ítems, un PR, tests del área, sin `compose down`, sin deploy desde el VPS (Luis pushea desde su Mac).

Orden (no empezar por el PC real / oficina 3D — otro agente ya lo cubre):

| Oleada | Lote | Qué cierra |
|---|---|---|
| W1 | FE higiene 1–20 | Borrar `._*` y `.bak` de `components/chat` + `lib` que el chat puede globear |
| W2 | FE higiene 21–40 | `.bak` de `app/globals.css` y composer (no rehacer logos) |
| W3 | BE higiene 1–20 | Borrar `.bak` de `agent-runner/*.js` (deeplock/pptfix/wordppt) |
| W4 | BE higiene 21–40 | Directorios `agent-runner/.bak-*` enteros |
| W5 | BE secretos | Sacar `.env.bak-*` del disco a vault |
| W6 | Candado FE | `catalog-model`, `model-policy`, admin/models fallback OpenRouter |
| W7 | Candado BE | `ai.js` + `ai-service.js` + `visible-model-catalog.js` → solo native-llm |
| W8 | Candado tests | invariante CI: generate no toca openrouter.ai |
| W9 | /chat SSE | `sse-reconnect` Last-Event-ID + Stop unificado |
| W10 | /chat live activity | labels F4 en `live-activity.ts` + RunningChatsBar persist/cancel |
| W11 | /chat Word/PPT | ArtifactCard R2 expiry + lastArtifactId follow-up |
| W12 | /chat god-file | extraer Composer de `chat-interface-enhanced.tsx` (sin cambiar UI visual) |
| W13 | /chat a11y | MessageActionRail, ArtifactCard, ChatSearchDialog, presentation-view |
| W14 | /chat error/loading | `app/chat/error.tsx` + `loading.tsx` |
| W15 | Auth BE | refresh-token rotation (`auth.js` TODO L160/L949) |
| W16 | Auth FE | loading/error de login/register/reset + no leak email |
| W17 | Orgs | partir invites de `orgs.js` + invite single-use test |
| W18 | Billing | idempotency payments + credit-ledger 402 |
| W19 | R2 | fail-closed prod + ArtifactCard reintento de presign |
| W20 | gVisor verify | health/admin pintan runtime; no compose down |
| W21 | Sandbox FE | preview-pane error honesto fail-closed |
| W22 | Gateway | test HTTP model_forbidden + GatewayBadge a11y |
| W23 | /code tabs | Panel/Controlar/Archivos/Recursos tablist + deep-link (sin tocar PC 3D) |
| W24 | /code composer | model-policy fail-closed + no segundo generate en dept-chat-bard |
| W25 | /code god-file | extraer composer de `ai-code-chat-panel.tsx` |
| W26 | /code a11y | workspace-tools-menu, git-tool, file-tree |
| W27 | Mobile | SW no cachea generate; APK checksum; RunningChatsBar safe-area |
| W28 | Admin | quitar fallback OpenRouter; health muestra R2+gVisor+DeepSeek |
| W29 | Observabilidad | metrics generate por flash/pro + path F2 |
| W30 | Tests F1–F5 regresión | hex OOXML, cancel no-leak, routing no-pipeline |
| W31+ | F6 search/browser | solo cuando W30 verde (ROADMAP) |
| W35+ | F7 multimodal | requiere gVisor verificado |
| W40+ | F8 memoria/MCP | recall + OAuth user |
| W45+ | F9 evals dashboard | gate de frases reales |
| W50+ | F10–F12 | router Flash/Pro, SSO, i18n, Drizzle último |

Cada oleada de 20: tomar los 20 siguientes no hechos del catálogo de esa sección, implementar, `node --test` / type-check del área, PR, Luis deploya. No mezclar F6 en una oleada de higiene.

## Top 10 FE para hacer primero

(Excluye PC real / oficina 3D / composer logos — otro agente.)

1. Borrar AppleDouble `._*` y `.bak` que el chat/code pueden globear (`components/chat/._RunningChatsBar.tsx`, `chat-interface-enhanced.tsx.bak-*`).
2. Quitar el fallback `OpenAI/Gemini/OpenRouter` en `app/admin/models/page.tsx` (~L628 y ~L1121).
3. `lib/chat/catalog-model.ts` + `lib/code-agent/model-policy.ts` fail-closed Flash/Pro.
4. `lib/sse-reconnect.ts` con Last-Event-ID contra `/api/ai/generate` (contrato F3).
5. `RunningChatsBar` persist + cancel real (`POST /api/ai/stop-stream`).
6. `lib/live-activity.ts` labels F4 (Planificando / Delegando / Presupuesto agotado).
7. `app/chat/error.tsx` + `loading.tsx` (hoy faltan ambos).
8. ArtifactCard: error si el presigned R2 expiró + `lastArtifactId` en follow-up Word/PPT.
9. Extraer Composer de `chat-interface-enhanced.tsx` (13158 líneas, 194 `any`) sin cambiar el look.
10. Tablist accesible Panel/Controlar/Archivos/Recursos en `workspace-top-bar.tsx` + deep-link.

## Top 10 BE para hacer primero

(Excluye el driver de computadora de departamento — otro agente.)

1. Sacar `.env.bak-*` de `/opt/siragpt` a un vault (secretos históricos en disco).
2. Borrar `backend/src/services/agent-runner/*.bak-*` y directorios `.bak-*` (30+ copias de `index.js`).
3. Cerrar TODOs de refresh-token rotation en `backend/src/routes/auth.js` (L160, L949).
4. Forzar `resolveAgentLlmClient()` en `routes/ai.js` (49 menciones OpenRouter, 112 `console.log`).
5. `visible-model-catalog.js` + `ai-service.js` + `litellm-gateway.js`: generate solo native-llm.
6. Test de invariante CI: las 4 entradas F2 + gateway no llaman openrouter.ai.
7. `credit-ledger.js` + `charge-credits.js`: 402 DeepSeek y cancel inmediato no cobran dos veces.
8. Verificar gVisor en el daemon o `SIRAGPT_SANDBOX_RUNTIME=runc` explícito (STATE F5 fail-closed).
9. R2 fail-closed en prod (`artifact-storage-policy.js`) + TTL de presign que ArtifactCard reintenta.
10. Encender el preloop runner-first de `/api/agent/task` fuera de `NODE_ENV=test` (hoy `AGENT_TASK_AGENT_RUNNER=1` opt-in).

## Honestidad del conteo

El árbol soporta estos 1093 FE y 1101 BE. Cada línea nombra archivo/ruta y un cambio concreto (bug, a11y, perf, seguridad, producto faltante, higiene, test u observabilidad).

Desglose:
- FE 1093: todos anclados a archivos/rutas vivas (679 módulos, 69 pages, a11y débil medida, 73 backups FE, 123 shells loading/error).
- BE núcleo 690: runner, docs, codex, gateway, auth, gVisor, R2, fugas OpenRouter, TODOs, tests, F6–F12, 104 backups/ops.
- BE última sección 411: un audit+test+candado DeepSeek por módulo vivo de 220+ líneas aún no citado (deuda real de 2037 archivos). Si se quiere un catálogo más corto, ejecutar primero los 690.

Ítems de partir god-file y borrar .bak son reales: 13158 líneas en el chat, 11380 en ai.js, 170 backups en el VPS.

## Fuera de alcance de este entregable

- No se implementó código de producto.
- No se hizo deploy ni `compose down`.
- No se clonó `infosiragpt-ops/SiraGPT-APP`.
- No se duplicó el trabajo de PC real en curso.
