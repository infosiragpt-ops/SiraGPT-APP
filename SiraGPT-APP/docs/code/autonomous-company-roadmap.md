# /code — Ruta hacia la empresa autónoma de agentes

> Auditoría técnica sobre `production-main@d780cf558` (2026-07-26).
> Objetivo de producto: que https://siragpt.com/code sea (1) un agente de
> programación autónomo real, (2) capaz de operar una empresa por sí solo y
> (3) capaz de publicar contenido y aplicaciones sin humano por paso.

## 1 · Qué existe hoy (verificado en código, no en docs)

### Motor agéntico (Codex V2) — MADURO
- `backend/src/services/codex/agent-loop.js` — loop ReAct con budgets
  (`CODEX_MAX_STEPS`, `CODEX_MAX_TOOLS_PER_TURN`), cancelación cooperativa,
  eventos SSE tipados con replay (`event-store.js` seq-gate monotónico).
- Escalera LLM con cuarentena de 5 min por proveedor:
  Anthropic → OpenRouter → Cerebras (`llm-provider.js`).
- 7 subagentes especialistas + custom `.sira/agents.json`
  (`agent-sdk/`): planner, frontend_builder, backend_engineer, db_architect,
  qa_reviewer, enterprise_analyst, debugger. Delegación paralela cuando el
  turno es solo `run_subagent`.
- Verificación en 3 capas: `type_check` (tsc vía runner), `dev_server_check`
  (stdout del dev server), `browser_check` (`browser-check.js`, Chromium
  headless: contenido de `#root`, excepciones de página, overlay de Vite,
  requests fallidos). **Gap: solo tsc es gate determinista en `closeBuild`
  (`verify-loop.js`); browser_check es exhortativo (prompt), no bloqueante.**
- Checkpoints git reales con rollback/diff (`checkpoint-service.js`),
  `repo-map.js`, escalera de edición (`edit-matching.js`), skills.
- Seams de extensibilidad ya definidos por contrato:
  `agent-adapters/` (native-codex-adapter), `sandbox-providers/`
  (shared-runner-provider), `database-providers/`.

### Motor proactivo — LA EMPRESA YA EXISTE (`proactive-engine.js`)
- 8 departamentos con misión (CEO Office, Infraestructura de Agentes,
  Growth, Localización, Integraciones, Trust, Producto/Ingeniería, Marketing).
- Ciclo bifásico por proyecto: round-robin de departamento → el LLM propone
  UNA tarea incremental (con file-tree, `.sira/notes.md` y últimos 5 runs
  como contexto) → crea run `plan` → el siguiente tick auto-aprueba SU
  propio plan → run `build`. Presupuesto diario (`maxPerDay`), estado en
  `project.brief.proactive` (dayKey/runsToday/deptIndex/lastError).
- Ticker en `backend/index.js`, default-on en producción
  (`CODEX_PROACTIVE_ENABLED`), unref'd y con fallos aislados.
- Frontend: oficina 3D (`components/code/agent-office/`) con stances
  working/blocked/standby derivadas de runs/sesiones REALES
  (`lib/agent-office-model.ts`), día/noche, ciudad, audio. PROACTIVO
  persiste por workspace (`lib/code-agent-company-proactive.ts`) y dispara
  el kickoff — "un clic y arranca solo" ya es literal.

### Plano de publicación social — REAL pero DESCONECTADO
- `backend/src/services/social-company/`: OAuth por plataforma, token-vault
  cifrado, publisher con llamadas API reales (X, LinkedIn, Facebook),
  autopilot generador de contenido, worker cada 30 s sobre `ScheduledPost`,
  policy default `review` (nunca publica solo sin opt-in `auto`,
  dailyLimit ≤ 20), idempotencia por hash post+plataforma.
- **Gap: el departamento Marketing del proactive-engine genera tareas de
  CÓDIGO, no `ScheduledPost` — los dos sistemas no se hablan.**

### Plano de deploy — SIMULACIÓN
- `services/deployments/` es gestión (estados, versiones, dominios DNS
  sintéticos, security scan sintético); `pipeline.js` promociona a un
  dominio ficticio. No hay publicación real de la app generada: los preview
  del runner son dev servers efímeros.

### Memoria entre runs — FINA
- Solo `.sira/notes.md` + últimos 5 prompts. El run N+1 no sabe QUÉ decidió
  ni QUÉ falló en el run N más allá de eso. No existe ledger estructurado.

## 2 · Diagnóstico

El esqueleto de la empresa autónoma está construido y en producción: loop
agéntico verificable, departamentos que se auto-proponen trabajo, publicador
social con guardarraíles. Las tres carencias que separan "demo que se mueve"
de "empresa que opera sola" son:

1. **Memoria** — sin ledger, la empresa no acumula aprendizaje ni persigue
   objetivos de largo plazo; cada ciclo es casi amnésico.
2. **Calidad como gate** — sin browser_check/tests bloqueantes en runs
   proactivos, la autonomía degrada el producto en vez de mejorarlo.
3. **Efectos externos** — publicar la app (deploy real) y el contenido
   (bridge Marketing→social) son los dos "músculos" que faltan para que el
   trabajo salga al mundo.

## 3 · Ruta de trabajo (fases ejecutables)

### FASE 0 — Hardening del ciclo proactivo (S)
- **0.1 Gate browser_check en proactivo**: en `closeBuild`
  (`agent-loop.js`/`verify-loop.js`), si el run es proactivo
  (`PROACTIVE_PREFIX`) y hay dev URL, ejecutar `browser-check.js`
  determinísticamente; en fallo, encolar mini-loop reparador con el
  subagente `debugger` (mismo patrón que `CODEX_VERIFY_FIX_STEPS`).
- **0.2 Kill-switch de gasto**: `brief.proactive.dailyBudgetUsd`; `runCycle`
  agrega el coste del día vía `run-metrics`/`cost-resolver` y corta con
  `skipped_budget` al superarlo.
- **0.3 Métricas**: contador estilo `free-ia-metrics` de acciones de ciclo
  (`proposed/approved_plan/skipped_*`) + exposición Prometheus.

### FASE 1 — Memoria de empresa: Progress Ledger (M)
- **1.1 Modelo**: JSONB `brief.ledger[]` (o tabla `codex_project_ledger`):
  `{ts, department, runId, title, outcome, diffstat, learnings}`.
- **1.2 Escritura**: `closeBuild` añade la entrada con outcome real.
- **1.3 Lectura**: `proposeTask` recibe el ledger resumido (últimas N
  entradas + fallos abiertos) en lugar de solo 5 prompts.
- **1.4 Objetivos**: `brief.objectives[]` estilo OKR; el departamento CEO
  Office los revisa/re-prioriza cuando le toca el round-robin (ya tiene esa
  misión declarada — hoy no tiene datos para ejercerla).

### FASE 2 — Ciclo de calidad autónomo (M)
- **2.1 Acceptance criteria**: `proposeTask` devuelve además
  `acceptance: string[]`; `verify-loop` los evalúa (tsc + browser_check +
  asserts por grep sobre el workspace).
- **2.2 Ciclo QA**: cada K ciclos, forzar run del departamento Trust que
  ejecuta `qa_reviewer` sobre el diff acumulado desde el último checkpoint
  QA; hallazgos → entradas del ledger → tareas siguientes.
- **2.3 Tests del output**: `frontend_builder` genera smoke tests vitest en
  el proyecto; `verify-loop` corre `bunx vitest run` vía runner.

### FASE 3 — Publicación real de apps (L)
- **3.1 Static publish**: `bun run build` en runner → bundle `dist/` →
  volumen servido por Caddy con wildcard `*.apps.siragpt.com` (TLS
  on-demand). `deployments/pipeline.js` deja de simular: `promote` copia el
  bundle del checkpoint.
- **3.2 Versionado**: publicar siempre desde hash de checkpoint; rollback =
  re-promote del bundle anterior (el modelo `DeploymentVersion` ya lo
  soporta).
- **3.3 Política**: `brief.publishPolicy.mode: review|auto`; Growth puede
  proponer "publicar versión" como tarea bajo esa política.

### FASE 4 — Marketing autónomo end-to-end (M)
- **4.1 Bridge proactivo→social**: cuando Marketing gana el round-robin, en
  vez de run de código, invocar `social-company/autopilot.generateContent`
  con el ledger como contexto (qué se construyó) → `ScheduledPost` bajo
  policy (default `review`; `auto` solo con opt-in explícito ya soportado).
- **4.2 Digest diario al dueño**: Telegram (bridge ya desplegado, inerte —
  faltan tokens de BotFather) + email: ciclos ejecutados, posts pendientes
  de aprobar, gasto del día.

### FASE 5 — Escala y aislamiento (continuo)
- **5.1** Segundo `sandbox-provider` (containerd/microVM por proyecto) tras
  el contract ya definido — hoy el runner compartido es el límite
  multi-tenant real.
- **5.2** Ticker → job repetible en BullMQ (`run-queue` ya existe) para
  operar con múltiples workers sin doble-tick.
- **5.3** Segundo `agent-adapter` (Claude Agent SDK / OpenCode) tras
  `agent-adapters/contract.js`.

## 4 · Orden recomendado

0.1 → 0.2 (un día, protege producción hoy) → FASE 1 completa (multiplica la
calidad de TODAS las propuestas) → 2.1/2.2 → 4.1/4.2 (visibilidad del dueño
temprana) → FASE 3 → FASE 5. Las fases 1, 2 y 4 son paralelizables entre
agentes al tocar módulos disjuntos (proactive-engine / verify-loop /
social-company).
