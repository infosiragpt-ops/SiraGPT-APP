# Catálogo OSS — Agentes de codificación

> Fuente de verdad para qué código open source puede entrar a SiraGPT-APP y
> en qué condiciones. La política ejecutable vive en
> `scripts/oss-license-policy.js` (falla el CI ante copyleft/FSL/SSPL/uso
> sostenible) y el gate `licenses:check` en `.github/workflows/ci.yml`.
> Atribuciones en `THIRD_PARTY_NOTICES.md`; snapshots de referencia en
> `.agents/<origen>-upstream` y `vendor/<slug>/`.

**Regla de oro (§25 AGENTS.md):** nada se copia sin `LICENSE` verificado,
commit SHA fijado y entrada en `THIRD_PARTY_NOTICES.md`. Un PR = una fusión.

**Leyenda de estado**

| Marca | Significado |
|---|---|
| ✅ | Licencia verificada este turno (archivo LICENSE oficial) |
| 🔗 | Ya integrado en SiraGPT (snapshot + puente nativo existentes) |
| ⏳ | Declarado en la solicitud; licencia PENDIENTE de verificación — prohibido copiar hasta verificar |
| 🚫 | Excluido por solicitud/política — como máximo servicio externo sin modificar |
| 🧪 | Solo evaluación futura — no entra a prod sin decisión (p. ej. modelos no-DeepSeek) |

**Nota de convención:** donde la solicitud pide `third_party/<repo>/`, este
repo usa la convención existente `vendor/<slug>/` + entrada en
`THIRD_PARTY_NOTICES.md` + snapshot en `.agents/<origen>-upstream`. Son el
mismo requisito con el nombre local. No se crea una cuarta convención.

**Stack real detectado (respeta esto, no lo reescribas):** frontend Next.js 14
+ backend Express en Node 22 + Prisma/PostgreSQL + Redis/BullMQ + Docker
Compose (`db, redis, backend, frontend, opencode, runner,
computer-orchestrator`). **No existe `pyproject.toml`**: el backend es
TypeScript/JavaScript, por eso el harness se construye sobre `pi` + modo
servidor de `opencode` (no sobre el SDK Python de OpenHands). Modelos en
prod: solo DeepSeek V4 Flash/Pro — los modelos abiertos listados abajo son
evaluación/referencia, no prod.

## 1. Capa de ejecución (sandbox remoto)

| Slug | Licencia | SHA | Qué se toma | Módulo destino | Estado |
|---|---|---|---|---|---|
| `alibaba/OpenSandbox` | Apache-2.0 ✅ | fijar al vendorizar | Pool de sandboxes pre-aprovisionados, volúmenes persistentes, gateway de ingreso con egreso por sandbox, backends gVisor/Kata/Firecracker | `backend/src/services/agentes-coding/sandbox/` (fase 2) | ⏳ arquitectura adoptada |
| `e2b-dev/E2B` | Apache-2.0 ✅ | fijar al vendorizar | Alternativa equivalente a OpenSandbox | misma capa (alternativa) | ⏳ |
| `e2b-dev/infra` | Apache-2.0 ⏳ | fijar al vendorizar | Autohospedaje con Terraform (referencia, prod es Lenovo+Compose) | `docs/` (referencia) | ⏳ |
| `e2b-dev/code-interpreter` | Apache-2.0 ⏳ | fijar al vendorizar | Filesystem persistente, exposición de puertos por URL segura | misma capa | ⏳ |
| `microsandbox/microsandbox` | Apache-2.0 ⏳ | fijar al vendorizar | Aislamiento por microVM libkrun (<200 ms, modo efímero/persistente) | misma capa (evaluar) | ⏳ |
| `openai/codex-universal` | MIT ⏳ | fijar al vendorizar | Imagen base con lenguajes preinstalados | imagen sandbox (fase 2) | ⏳ |
| `agent-infra/sandbox` | Apache-2.0 ⏳ | fijar al vendorizar | Referencia imagen todo-en-uno (shell, navegador, Jupyter, VS Code) | imagen sandbox | ⏳ |
| `NVIDIA/OpenShell` | Apache-2.0 ⏳ | fijar al vendorizar | Políticas declarativas filesystem/red/procesos, recurso Sandbox | políticas sandbox | ⏳ |
| `kubernetes-sigs/agent-sandbox` | Apache-2.0 ⏳ | fijar al vendorizar | Mismo patrón de políticas (SIG Kubernetes) | políticas sandbox | ⏳ |
| `anthropics/sandbox-runtime` | Apache-2.0 ⏳ | fijar al vendorizar | Sandboxing por llamada, proxies HTTP/SOCKS5 con allowlist | ejecución de tools | ⏳ |
| `nolabs-ai/nono` | Apache-2.0 ⏳ | fijar al vendorizar | Re-sandbox por llamada + traza de auditoría (hash Merkle) | auditoría ejecución | ⏳ |
| `paradigmxyz/iron-proxy` | Apache-2.0 ⏳ | fijar al vendorizar | Egreso deny-by-default, sustitución de secretos en destino | red del sandbox | ⏳ |
| `engineer-man/piston` | MIT ⏳ | fijar al vendorizar | Snippets cortos (alternativa) | snippets | ⏳ |
| `vndee/llm-sandbox` | MIT ⏳ | fijar al vendorizar | Docker/Podman/K8s como sandbox, stdout/stderr/exit/artefactos | snippets | ⏳ |
| `dagger/container-use` | Apache-2.0 ⏳ | fijar al vendorizar | Patrón worktree contenedorizado por agente vía MCP | workspaces | ⏳ |
| `firecracker-microvm/firecracker` | Apache-2.0 ⏳ | — | Primitivo de referencia (no se vendoriza el VMM) | docs | ⏳ |
| `google/gvisor` | Apache-2.0 ⏳ | — | Primitivo de referencia | docs | ⏳ |
| `kata-containers/kata-containers` | Apache-2.0 ⏳ | — | Primitivo de referencia | docs | ⏳ |

Excluidos de ejecución (🚫 — como máximo servicio externo sin modificar):

| Slug | Motivo |
|---|---|
| `daytonaio/daytona` | Repo público congelado en v0.190.0 (AGPL-3.0) y código movido a repo cerrado desde junio 2026: sin parches, no apto |
| `coder/coder` | AGPL |
| `gitpod-io/gitpod` (servidor) | AGPL — ver nota: `gitpod-io/openvscode-server` es MIT y SÍ entra (UI) |

## 2. Harness del agente (backend TS → `pi` + `opencode` server mode)

| Slug | Licencia | Qué se toma | Módulo destino | Estado |
|---|---|---|---|---|
| `earendil-works/pi` (ex-badlogic/pi-mono) | MIT ⏳ | System prompt <1000 tokens (lazy skills), CLI, API LLM unificada, TUI, MCP | harness TS | ⏳ |
| `anomalyco/opencode` | MIT ✅ | Modo servidor, agentes build/plan, LSP 20+ lenguajes, MCP, catálogo OpenAI/Ollama | harness TS | 🔗 parcial (sidecar `vendor/opencode` + arnés codex #582) |
| `vercel/ai` | Apache-2.0 ⏳ | Streaming + tool calling | harness TS | ⏳ |
| `deepseek-ai/deepseek-harness` | MIT ⏳ | Arquitectura de plugins (modelos/tools/skills/sesiones/sandboxes como plugins), ACP, log append-only, AGENTS.md/CLAUDE.md — **fijar versión** (developer preview con breaking changes) | harness TS | ⏳ |
| `openai/codex` | Apache-2.0 ⏳ | Protocolo app-server, sandbox Landlock/Seatbelt, modo exec, subagentes | harness TS | ⏳ |
| `xai-org/grok-build` | Apache-2.0 ⏳ | Plan mode, subagentes paralelos con worktrees, headless `-p`, ACP, extensiones | harness TS | ⏳ |
| `cline/cline` | Apache-2.0 ⏳ | SDK, checkpoints, hub MCP | harness TS | ⏳ |
| `Kilo-Org/kilocode` | MIT ⏳ | Modos + memory bank (destino post-Roo Code) | harness TS | ⏳ |
| `aaif-goose/goose` | Apache-2.0 ⏳ | Servidor `goosed` + extensiones (70+ MCP) | harness TS | ⏳ |
| `Aider-AI/aider` | Apache-2.0 ⏳ | Repomap PageRank (tree-sitter), formatos diff/whole/udiff, bucle lint/test — **vendorizar y fijar** (sin commits desde 2026-05-22) | contexto/edición | ⏳ |
| `Hmbown/CodeWhale` | MIT ⏳ | Modos de aprobación, snapshots con undo/restore, persistencia de sesión | harness TS | ⏳ |
| `esengine/DeepSeek-Reasonix` | MIT ⏳ | Gestión de contexto (prefix-cache estable, poda pre-compactación, planner/executor) | contexto | ⏳ |
| `QwenLM/qwen-code` | Apache-2.0 ⏳ | Herramientas TS + checkpointing | harness TS | ⏳ |
| `google-gemini/gemini-cli` | Apache-2.0 ⏳ | Mismas herramientas/checkpointing (referencia gemela) | harness TS | ⏳ |
| `continuedev/continue` | Apache-2.0 ⏳ | Autocompletado, context providers, checks CI en markdown | editor/contexto | ⏳ |
| `microsoft/vscode-copilot-chat` | MIT ⏳ | Prompts del agent mode, estrategias de edición | prompts | ⏳ |
| `SWE-agent/SWE-agent` | MIT ⏳ | Tool bundles agente-computadora | tools | ⏳ |
| `bytedance/trae-agent` | MIT ⏳ | Registro de trayectorias (inactivo desde 2026-02-05: fijar) | observabilidad | ⏳ |
| `OpenAutoCoder/Agentless` | MIT ⏳ | Pipeline localización→reparación→validación (issue→PR) | flujo repair | ⏳ |
| `aorwall/moatless-tools` | MIT ⏳ | Búsqueda orientada a edición | búsqueda | ⏳ |
| `plandex-ai/plandex` | MIT ⏳ | Planificación de tareas largas, sandbox de revisión (sin commits desde 2025-10: fijar) | planificación | ⏳ |
| `stitionai/devika`, `AntonOsika/gpt-engineer`, `Pythagora-io/gpt-pilot`, `geekan/MetaGPT` | MIT ⏳ | Flujos spec→plan→código, roles planner/coder/researcher | flujos | ⏳ |
| `frdel/agent-zero` | MIT ⏳ | UI web con subagentes y memoria | referencia UI | ⏳ |
| `kortix-ai/suna` | Apache-2.0 ⏳ | Modelo sesión→rama→change request con aprobación humana | flujo entrega | ⏳ |
| `BloopAI/vibe-kanban` | Apache-2.0 ⏳ | Orquestación paralela, revisión con comentarios en línea, 10+ agentes (sunset: fijar) | orquestación | ⏳ |
| `TabbyML/tabby` | Apache-2.0 ⏳ | Completado autohospedado + capacidades agénticas | editor | ⏳ |
| `OpenHands/software-agent-sdk` | MIT ⏳ | **Solo si un backend Python existiera** — no existe: referencia, no vendorizar | docs | ⏳ |
| `OpenHands/typescript-client` | MIT ⏳ | Consumo del Agent Server desde frontend | frontend | ⏳ |
| `OpenHands/OpenHands` | MIT (núcleo) ⏳ | Tools bash/editor/navegador/task-tracker, headless CI, resume | referencia | ⏳ |

Excluidos de harness (🚫):

| Slug | Motivo |
|---|---|
| `charmbracelet/crush` | FSL-1.1-MIT verificada: solo revierte a MIT 2 años después de cada release — no copiable hoy |
| `warpdotdev/warp` (cliente) | AGPL-3.0 — solo los crates de UI son MIT; el agente no entra |
| `ZCode` | Propietaria, no open source (pesos GLM MIT ≠ app) |
| `claw-code` | Pieza de museo según su propio README: no usar para trabajar |
| Claude Agent SDK | Términos Comerciales de Anthropic — solo dependencia npm si se decide, jamás copiar código |

## 3. Vibe coding (describe y despliega)

| Slug | Licencia | Qué se toma | Estado |
|---|---|---|---|
| `cloudflare/vibesdk`, `cloudflare/vibesdk-templates` | MIT ⏳ | Bucle modelo-herramienta con clarificaciones, workspace por proyecto, previews sin dev-server, verificación en navegador con auto-reparo, SQLite por app, restore points, streaming de progreso, catálogo de plantillas | ⏳ |
| `stackblitz/bolt.new`, `stackblitz-labs/bolt.diy` | MIT ⏳ | Prompts, artefactos de acción, modo diff, import git, deploy Netlify/Vercel — WebContainers se sustituye por sandbox remoto (propietario) | ⏳ |
| `dyad-sh/dyad` | Apache-2.0 fuera de `src/pro` ⏳ | UX de app builder, integración Supabase | ⏳ |
| `e2b-dev/fragments` | Apache-2.0 ⏳ | Plantilla Next.js + fragments multi-stack en sandbox | ⏳ |
| `onlook-dev/onlook` | Apache-2.0 ⏳ | Edición visual de React con IA | ⏳ |
| `srcbookdev/srcbook` | Apache-2.0 ⏳ | Notebooks TypeScript | ⏳ |
| `langchain-ai/open-canvas` | MIT ⏳ | Canvas de artefactos | ⏳ |
| `abi/screenshot-to-code` | MIT ⏳ | Flujo captura→código | ⏳ |

## 4. UI web (solo `/agentes`, con UI-lock)

| Slug | Licencia | Qué se toma | Estado |
|---|---|---|---|
| `microsoft/monaco-editor` | MIT ⏳ | Editor + diff editor | ⏳ |
| `codemirror/dev` | MIT ⏳ | Alternativa de editor | ⏳ |
| `xtermjs/xterm.js` | MIT ⏳ | Terminal por WebSocket al sandbox | ⏳ |
| `brimdata/react-arborist` | MIT ⏳ | Árbol de archivos | ⏳ |
| `shikijs/shiki` | MIT ⏳ | Resaltado | ⏳ |
| `rtfpessoa/diff2html` | MIT ⏳ | Revisión de parches | ⏳ |
| `yjs/yjs` | MIT ⏳ | Colaboración realtime | ⏳ |
| `assistant-ui/assistant-ui` | MIT ⏳ | Chat con streaming | ⏳ |
| `vercel/ai-elements`, `vercel/streamdown` | Apache-2.0 ⏳ | Markdown streaming, reasoning, tool calls | ⏳ |
| `CopilotKit/CopilotKit`, `ag-ui-protocol/ag-ui` | MIT ⏳ | Protocolo eventos agente→UI | ⏳ |
| `codesandbox/sandpack` | Apache-2.0 ⏳ | Previews instantáneas de frontend | ⏳ |
| `pyodide/pyodide` | MPL-2.0 ⏳ | Python cliente **sin modificar** | ⏳ |
| `coder/code-server` | MIT ⏳ | Botón "abrir en VS Code" tras auth | ⏳ |
| `gitpod-io/openvscode-server` | MIT ⏳ | Alternativa al anterior | ⏳ |

## 5. Motor de contexto

| Slug | Licencia | Qué se toma | Estado |
|---|---|---|---|
| `tree-sitter/tree-sitter` | MIT ⏳ | Repomap + chunking | ⏳ |
| `BurntSushi/ripgrep` | MIT/Unlicense ⏳ | Búsqueda textual | ⏳ |
| `ast-grep/ast-grep` | MIT ⏳ | Búsqueda estructural | ⏳ |
| `sourcegraph/zoekt` | Apache-2.0 ⏳ | Trigram en repos grandes | ⏳ |
| `oraios/serena`, `microsoft/multilspy` | MIT ⏳ | LSP semántico (`microsoft/pyright`, MIT) | ⏳ |
| `yamadashy/repomix`, `coderamp-labs/gitingest` | MIT ⏳ | Empaquetar repos en contexto | ⏳ |
| `cocoindex-io/cocoindex` | Apache-2.0 ⏳ | Indexación incremental + embeddings (pgvector ya existe) | ⏳ |
| `potpie-ai/potpie` | Apache-2.0 ⏳ | Grafo de conocimiento del código | ⏳ |
| `Wilfred/difftastic` | MIT ⏳ | Diffs semánticos | ⏳ |
| `isomorphic-git/isomorphic-git` | MIT ⏳ | Git en Node | ⏳ |
| `go-gitea/gitea` | MIT ⏳ | Git hosting interno de proyectos | ⏳ |
| `github/github-mcp-server` | MIT ⏳ | PRs en el GitHub del usuario | ⏳ |

## 6. Modelos y orquestación (prod = DeepSeek; resto es evaluación)

| Slug | Licencia | Nota | Estado |
|---|---|---|---|
| `BerriAI/litellm`, `Portkey-AI/gateway` | MIT ⏳ | Centralizar proveedores + tokens vs créditos | 🧪 |
| `modelcontextprotocol/*` | MIT ⏳ | Extensiones MCP | ⏳ |
| `upstash/context7` | MIT ⏳ | Docs actualizadas | ⏳ |
| Agent Skills + `anthropics/skills` | estándar / por carpeta ⏳ | Revisar licencia por carpeta antes de copiar | ⏳ |
| `agentsmd/agents.md` | MIT ⏳ | Formato AGENTS.md | ⏳ |
| `temporalio/temporal`, `cloudflare/agents` | MIT ⏳ | Tareas largas con reintentos | ⏳ |
| `langchain-ai/langgraph`, `openai/openai-agents-js` | MIT ⏳ | Frameworks referencia | ⏳ |
| `mastra-ai/mastra` | Apache-2.0 ⏳ | Revisar paquetes ELv2 antes de copiar | ⏳ |
| `pydantic/pydantic-ai` | MIT ⏳ | Referencia (backend es TS) | ⏳ |
| `mem0ai/mem0` | Apache-2.0 ⏳ | Memoria usuario/proyecto | ⏳ |
| `langfuse/langfuse` | MIT (núcleo) ⏳ | Trazas y costes | ⏳ |
| `promptfoo/promptfoo`, `SWE-bench/SWE-bench`, `UKGovernmentBEIS/inspect_ai` | MIT ⏳ | Evaluación continua | ⏳ |
| `microsoft/playwright` | Apache-2.0 ⏳ | Verificación visual (ya en CI) | 🔗 parcial |
| `browser-use/browser-use`, `browserbase/stagehand` | MIT ⏳ | Navegación agéntica | ⏳ |
| `steel-dev/steel-browser` | Apache-2.0 ⏳ | Navegador headless | ⏳ |
| `jina-ai/reader` | Apache-2.0 ⏳ | Lectura web | ⏳ |
| `vllm-project/vllm`, `QwenLM/Qwen3-Coder`, `DeepSeek-V4`(pesos), `ggml-org/llama.cpp`, `ollama/ollama` | Apache-2.0 / MIT ⏳ | 🧪 Solo autohospedaje/evaluación y dev local — prod sigue DeepSeek | 🧪 |

## 7. Calidad, seguridad y despliegue de apps generadas

| Slug | Licencia | Qué se toma | Estado |
|---|---|---|---|
| `astral-sh/ruff`, `biomejs/biome` | MIT ⏳ | Linters post-edición del agente | ⏳ |
| `semgrep/semgrep` | LGPL ⏳ | **Solo como binario** (nunca vendorizar código) | ⏳ |
| `gitleaks/gitleaks` | MIT ⏳ | Secretos (ya en CI) | 🔗 |
| `aquasecurity/trivy` | Apache-2.0 ⏳ | Vulns (pendiente: job CI fase 2) | ⏳ |
| `freeedcom/ai-codereviewer` | MIT ⏳ | Base del revisor de PRs | ⏳ |
| `coollabsio/coolify`, `Dokploy/dokploy` | Apache-2.0 ⏳ | Botón Desplegar vía API | ⏳ |
| `supabase/supabase` | Apache-2.0 ⏳ | Backend provisionable por app | ⏳ |
| `traefik/traefik` | MIT ⏳ | Previews por subdominio firmado | ⏳ |

Excluidos (🚫): `Windmill`, `n8n` (uso sostenible), `Open Interpreter`, `Skyvern`, núcleo `Firecrawl`, `PR-Agent`, `Qodo Cover` (AGPL según solicitud — verificado antes de cualquier uso), `Judge0` (GPL), `Zed` (GPL/AGPL). `Anthropic Claude Agent SDK`: términos comerciales — solo dependencia npm si se decide, jamás copiar código.

## Ya integrados antes de este catálogo (🔗)

`openclaw/openclaw` (MIT ✅), `NousResearch/hermes-agent` (MIT ✅),
`anomalyco/opencode` + `sst/opencode` (MIT ✅, sidecar `vendor/opencode` +
arnés codex). Ver `THIRD_PARTY_NOTICES.md` y `.agents/<origen>-upstream`.

## Roadmap de fusión (un PR = una fusión, §25)

- **Fase 1 (este PR):** catálogo + política ejecutable + flag + salud + arquitectura. Cero código copiado.
- **Fase 2:** sandbox OpenSandbox-Docker + API interna + TTL/límites/allowlist.
- **Fase 3:** harness TS (pi + opencode server, plugins deepseek-harness fijado).
- **Fase 4:** plano de control (sesiones Postgres, Redis, WS, créditos) + UI `/agentes` + git + Deploy/Export + e2e.
