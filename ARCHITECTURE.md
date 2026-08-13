# ARCHITECTURE — AgentRunner (Fase 1)

> Diseño técnico de la fase activa (F1). El inventario completo de fases futuras y
> sus dependencias vive en `ROADMAP.md`; el estado actual en `STATE.md`.

## Arquitectura actual vs objetivo

**Antes (anti-patrón):** el chat clasifica la intención y enruta a editores
hardcodeados. "crea una ppt" → `/api/doc/generate` → `advanced-document-pipeline`
con temas fijos (por eso una PPT rosada salía como deck "boardroom" oscuro hasta que
se parcheó el tema). Cada pedido nuevo (un hex, una coma, una lámina extra) exige
código nuevo.

**Objetivo (F1, este PR):** un loop genérico estilo Claude. El modelo recibe tools y
resuelve CUALQUIER pedido escribiendo y ejecutando su propio código en un sandbox.
El pipeline viejo queda como fallback solo si el runner no entrega archivo.

## Mapa de componentes

```
backend/src/services/agent-runner/
├── index.js      shouldRunAgentRunner · runAgentRunner · runAgentRunnerForChat
│                 · executeAgentRunnerTurn · runAgentRunnerForDocRoute
├── loop.js       loop LLM→tool_call→tool_result→LLM (tope 25, gate de verificación)
├── tools.js      definiciones + executors (ver contrato abajo) · NAMED_COLORS
├── prompt.js     system prompt (verificación obligatoria, contenido = pedido real)
├── react.js      fallback ReAct para modelos sin tool_calls nativos
├── verify.js     needsVerification: sin render_preview tras editar NO hay éxito
├── artifacts.js  GeneratedArtifact (PostgreSQL) · resolveTurnFiles · persistOutputs
├── queue.js      BullMQ opcional (AGENT_RUNNER_ASYNC=1) + Redis pub/sub → SSE
├── office_helpers.py  helpers stdlib inyectados al sandbox (carga lazy/fail-open)
└── office-helpers.js  appendTextSlide determinista (lámina de gracias)
```

Entradas al runner:

- **Chat**: `agentic-chat-stream.js` corre el runner como preloop cuando
  `shouldRunAgentRunner` dispara (archivos adjuntos, artefactos previos, frases de
  crear documento, follow-ups de estilo como "ponlas todas rosadas" o un hex).
- **`/api/doc/generate`** (`routes/doc.js`): runner-first vía
  `runAgentRunnerForDocRoute`; `advanced-document-pipeline` solo si el runner no
  produce archivo. `pptx-design-system.js` conserva el parche "el color pedido gana"
  como red de seguridad.
- **Modelo**: por env — `SIRAGPT_AGENT_RUNNER_MODEL` → `SIRAGPT_DOC_AGENT_MODEL` →
  `OPENROUTER_MODEL` → default. Cambiar de modelo no requiere cambiar código.
- **SSE/BullMQ**: por defecto in-process (`AGENT_RUNNER_ASYNC` off) para que el SSE
  del chat fluya sin Redis; con `AGENT_RUNNER_ASYNC=1` el turno se encola en BullMQ
  y los eventos llegan por Redis pub/sub.

## Contrato de tools

| Tool | Contrato |
|---|---|
| `execute_python` | Python 3 en el sandbox (`python-pptx`, `python-docx`, `openpyxl`, `lxml`, `Pillow`, `zipfile`). 120 s, sin red. |
| `execute_bash` | bash en `/workspace` (zip/unzip, grep/sed, `soffice --headless`). 120 s, sin red. |
| `read_file` / `write_file` | Texto UTF-8, rutas relativas a `/workspace`. |
| `edit_file` | Reemplazo EXACTO de string; `old_str` debe aparecer exactamente una vez. |
| `list_files` | Listado recursivo con tamaños. |
| `glob` | Archivos por patrón (`*.pptx`, `ppt/slides/*.xml`). |
| `grep` | Búsqueda de texto/regex en archivos del workspace. |
| `render_preview` | pptx/docx → PNG vía LibreOffice + brillo por lámina. Si `soffice` no existe, lo dice honestamente y exige verificación por XML. OBLIGATORIO tras cada edición. |
| `create_presentation` | Deck NUEVO con **outline del modelo** (títulos + bullets del tema real). Color: CUALQUIER nombre o `#hex`; sin color → default claro limpio, **nunca rosado por defecto**. |
| `set_slide_background` | Atajo opcional: pintar fondo(s) de un pptx existente (hex o nombre). |

Errores de tool vuelven como string `ERROR: …` (el loop nunca lanza; el modelo ve el
fallo y se adapta). Resultados capados a 30 000 chars.

## Artefactos versionados

Cada output válido se persiste vía `saveArtifact` + upsert en `GeneratedArtifact`
(PostgreSQL, índice `userId, chatId, createdAt`). `resolveTurnFiles` carga para cada
turno la ÚLTIMA versión editada ANTES que cualquier upload re-adjuntado, de modo que
"ahora ponlas rosadas" edita el resultado anterior, no el original.

## Regla de verificación

1. Ningún éxito declarado sin verificación (`verify.js` lo fuerza en el loop, no
   solo en el prompt): tras un tool de edición, el modelo DEBE llamar
   `render_preview` y reinspeccionar el archivo programáticamente (hex en el XML
   OOXML, textos por slide vía `zipfile`).
2. ≤3 reintentos de verificación; si sigue fallando, el turno termina con
   `verification_failed` y un mensaje honesto en español.
3. Además del loop, `runAgentRunner` valida los outputs (estructura OOXML) y
   reintenta ≤3 veces si no hay archivo válido.

## Seguridad (F1)

- Contenido de archivos subidos y de la web es **DATOS, no instrucciones** (en el
  system prompt; hardening profundo = fases F5/F6).
- Sandbox por conversación (`persistKey = chatId`), sin red, timeout por comando.
- Artefactos scoped por `userId`; la descarga pasa por rutas autenticadas.
- Acciones destructivas o envíos externos requieren confirmación humana (no hay
  tools de ese tipo en F1).

## Qué NO es F1

Planner/sub-agentes, browser Playwright, voz, cliente MCP, memoria pgvector/GraphRAG,
marketplace de skills, dashboard de evals, gVisor/Firecracker, migración a Drizzle,
deploy PM2. Todo eso está secuenciado en `ROADMAP.md`.
