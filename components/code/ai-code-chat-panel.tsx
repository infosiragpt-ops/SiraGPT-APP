"use client"

/**
 * AICodeChatPanel — coding chat column for the /code workspace. A focused
 * coding chat that:
 *
 *   - Sends the user's prompt to the existing AI streaming endpoint
 *     (`apiClient.generateAIStream`), reusing the same auth/ token
 *     plumbing the rest of the app already uses.
 *   - Auto-prepends a small system-style hint so the model knows it
 *     is working inside an in-memory workspace and which files are
 *     open. The user can opt-out with the "Sin contexto" toggle.
 *   - Renders model output as markdown-ish text and parses fenced
 *     code blocks. Each block becomes a card with copy + apply +
 *     diff actions, mediated by the workspace context so the editor
 *     and preview update atomically.
 *
 * We deliberately keep this self-contained: no shared state with the
 * /chat page so a refresh on /code is fast and the user's main chat
 * history is unaffected.
 */

import * as React from "react"
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  BrainCircuit,
  Bug,
  Check,
  ChevronDown,
  Clock3,
  CircleHelp,
  ExternalLink,
  Image as ImageIcon,
  LayoutGrid,
  ListChecks,
  Plus,
  Rocket,
  Search,
  Server,
  Sparkles,
  StopCircle,
} from "lucide-react"
import { CodeChatErrorBoundary } from "@/components/code/code-chat-error-boundary"
import { toast } from "sonner"

import { DictationButton } from "@/components/codex/dictation-button"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { CODE_OPEN_TOOL_LAUNCHER_EVENT, useCodeWorkspace } from "@/lib/code-workspace-context"
import { intakeService } from "@/lib/builder/intake-service"
import type { CodeAgentPhase, CodeChatTurn } from "@/lib/code-chat-sessions"
import { computeLineDiff, parseCodeBlocks, type CodeBlock } from "@/lib/code-workspace-utils"
import { detectBlocker } from "@/lib/code-chat-blocker"
import { extractPlanLabel } from "@/lib/code-chat-plan-label"
import {
  buildWriteMetrics,
  formatUsd,
  formatWorked,
  glyphForAction,
  type CodeChatAction,
  type CodeChatMetrics,
} from "@/lib/code-chat-metrics"
import { defaultAgentState, type AgentBuildContext, type AgentPhase } from "@/lib/code-agent/types"
import {
  classifyBuildError,
  isQuickGreeting,
  mergeOverridesIntoPackageJson,
  nextAgentAction,
  promptFromContext,
  renderFiveSections,
} from "@/lib/code-agent/orchestrator"
import {
  FULL_STACK_APP_CONTRACT_PATHS,
  engineTransportInstructions,
  landingSystemPrompt,
  sreSystemPrompt,
  streamOutputFormat,
} from "@/lib/code-agent/prompts"
import { buildViteLandingFiles } from "@/lib/code-agent/vite-scaffold"
import { isSlowModel, recommendFastModel } from "@/lib/code-agent/model-policy"
import { fetchCodeIntakeQuestion } from "@/lib/code/intake-question"
import { opencodeService } from "@/lib/opencode/opencode-service"
import { useOpencodeEngine } from "@/lib/opencode/use-opencode-engine"

import { DiffView } from "./diff-view"

import { DotmCircular15, THINKING_GLYPH_COLOR } from "@/components/ui/dotm-circular-15"

type ComposerMode = "app" | "build" | "plan" | "debug" | "ask" | "image"

const CODE_OPEN_PREVIEW_EVENT = "siragpt:code-open-preview"
const CODE_RUN_PREVIEW_EVENT = "siragpt:code-run-preview"

// Coalesce the (possibly many) file-apply batches an agent emits within a
// single turn into ONE forced preview restart. We deliberately do NOT gate on
// whether THIS batch contains a package.json: editing a file inside an
// already-open Vite/Next project or a cloned GitHub repo must still refresh the
// preview. PreviewPane owns the decision of whether a dev server is actually
// needed (real node project / bound repo) vs a static srcdoc preview, so the
// owner never has to press ▶ Ejecutar.
let autoRunDebounceTimer: ReturnType<typeof setTimeout> | null = null
let autoRunKeySeq = 0

function openPreviewAndMaybeRun(_files: Array<{ path: string; content: string }>): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(CODE_OPEN_PREVIEW_EVENT))
  if (autoRunDebounceTimer) clearTimeout(autoRunDebounceTimer)
  autoRunDebounceTimer = setTimeout(() => {
    autoRunDebounceTimer = null
    autoRunKeySeq += 1
    const detail = { source: "agent", auto: true, force: true, runKey: autoRunKeySeq }
    window.dispatchEvent(new CustomEvent(CODE_RUN_PREVIEW_EVENT, { detail }))
    window.dispatchEvent(new CustomEvent("siragpt:code-run-app", { detail }))
  }, 600)
}

const COMPOSER_MODE_LABEL: Record<ComposerMode, string> = {
  app: "App",
  build: "Build",
  plan: "Plan",
  debug: "Debug",
  ask: "Ask",
  image: "Image",
}

const COMPOSER_PLACEHOLDER: Record<ComposerMode, string> = {
  app: "Describe lo que quieres construir o cambiar — el agente lo hace…",
  build: "Pide un cambio, pega código o / para comandos",
  plan: "Objetivo o plan antes de editar archivos…",
  debug: "Error, stack trace o comportamiento esperado…",
  ask: "Pregunta sobre tu app o tu código — respondo sin tocar archivos…",
  image: "Describe UI, asset o captura…",
}

const COMPOSER_MODE_INSTRUCTION: Record<ComposerMode, string> = {
  app:
    "Modo App (construir desde cero, estilo Replit/Codex): tu meta es entregar un SOFTWARE FULL-STACK profesional que el usuario pueda abrir en APPS, ejecutar y evolucionar desde el chat.\n" +
    "1) AUTONOMÍA TOTAL — NO hagas preguntas de intake. Si falta contexto, PROPÓN internamente un brief completo con defaults razonables (producto, marca, público, estética, módulos, entidades, datos demo) y ejecuta.\n" +
    "2) PLAN + EJECUCIÓN — diseña internamente arquitectura, UX, modelo de datos, API, validaciones, estados, responsive, accesibilidad y pasos de ejecución. No esperes confirmación; convierte ese plan en archivos aplicables.\n" +
    "3) GENERAR — entrega un proyecto Next.js 14 + TypeScript + Prisma + PostgreSQL con tres capas claras:\n" +
    "   • Frontend: app/page.tsx y app/<entidad>/page.tsx con formularios, tablas, loading/empty/error states y navegación.\n" +
    "   • Backend: app/api/<entidad>/route.ts con GET/POST reales por cada entidad.\n" +
    "   • Base de datos: prisma/schema.prisma, lib/db.ts, prisma/seed.ts, .env.example y docker-compose.yml para Postgres local.\n" +
    "   • README.md con comandos: docker compose up -d db, npm install, cp .env.example .env, npm run db:push, npm run db:seed, npm run dev.\n" +
    "   • PROHIBIDO usar arrays globales o almacenamiento en memoria como persistencia primaria. Los datos deben pasar por Prisma.\n" +
    streamOutputFormat({ strictStart: false, paths: FULL_STACK_APP_CONTRACT_PATHS }) +
    "\n" +
    "3) Cierra con 1-3 siguientes pasos sugeridos para iterar (ej. 'añade sección de precios', 'conecta un formulario', 'modo claro/oscuro').",
  build:
    "Modo Build: implementa cambios de código concretos. Si creas o modificas archivos, entrega bloques aplicables con ruta.",
  plan:
    "Modo Plan: analiza primero, propone una arquitectura o pasos claros, identifica riesgos y no cambies archivos hasta que el usuario lo pida.",
  debug:
    "Modo Debug: diagnostica el error con hipótesis verificables, pide el dato mínimo faltante si hace falta y entrega un parche concreto cuando sea posible.",
  ask:
    "Modo Ask (igual que el modo Ask de Replit): responde de forma clara y directa preguntas sobre la app, el código o cómo funciona, con referencias a archivos cuando ayude. NO modifiques ni generes archivos. Si el usuario pide construir, crear o cambiar algo, explícale brevemente cómo se haría y sugiérele cambiar al modo Agent para que lo construya por él.",
  image:
    "Modo Image: ayuda a razonar sobre assets, interfaces, capturas o diseño visual. Si se requiere implementación, tradúcelo a cambios de código.",
}

// Gather config files from the workspace to give the SRE agent enough context
// to propose real overrides (package.json, lockfile, next.config, tsconfig…).
function collectConfigFiles(
  files: Record<string, { path: string; language: string; content: string }>,
): string {
  const wanted = new Set([
    "package.json",
    "package-lock.json",
    "next.config.mjs",
    "next.config.js",
    "vite.config.ts",
    "vite.config.js",
    "tsconfig.json",
    ".npmrc",
  ])
  return Object.values(files)
    .filter((f) => wanted.has(f.path.split("/").pop() || ""))
    .map((f) => `// ${f.path}\n${f.content}`)
    .join("\n\n")
}

// Agent-style narration block (docs/code/code-chat-agent-style-prompt.md): makes
// every assistant reply read like the live-dashboard agent — first-person,
// technical, step-by-step, validating env constraints by name. The badges /
// action-glyph rows / Worked Summary are added by the UI from REAL data; the
// model must NOT fabricate them.
const AGENT_STYLE_BLOCK = [
  "ESTILO DE RESPUESTA (obligatorio):",
  "- Eres un Agente de Ingeniería de Software Senior: planificas, ejecutas y reportas como un dashboard de desarrollo en vivo.",
  "- Escribe en PRIMERA PERSONA y en PRESENTE, con tono técnico, objetivo y proactivo: \"Analizo todos los errores en paralelo\", \"Veo los problemas claramente\", \"Tengo el panorama completo\", \"Los ordeno por prioridad\". Frases cortas (1-2 líneas), sin relleno.",
  "- Abre SIEMPRE con una línea de planificación que empiece con un GERUNDIO y nombre la operación (\"Planificando la verificación de la migración…\", \"Revisando el código de memoria…\", \"Buscando las queries SQL…\"). Ponla como primera línea, sola, seguida del resto en líneas aparte.",
  "- Narra PASO A PASO: una frase breve anuncia la acción → realizas la acción (generas el archivo / usas la herramienta) → describes lo que observas → siguiente acción. No vuelques un bloque de código gigante sin narrar.",
  "- Antes de cambiar o ejecutar código, VALIDA los supuestos del entorno y NÓMBRALOS: columnas/tablas que quizá no existan (p. ej. column \"embedding\" does not exist), dependencias, variables. No asumas que algo existe sin verificarlo.",
  "- Cierra con una síntesis del panorama (\"Tengo el panorama completo: identifico N problemas distintos. Los ordeno por prioridad:\").",
  "- NO inventes resultados ni métricas (tiempo, acciones, líneas, tokens y costo se miden y se muestran solos). Si algo falla por falta de créditos/cuota/clave (402), detente, no reintentes en bucle, y explica qué quedó bloqueado.",
].join("\n")

const CODE_AGENT_PHASE_BLUEPRINT = [
  { key: "plan", label: "Plan" },
  { key: "context", label: "Contexto" },
  { key: "generate", label: "Generar" },
  { key: "apply", label: "Aplicar" },
  { key: "verify", label: "Verificar" },
] as const

type CodeAgentPhaseKey = (typeof CODE_AGENT_PHASE_BLUEPRINT)[number]["key"]

function buildCodeAgentPhases(
  activeKey: CodeAgentPhaseKey,
  overrides: Partial<Record<CodeAgentPhaseKey, Partial<CodeAgentPhase>>> = {},
): CodeAgentPhase[] {
  const activeIndex = Math.max(0, CODE_AGENT_PHASE_BLUEPRINT.findIndex((phase) => phase.key === activeKey))
  return CODE_AGENT_PHASE_BLUEPRINT.map((phase, index) => {
    const override = overrides[phase.key]
    const status =
      override?.status ??
      (index < activeIndex ? "done" : index === activeIndex ? "running" : "pending")
    return {
      key: phase.key,
      label: phase.label,
      status,
      ...(override?.detail ? { detail: override.detail } : {}),
    }
  })
}

function buildSystemContext(
  files: Record<string, { path: string; language: string; content: string }>,
  activePath: string | null,
  folder: { name: string; description?: string | null; instructions?: string | null } | null,
  mode?: ComposerMode,
) {
  const fileList = Object.values(files)
    .map((f) => `- ${f.path} (${f.language})`)
    .join("\n")
  const active = activePath && files[activePath] ? files[activePath] : null
  const activeBlock = active
    ? `\n\nArchivo activo: ${active.path}\n\n\u0060\u0060\u0060${active.language} ${active.path}\n${active.content}\n\u0060\u0060\u0060`
    : ""
  const folderBlock = folder
    ? [
        "",
        `Carpeta activa: ${folder.name}`,
        folder.description ? `Descripción: ${folder.description}` : "",
        folder.instructions ? `Instrucciones del proyecto:\n${folder.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : ""
  const hasNodeProject = Object.keys(files).some((p) => /(^|\/)package\.json$/.test(p))
  // App mode builds the full-stack APPS contract even on an empty workspace —
  // emitting the static-preview rules there would contradict the builder.
  const expectNodeProject = hasNodeProject || mode === "app"
  const previewBlock = mode === "app"
    ? [
        "El workspace alojará un SOFTWARE FULL-STACK real: Next.js 14 App Router",
        "+ TypeScript + Prisma + PostgreSQL. Usa package.json, app/**,",
        "app/api/**, lib/db.ts, prisma/schema.prisma, .env.example y",
        "docker-compose.yml. El preview se arranca automáticamente con el dev server",
        "y prepara la base de datos con db:push/db:seed. NO uses arrays globales",
        "ni almacenamiento en memoria como persistencia primaria.",
      ].join("\n")
    : expectNodeProject
    ? [
        hasNodeProject
          ? "El workspace contiene un PROYECTO Node REAL (hay package.json) — típicamente"
          : "El workspace alojará un PROYECTO Node REAL.",
        "Usa imports npm normales y extensiones .tsx/.ts; el usuario lo ejecuta",
        "con dev server autoejecutado en preview. Respeta el stack ya presente en package.json",
        "si existe.",
      ].join("\n")
    : [
        "El workspace tiene un PREVIEW EN VIVO (navegador embebido) que se",
        "actualiza solo. Escribe SIEMPRE código que se pueda previsualizar sin",
        "build ni npm:",
        "- Web estática: un único index.html autocontenido (puedes usar el CDN de",
        "  Tailwind y enlazar styles.css / app.js locales).",
        "- React/JSX: define un componente App exportado por defecto (export default",
        "  function App()). React 18 y los globales Recharts, d3, lucide, motion y",
        "  AnimatePresence, además de Tailwind, ya están disponibles — NO uses",
        "  imports de paquetes npm (no hay bundler). Importar archivos locales",
        "  .css/.json sí funciona.",
        "- Mantén cada entrega autocontenida y lista para renderizar.",
      ].join("\n")
  return [
    "Eres un asistente de programación que trabaja en un workspace en memoria del navegador.",
    "Cuando devuelvas código pensado para un archivo, usa SIEMPRE este formato para que la app pueda aplicarlo:",
    "",
    "\u0060\u0060\u0060<lenguaje> <ruta>",
    "<contenido COMPLETO del archivo>",
    "\u0060\u0060\u0060",
    "(la ruta va SOLO en el encabezado del bloque — NO añadas líneas `// path:` dentro del contenido;",
    "en package.json un comentario rompe el JSON)",
    folderBlock,
    "",
    previewBlock,
    "",
    AGENT_STYLE_BLOCK,
    "",
    "Archivos disponibles:",
    fileList || "(workspace vacío)",
    activeBlock,
  ].join("\n")
}

export function AICodeChatPanel() {
  const { user, token } = useAuth()
  const {
    selectedModel,
    selectProvider,
    availableModels,
  } = useChat()
  const {
    files,
    activePath,
    applyBlock,
    registerChatFocusHandler,
    activeFolder,
    codeChatSessions,
    activeCodeChatSessionId,
    activeCodeChatSession,
    createCodeChatSession,
    setActiveCodeChatSession,
    patchCodeChatSessionTurns,
    patchAgentState,
  } = useCodeWorkspace()

  const sessionId = activeCodeChatSessionId
  const turns = React.useMemo(
    () => activeCodeChatSession?.turns ?? [],
    [activeCodeChatSession?.turns],
  )
  const agentPhase = activeCodeChatSession?.agent?.phase ?? "idle"

  const setTurns = React.useCallback(
    (updater: React.SetStateAction<CodeChatTurn[]>) => {
      if (!sessionId) return
      patchCodeChatSessionTurns(sessionId, (prev) =>
        typeof updater === "function" ? (updater as (p: CodeChatTurn[]) => CodeChatTurn[])(prev) : updater,
      )
    },
    [patchCodeChatSessionTurns, sessionId],
  )

  const [input, setInput] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [buildingApp, setBuildingApp] = React.useState(false)
  const agentsActive =
    busy || buildingApp || agentPhase === "generating" || agentPhase === "debugging"
  const [includeContext, setIncludeContext] = React.useState(true)
  const [composerMode, setComposerMode] = React.useState<ComposerMode>("app")

  // The /code chat picks its OWN model — a fast, streaming one — independent of
  // the main chat (whose default may be a slow reasoning model that times out
  // the live stream). Auto-selected from the catalog, persisted, user-overridable.
  const [codeModel, setCodeModel] = React.useState<{ name: string; provider?: string } | null>(null)

  // FREE-plan / sparse catalogs return models:[] but the backend still ships a
  // policy.fallbackModel it will route to. Surface it so the composer never gets
  // stuck on "Cargando modelos…" and Ask can stream. (Agent's first build is
  // LLM-free and works even with no model at all.)
  const [fallbackModel, setFallbackModel] = React.useState<{
    name: string
    provider?: string
    displayName?: string
  } | null>(null)

  React.useEffect(() => {
    if ((availableModels && availableModels.length > 0) || fallbackModel) return
    let cancelled = false
    void (async () => {
      try {
        const res = await apiClient.getAIModels("TEXT")
        const fb = (
          res as {
            policy?: { fallbackModel?: { name?: string; provider?: string; displayName?: string } }
          }
        )?.policy?.fallbackModel
        if (!cancelled && fb?.name) {
          setFallbackModel({ name: fb.name, provider: fb.provider, displayName: fb.displayName })
        }
      } catch {
        /* best-effort: deterministic Agent build still works without a model */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [availableModels, fallbackModel])

  React.useEffect(() => {
    if (codeModel || !availableModels || availableModels.length === 0) return
    let restored: { name: string; provider?: string } | null = null
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("code-workspace:model") : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed?.name && availableModels.some((m) => m.name === parsed.name)) restored = parsed
      }
    } catch {
      /* ignore corrupt value */
    }
    const chosen = restored || recommendFastModel(availableModels) || availableModels[0]
    if (chosen) setCodeModel({ name: chosen.name, provider: chosen.provider })
  }, [availableModels, codeModel])

  const chooseCodeModel = React.useCallback((m: { name: string; provider?: string }) => {
    setCodeModel(m)
    try {
      window.localStorage.setItem("code-workspace:model", JSON.stringify(m))
    } catch {
      /* quota / private mode */
    }
  }, [])

  // If a real catalog loads later (e.g. an admin activates models) and our
  // persisted choice is the policy fallback — which isn't in the catalog — drop
  // it so the picker reflects the real list instead of pinning "Gema4".
  React.useEffect(() => {
    if (!availableModels || availableModels.length === 0 || !codeModel) return
    if (availableModels.some((m) => m.name === codeModel.name)) return
    const next = recommendFastModel(availableModels) || availableModels[0]
    if (next) chooseCodeModel({ name: next.name, provider: next.provider })
  }, [availableModels, codeModel, chooseCodeModel])

  // Resolved model the code chat actually uses. Priority:
  //  1. an explicit code-chat choice (codeModel),
  //  2. a fast model derived inline from the catalog (so the FIRST request is
  //     already fast even before the auto-pick effect has run),
  //  3. the main-chat selection as a last resort (may be a slow model).
  const autoFastModel = React.useMemo(
    () => recommendFastModel(availableModels || []),
    [availableModels],
  )
  const activeModelName =
    codeModel?.name || autoFastModel?.name || selectedModel || fallbackModel?.name || ""
  const activeProvider =
    codeModel?.provider || autoFastModel?.provider || selectProvider || fallbackModel?.provider
  // What the model picker shows: the real catalog when present, else the single
  // policy fallback so the user sees "Gema4" rather than an endless spinner.
  const pickerModels = React.useMemo<ModelOption[]>(() => {
    if (availableModels && availableModels.length > 0) return availableModels as ModelOption[]
    if (fallbackModel) {
      return [
        {
          name: fallbackModel.name,
          displayName: fallbackModel.displayName,
          provider: fallbackModel.provider,
        } as ModelOption,
      ]
    }
    return []
  }, [availableModels, fallbackModel])
  // Fast = streaming-friendly (good for the live preview); slow = reasoning/heavy.
  const modelIsFast = !!activeModelName && !isSlowModel(activeModelName)

  // OpenCode engine (opt-in): when configured/reachable, the chat can route
  // prompts through the real agent engine instead of the LLM/builder path.
  const { available: engineAvailable } = useOpencodeEngine()
  const [engineMode, setEngineMode] = React.useState(false)
  // Map<chatSessionId, engineSessionId> so each code chat reuses one engine session.
  const engineSessionRef = React.useRef<Record<string, string>>({})

  const abortRef = React.useRef<AbortController | null>(null)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)
  // Allow Cmd/Ctrl+L from anywhere in the workspace to focus the
  // composer. The provider exposes a small bus so we don't drill refs.
  React.useEffect(() => {
    return registerChatFocusHandler(() => {
      inputRef.current?.focus()
    })
  }, [registerChatFocusHandler])

  // The shell's "Composer" button (⌘I) emits a window event so this
  // panel can switch into the multi-step "build" mode and focus the
  // input without coupling shell ↔ panel through props.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const handler = () => {
      setComposerMode("build")
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener("siragpt:code-composer-mode", handler)
    return () => window.removeEventListener("siragpt:code-composer-mode", handler)
  }, [])

  // Auto-scroll on new content while the user is at the bottom — if
  // they scrolled up to read history, leave them alone.
  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const threshold = 80
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    if (nearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [turns])

  React.useEffect(() => {
    setInput("")
    setBusy(false)
    abortRef.current?.abort()
    abortRef.current = null
  }, [sessionId])

  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), 140)}px`
  }, [input])

  const cancelStream = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setTurns((prev) =>
      prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
    )
  }, [setTurns])

  const sendPrompt = React.useCallback(
    async (prompt: string, override?: { systemPrompt?: string; autoApply?: boolean }) => {
      const normalized = normalizeChatInput(prompt)
      if (shouldWarnUser(normalized)) {
        toast.error(
          `El mensaje supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó.`,
          { duration: 4500 },
        )
      }
      const text = normalized.value.trim()
      if (!text || busy) return
      if (!user || !token) {
        toast.error("Inicia sesión para usar el chat de código.")
        return
      }
      if (!activeModelName) {
        toast.error("Cargando modelos… intenta de nuevo en un momento.")
        return
      }

      if (!sessionId) {
        toast.error("Selecciona o crea un agente de código.")
        return
      }

      // Intake / routing is decided by the agent FSM (nextAgentAction) in
      // `dispatch`; sendPrompt is now a pure LLM-streaming executor. The system
      // prompt can be overridden per role (landing generator, SRE, …).
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `${id}-a`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: text },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          streaming: true,
          agentLabel: "Planificando el turno",
          agentPhases: buildCodeAgentPhases("plan"),
        },
      ])
      setInput("")
      setBusy(true)

      const controller = new AbortController()
      abortRef.current = controller

      const patchAssistant = (patch: Partial<CodeChatTurn>) => {
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, ...patch } : t)),
        )
      }

      const modeInstruction = COMPOSER_MODE_INSTRUCTION[composerMode]
      // Include the recent conversation so the agent actually accumulates the
      // intake context across turns. Without this the chat was stateless per
      // message — it kept re-asking the same questions and never had enough
      // context to generate. `turns` here is the state BEFORE this message was
      // appended, i.e. the genuine prior history.
      const transcript = turns
        .filter((t) => !t.streaming && t.content.trim())
        .slice(-12)
        .map((t) => `${t.role === "user" ? "Usuario" : "Asistente"}: ${t.content}`)
        .join("\n\n")
      const convoBlock = transcript ? `Conversación hasta ahora:\n${transcript}\n\n---\n\n` : ""
      const finalPrompt = override?.systemPrompt
        ? `${AGENT_STYLE_BLOCK}\n\n${override.systemPrompt}\n\n${convoBlock}Usuario: ${text}`
        : includeContext
          ? `${buildSystemContext(files, activePath, activeFolder, composerMode)}\n\n${modeInstruction}\n\n${convoBlock}Usuario: ${text}`
          : `${modeInstruction}\n\n${convoBlock}Usuario: ${text}`

      patchAssistant({
        agentLabel: includeContext ? "Leyendo contexto del workspace" : "Preparando generación",
        agentPhases: buildCodeAgentPhases("context", {
          context: {
            status: "running",
            detail: includeContext
              ? `${Object.keys(files).length} archivo(s) disponibles`
              : "Sin contexto del workspace",
          },
        }),
      })

      // Accumulate the streamed answer locally so onDone can auto-apply the
      // generated files without reading it back out of a setState updater
      // (updaters must stay pure — applyBlock is a side effect).
      let assistantText = ""
      const startedAt = Date.now()
      // Real token usage (+ optional USD cost) from the stream's `usage` frame,
      // delivered just before onClose so it's available when we build metrics.
      let usage: { tokensIn: number; tokensOut: number; costOriginalUsd?: number; costAppliedUsd?: number } | null = null

      try {
        patchAssistant({
          agentLabel: "Generando respuesta con el agente de código",
          agentPhases: buildCodeAgentPhases("generate", {
            context: { status: "done", detail: includeContext ? "Contexto inyectado" : "Omitido por usuario" },
          }),
        })
        await apiClient.generateAIStream(
          {
            provider: activeProvider,
            model: activeModelName,
            prompt: finalPrompt,
            streamId: id,
            // The code chat generates code blocks (e.g. a full index.html);
            // it must use a plain LLM stream, never the web_search/artifact
            // agentic loop (which times out and returns the empty fallback
            // for build-an-app prompts).
            disableAgentic: true,
          },
          (chunk) => {
            assistantText += chunk
            setTurns((prev) =>
              prev.map((t) => {
                if (t.id !== assistantId) return t
                const nextContent = t.content + chunk
                // The first completed line = the planning line is done → stamp the
                // REAL planning duration once (turn start → first line emitted).
                const planPatch =
                  t.planMs == null && nextContent.includes("\n")
                    ? { planMs: Date.now() - startedAt }
                    : {}
                return { ...t, content: nextContent, ...planPatch }
              }),
            )
          },
          () => {
            // Agentic write modes (app/build, plus debug/patch via explicit
            // override) = Replit-style "presented output": the agent applies the
            // generated files itself and opens the live preview, with NO manual
            // "Aplicar" button (the user asked the agentic system to do the
            // writing). Read-only modes (ask/plan/image) pass autoApply:false and
            // never apply. `applied` feeds the Worked-Summary/action-log metrics
            // on the turn (real numbers).
            let applied: Array<{ path: string; content: string }> = []
            patchAssistant({
              agentLabel: "Aplicando cambios al workspace",
              agentPhases: buildCodeAgentPhases("apply", {
                context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                generate: { status: "done", detail: "Stream completado" },
              }),
            })
            if (override?.autoApply ?? (composerMode === "app" || composerMode === "build")) {
              try {
                const blocks = parseCodeBlocks(assistantText).filter((b) => b.path)
                if (blocks.length > 0) {
                  for (const b of blocks) {
                    if (b.path) applyBlock(b.path, b.content)
                  }
                  applied = blocks.map((b) => ({ path: b.path as string, content: b.content }))
                  const hasPkg = blocks.some((b) => /(^|\/)package\.json$/i.test(b.path || ""))
                  const hasHtml = blocks.some((b) => /\.html?$/i.test(b.path || ""))
                  toast.success(
                    hasPkg
                      ? "Proyecto generado — levantando el dev server…"
                      : hasHtml
                        ? "App generada — revisa el preview en vivo →"
                        : `Generados ${blocks.length} archivo(s) — abriendo preview`,
                  )
                  // applyBlock already emits "siragpt:code-open-preview"; make
                  // sure the preview pane is shown even if it was collapsed, and
                  // auto-boot the dev server so the user sees the running result
                  // without hunting for ▶ Ejecutar. The PreviewPane only acts on
                  // this for real Vite/Next projects and degrades silently if the
                  // environment/user can't run apps.
                  openPreviewAndMaybeRun(applied)
                }
              } catch {
                // Auto-apply failed (parse/write error). There is no manual
                // "Aplicar" button anymore, so surface the failure explicitly and
                // tell the user they can still copy the code as a fallback.
                toast.error("No se pudieron aplicar los cambios automáticamente. Usa el botón Copiar de cada bloque.")
                patchAssistant({
                  agentLabel: "No se pudieron aplicar los cambios",
                  agentPhases: buildCodeAgentPhases("apply", {
                    context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                    generate: { status: "done", detail: "Stream completado" },
                    apply: { status: "error", detail: "Fallo al aplicar — copia manual disponible" },
                  }),
                })
              }
            }
            const verifyDetail = applied.length > 0
              ? `${applied.length} archivo(s) aplicado(s)`
              : "Respuesta sin escritura de archivos"
            setTurns((prev) =>
              prev.map((t) => {
                if (t.id !== assistantId) return t
                const base = {
                  ...t,
                  streaming: false,
                  agentLabel: "Turno completado",
                  agentPhases: buildCodeAgentPhases("verify", {
                    context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                    generate: { status: "done", detail: "Respuesta generada" },
                    apply: { status: "done", detail: applied.length > 0 ? "Cambios escritos" : "Nada que aplicar" },
                    verify: { status: "done", detail: verifyDetail },
                  }),
                }
                // Attach the Worked Summary when the turn did file work OR the
                // stream reported real token usage (the Agent Usage figure).
                if (applied.length > 0 || usage) {
                  const { actions, metrics } = buildWriteMetrics(applied, {
                    startedAt,
                    now: Date.now(),
                    getPrevContent: (p) => files[p]?.content ?? "",
                  })
                  // Even a no-file text answer shows an action row (the model
                  // reasoned + produced the reply).
                  const effectiveActions =
                    actions.length > 0 ? actions : [{ kind: "reasoning" as const, label: "Genero la respuesta" }]
                  const withUsage = usage
                    ? {
                        ...metrics,
                        tokensIn: usage.tokensIn,
                        tokensOut: usage.tokensOut,
                        ...(usage.costOriginalUsd != null ? { costOriginalUsd: usage.costOriginalUsd } : {}),
                        ...(usage.costAppliedUsd != null ? { costAppliedUsd: usage.costAppliedUsd } : {}),
                      }
                    : metrics
                  return {
                    ...base,
                    actions: effectiveActions,
                    metrics: withUsage,
                  }
                }
                return base
              }),
            )
            setBusy(false)
            abortRef.current = null
          },
          (err) => {
            // A cancelled/aborted stream (user started a new turn, navigated
            // away, or the SSE socket was cut) is NOT a failure — surface it as
            // a soft "stopped" state that keeps whatever partial content arrived,
            // instead of a scary red "Fetch is aborted" error turn.
            const aborted =
              err?.name === "AbortError" ||
              /\babort|cancel|operation was aborted/i.test(err?.message || "")
            const msg = err?.message || "Error en el chat de código"
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? aborted
                    ? {
                        ...t,
                        streaming: false,
                        agentLabel: "Generación detenida",
                        agentPhases: buildCodeAgentPhases("generate", {
                          generate: { status: "done", detail: "Detenida" },
                        }),
                        content: t.content
                          ? `${t.content}\n\n_Generación detenida._`
                          : "_Generación detenida — vuelve a enviar para reintentar._",
                      }
                    : {
                        ...t,
                        streaming: false,
                        agentLabel: "Error en el turno",
                        agentPhases: buildCodeAgentPhases("generate", {
                          generate: { status: "error", detail: msg },
                        }),
                        content: t.content ? `${t.content}\n\n_${msg}_` : `_${msg}_`,
                      }
                  : t,
              ),
            )
            setBusy(false)
            abortRef.current = null
          },
          controller.signal,
          { onUsage: (u) => { usage = u } },
        )
      } catch (err: any) {
        const aborted =
          err?.name === "AbortError" ||
          /\babort|cancel|operation was aborted/i.test(err?.message || "")
        if (aborted) {
          patchAssistant({
            streaming: false,
            agentLabel: "Generación detenida",
            agentPhases: buildCodeAgentPhases("generate", {
              generate: { status: "done", detail: "Detenida" },
            }),
          })
        } else {
          toast.error(err?.message || "Error en el chat de código")
          patchAssistant({
            streaming: false,
            agentLabel: "Error en el turno",
            agentPhases: buildCodeAgentPhases("generate", {
              generate: { status: "error", detail: err?.message || "Error en el chat de código" },
            }),
          })
        }
        setBusy(false)
        abortRef.current = null
      }
    },
    [
      activePath,
      activeFolder,
      activeModelName,
      activeProvider,
      applyBlock,
      busy,
      composerMode,
      files,
      includeContext,
      sessionId,
      setTurns,
      token,
      turns,
      user,
    ],
  )

  // Deterministic "Construir app" path: bypasses the LLM entirely. For a
  // LANDING goal it builds the Vite 7 + React 18 + TS project locally
  // (lib/code-agent/vite-scaffold — zero network); for APP goals it sends the
  // prompt to /api/builder/generate (pure heuristics → runnable Next.js CRUD).
  // This is the reliable build flow that works even when the chat model / API
  // keys are down.
  const buildApp = React.useCallback(
    async (prompt: string, ctx?: AgentBuildContext) => {
      const text = prompt.trim()
      if (!text || busy || buildingApp) return
      if (!user || !token) {
        toast.error("Inicia sesión para construir la app.")
        return
      }
      if (!sessionId) {
        toast.error("Selecciona o crea un agente de código.")
        return
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: text },
        {
          id: `${id}-a`,
          role: "assistant",
          content: "⚙️ Construyendo la app (modo determinista, sin LLM)…",
          streaming: true,
          agentLabel: "Construyendo app",
          agentPhases: buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Brief recibido" },
            context: { status: "done", detail: ctx ? "Contexto de intake listo" : "Prompt directo" },
            generate: { status: "running", detail: "Generando archivos" },
          }),
        },
      ])
      setInput("")
      setBuildingApp(true)
      const startedAt = Date.now()

      try {
        let appliedFiles: Array<{ path: string; content: string }>
        let summary: string
        let toastMsg: string
        if (ctx && ctx.goal === "landing") {
          // Landing → local Vite scaffold (no network, full landing + Invitar).
          appliedFiles = buildViteLandingFiles(ctx)
          summary = [
            `✅ Landing generada (determinista) — ${appliedFiles.length} archivo(s).`,
            ``,
            `- **Stack:** Vite 7 + React 18 + TypeScript + Tailwind v4`,
            `- **Incluye:** animaciones de scroll (Framer Motion) y el componente «Invitar al proyecto»`,
            ``,
            `Estoy arrancando el **preview en vivo** automáticamente. Itera pidiéndome cambios en el chat.`,
          ].join("\n")
          toastMsg = "Landing generada — arrancando preview →"
        } else {
          const result = await intakeService.generate(text)
          appliedFiles = result.files || []
          if (appliedFiles.length === 0) {
            throw new Error("La generación no devolvió archivos.")
          }
          const entities = result.brief.dataEntities.map((e) => e.name).join(", ") || "—"
          summary = [
            `✅ App generada (determinista) — ${appliedFiles.length} archivo(s).`,
            ``,
            `- **Plataforma:** ${result.brief.platform}`,
            `- **Entidades:** ${entities}`,
            `- **Tipo:** app autónoma de una página (\`index.html\`) que corre en el navegador, sin instalar nada`,
            `- **Datos:** se guardan localmente en el navegador (localStorage)`,
            ``,
            `Estoy abriendo el **preview en vivo** automáticamente. Pídeme cualquier cambio y lo aplico desde este mismo chat.`,
          ].join("\n")
          toastMsg = "App generada — abriendo preview →"
        }
        // Apply index.html LAST so it stays the active tab and the live preview
        // lands on the runnable app rather than a doc file.
        const ordered = [...appliedFiles].sort((a, b) =>
          (/(^|\/)index\.html?$/i.test(a.path) ? 1 : 0) - (/(^|\/)index\.html?$/i.test(b.path) ? 1 : 0),
        )
        for (const file of ordered) {
          applyBlock(file.path, file.content)
        }
        openPreviewAndMaybeRun(appliedFiles)
        const { actions, metrics } = buildWriteMetrics(appliedFiles, {
          startedAt,
          now: Date.now(),
          getPrevContent: (p) => files[p]?.content ?? "",
        })
        setTurns((prev) =>
          prev.map((t) =>
            t.id === `${id}-a`
              ? {
                  ...t,
                  content: summary,
                  streaming: false,
                  agentLabel: "App construida",
                  agentPhases: buildCodeAgentPhases("verify", {
                    plan: { status: "done", detail: "Brief validado" },
                    context: { status: "done", detail: ctx ? "Intake usado" : "Prompt directo" },
                    generate: { status: "done", detail: `${appliedFiles.length} archivo(s)` },
                    apply: { status: "done", detail: "Workspace actualizado" },
                    verify: { status: "done", detail: "Preview abierto" },
                  }),
                  actions,
                  metrics,
                }
              : t,
          ),
        )
        toast.success(toastMsg)
      } catch (err: any) {
        const msg = err?.message || "No se pudo generar la app"
        setTurns((prev) =>
          prev.map((t) =>
            t.id === `${id}-a`
              ? {
                  ...t,
                  content: `_${msg}_`,
                  streaming: false,
                  agentLabel: "Error al construir",
                  agentPhases: buildCodeAgentPhases("generate", {
                    generate: { status: "error", detail: msg },
                  }),
                }
              : t,
          ),
        )
        toast.error(msg)
      } finally {
        setBuildingApp(false)
      }
    },
    [applyBlock, busy, buildingApp, files, sessionId, setTurns, token, user],
  )

  // SRE tier-0: classify the build log locally (no LLM), render the strict
  // 5-section diagnosis, and auto-apply a package.json `overrides` patch when
  // the fix is deterministic. Works even with the model down.
  const runDeterministicSRE = React.useCallback(
    async (log: string, userText: string, sid: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: userText },
        { id: `${id}-a`, role: "assistant", content: "🔧 Diagnosticando el build (modo determinista)…", streaming: true },
      ])
      setInput("")
      const verdict = classifyBuildError(log)
      let body = renderFiveSections(verdict)
      const pkg = files["package.json"]
      if (verdict.suggestedOverrides && pkg) {
        const patched = mergeOverridesIntoPackageJson(pkg.content, verdict.suggestedOverrides)
        if (patched) {
          applyBlock("package.json", patched)
          body += "\n\n_`package.json` actualizado con `overrides` — pulsa **⚡ Construir** para reinstalar._"
        }
      }
      setTurns((prev) => prev.map((t) => (t.id === `${id}-a` ? { ...t, content: body, streaming: false } : t)))
      patchAgentState(sid, (s) => ({ ...s, phase: "idle" }))
    },
    [applyBlock, files, patchAgentState, setTurns],
  )

  // Auto-repair: a failed run (or the preview console "Arreglar con IA" button)
  // emits `siragpt:code-fix-error` with the captured logs. We hand those logs to
  // the agent and let it FIX the code automatically — NO manual submit. With a
  // model available it edits the code (SRE system prompt + autoApply); offline it
  // runs the deterministic SRE (classifies the build log and auto-patches
  // package.json overrides when the fix is deterministic).
  const busyRef = React.useRef(false)
  busyRef.current = busy
  const buildingAppRef = React.useRef(false)
  buildingAppRef.current = buildingApp
  // Synchronous latch so two same-tick events (e.g. an auto error + a manual
  // "Arreglar con IA" tap) can't start two repairs before React re-renders the
  // busy refs. Reset when the repair turn settles.
  const repairInFlightRef = React.useRef(false)

  const repairFromLog = React.useCallback(
    async (log: string) => {
      const text = log.trim()
      if (!text || !user || !token || !sessionId) return
      const sid = sessionId
      patchAgentState(sid, (s) => ({ ...s, phase: "debugging", lastError: text }))
      if (activeModelName) {
        await sendPrompt(
          "Detecté un error en el preview en vivo. Arréglalo en el código y déjalo funcionando.",
          {
            systemPrompt: sreSystemPrompt(text, collectConfigFiles(files)),
            autoApply: true,
          },
        )
      } else {
        await runDeterministicSRE(text, "Detecté un error en el build — diagnóstico automático.", sid)
      }
    },
    [activeModelName, files, patchAgentState, runDeterministicSRE, sendPrompt, sessionId, token, user],
  )
  const repairFromLogRef = React.useRef(repairFromLog)
  repairFromLogRef.current = repairFromLog

  React.useEffect(() => {
    if (typeof window === "undefined") return
    let cancelled = false
    let waitTimer: number | null = null
    const clearWait = () => {
      if (waitTimer !== null) {
        window.clearInterval(waitTimer)
        waitTimer = null
      }
    }
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim()
      if (!text) return
      const fire = () => {
        if (cancelled || repairInFlightRef.current) return
        repairInFlightRef.current = true
        void repairFromLogRef.current(text).finally(() => {
          repairInFlightRef.current = false
        })
      }
      // Idle → repair immediately. Busy (a turn is still streaming) → wait for
      // it to settle, then auto-repair once. Latest error wins; cap the wait so
      // a wedged turn never leaves a timer running.
      if (!busyRef.current && !buildingAppRef.current) {
        fire()
        return
      }
      clearWait()
      let waited = 0
      waitTimer = window.setInterval(() => {
        if (cancelled) {
          clearWait()
          return
        }
        if (!busyRef.current && !buildingAppRef.current) {
          clearWait()
          fire()
          return
        }
        waited += 1
        if (waited > 240) clearWait() // ~120s ceiling (500ms × 240)
      }, 500)
    }
    window.addEventListener("siragpt:code-fix-error", handler)
    return () => {
      cancelled = true
      clearWait()
      window.removeEventListener("siragpt:code-fix-error", handler)
    }
  }, [])

  // Apply a set of {path,content} files to the workspace (index.html last so the
  // live preview lands on the runnable app) and open the preview.
  const applyFilesToWorkspace = React.useCallback(
    (files: Array<{ path: string; content: string }>) => {
      const ordered = [...files].sort(
        (a, b) =>
          (/(^|\/)index\.html?$/i.test(a.path) ? 1 : 0) - (/(^|\/)index\.html?$/i.test(b.path) ? 1 : 0),
      )
      for (const f of ordered) applyBlock(f.path, f.content)
      if (files.length > 0) openPreviewAndMaybeRun(files)
    },
    [applyBlock],
  )

  // Run the deterministic builder for a context and apply its files. Returns the
  // file count. Used as the reliable fallback when the engine yields no code.
  // Landings build locally (vite-scaffold, zero network); app goals use the
  // backend builder and degrade to a local landing shell if it's unreachable.
  const runDeterministicInto = React.useCallback(
    async (ctx: AgentBuildContext): Promise<number> => {
      if (ctx.goal === "landing") {
        const scaffold = buildViteLandingFiles(ctx)
        applyFilesToWorkspace(scaffold)
        return scaffold.length
      }
      try {
        const result = await intakeService.generate(promptFromContext(ctx))
        const files = result.files || []
        if (files.length > 0) {
          applyFilesToWorkspace(files)
          return files.length
        }
      } catch {
        /* backend unreachable → offline landing shell below */
      }
      const fallback = buildViteLandingFiles({ ...ctx, goal: "landing" })
      applyFilesToWorkspace(fallback)
      return fallback.length
    },
    [applyFilesToWorkspace],
  )

  // OpenCode engine path. For a normal chat turn it sends the text; for a BUILD
  // (opts.buildContext) it sends the Vite 7 + React 18 + TS contract prompt and
  // the engine writes the project files into its /workspace (write/edit tools);
  // runEngine then reads the whole tree back into the editor. If the engine
  // yields no usable code (or errors), it falls back to the deterministic
  // builder in the SAME turn — so a build always produces a result.
  const runEngine = React.useCallback(
    async (text: string, sid: string, opts?: { buildContext?: AgentBuildContext; iterate?: boolean }) => {
      const ctx = opts?.buildContext
      const isBuild = !!ctx
      const iterate = !!opts?.iterate
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `${id}-a`
      setTurns((prev) => [
        ...prev,
        { id, role: "user", content: text },
        {
          id: assistantId,
          role: "assistant",
          content: isBuild ? "⚙️ Motor OpenCode construyendo…" : "⚙️ Motor OpenCode trabajando…",
          streaming: true,
          agentLabel: isBuild ? "Construyendo con Motor OpenCode" : "Motor OpenCode trabajando",
          agentPhases: buildCodeAgentPhases("plan", {
            plan: { status: "running", detail: isBuild ? "Preparando build" : "Preparando turno" },
          }),
        },
      ])
      setInput("")
      setBusy(true)
      const controller = new AbortController()
      abortRef.current = controller

      // Live progress rail for the Motor (OpenCode) path — mirrors the
      // deterministic buildApp/sendPrompt rail so Motor turns show the same
      // Plan → Contexto → Generar → Aplicar → Verificar steps.
      const setEnginePhase = (label: string, phases: CodeAgentPhase[]) =>
        setTurns((prev) =>
          prev.map((t) => (t.id === assistantId ? { ...t, agentLabel: label, agentPhases: phases } : t)),
        )

      const startedAt = Date.now()
      const finish = (
        content: string,
        meta?: {
          written?: Array<{ path: string; content: string }>
          read?: Array<{ path: string; content: string }>
          label?: string
          phases?: CodeAgentPhase[]
        },
      ) =>
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== assistantId) return t
            const wrote = !!(meta?.written && meta.written.length > 0)
            const base = {
              ...t,
              content,
              streaming: false,
              agentLabel: meta?.label ?? "Turno completado",
              agentPhases:
                meta?.phases ??
                buildCodeAgentPhases("verify", {
                  plan: { status: "done", detail: "Sesión del motor lista" },
                  context: { status: "done", detail: isBuild ? "Contexto de build listo" : "Workspace leído" },
                  generate: { status: "done", detail: "Motor OpenCode" },
                  apply: {
                    status: "done",
                    detail: wrote ? `${meta!.written!.length} archivo(s) aplicados` : "Sin escritura de archivos",
                  },
                  verify: { status: "done", detail: wrote ? "Workspace actualizado" : "Respuesta entregada" },
                }),
            }
            if (wrote) {
              const { actions, metrics } = buildWriteMetrics(meta!.written!, {
                startedAt,
                now: Date.now(),
                getPrevContent: (p) => files[p]?.content ?? "",
                read: meta?.read,
              })
              return { ...base, actions, metrics }
            }
            return base
          }),
        )

      try {
        let esid = engineSessionRef.current[sid]
        if (!esid) {
          const s = await opencodeService.createSession({})
          esid = String((s && (s.id as string)) || "")
          if (!esid) throw new Error("El motor no devolvió un id de sesión.")
          engineSessionRef.current[sid] = esid
        }

        setEnginePhase(
          isBuild ? "Leyendo contexto del workspace" : "Preparando turno del motor",
          buildCodeAgentPhases("context", {
            plan: { status: "done", detail: "Sesión del motor lista" },
            context: { status: "running", detail: isBuild ? "Preparando build" : "Leyendo workspace" },
          }),
        )

        const sendText = ctx
          ? `${landingSystemPrompt(ctx)}\n\n${engineTransportInstructions()}`
          : iterate
            ? `MODIFICA los archivos que YA existen en tu workspace para lograr: ${text}.\n\nPrimero LEE el código actual con tus herramientas, haz cambios DIRIGIDOS solo donde corresponde y CONSERVA el resto intacto. NO regeneres todo desde cero — edita los archivos existentes (write/edit). Si el proyecto es Vite + React + TypeScript, RESPETA su contrato: extensiones .tsx/.ts y Tailwind v4 vía @tailwindcss/vite (PROHIBIDO crear tailwind.config.js/postcss.config.js o usar directivas v3 \`@tailwind\`).`
            : text

        // OpenCode is event-driven: the POST /message returns an empty shell and
        // the assistant reply arrives over the SSE event stream. We accumulate
        // text parts (by part.id, dropping the echoed user prompt) and resolve
        // when the session goes idle.
        const byId = new Map<string, string>()
        const order: string[] = []
        let resolveIdle: () => void = () => {}
        const idle = new Promise<void>((r) => {
          resolveIdle = r
        })
        const assistantText = () =>
          order
            .map((pid) => byId.get(pid) || "")
            .filter((txt) => txt && txt !== sendText)
            .join("\n")
            .trim()

        const streamP = opencodeService
          .streamEvents((ev) => {
            const d = ev?.data as any
            if (!d || d.sessionID !== esid) return
            if (ev.type === "message.part.updated" && d.part?.type === "text" && typeof d.part.text === "string") {
              if (!byId.has(d.part.id)) order.push(d.part.id)
              byId.set(d.part.id, d.part.text)
              const live = assistantText()
              if (live) setTurns((prev) => prev.map((t) => (t.id === assistantId ? { ...t, content: live.slice(0, 12000) } : t)))
            } else if (ev.type === "session.idle" || ev.type === "session.error") {
              resolveIdle()
            }
          }, controller.signal)
          .catch(() => {})

        setEnginePhase(
          "Generando con Motor OpenCode",
          buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Sesión del motor lista" },
            context: { status: "done", detail: isBuild ? "Contexto de build listo" : "Workspace leído" },
            generate: { status: "running", detail: "El motor está trabajando" },
          }),
        )

        // Kick off the turn (fire-and-forget; content comes via events) and wait
        // for idle, with a safety timeout so we never hang the UI.
        opencodeService.prompt(esid, sendText).catch(() => {})
        // Safety net only: the engine resolves `idle` as soon as it finishes, so
        // simple builds return in seconds and we never wait the full window.
        // This cap only fires if the engine *hangs*. Keep it generous so the
        // agent can build real, larger systems (full web app / ecommerce), then
        // fall back to the deterministic builder so a result is always produced.
        const engineTimeoutMs = isBuild ? 150_000 : 60_000
        await Promise.race([idle, new Promise<void>((r) => setTimeout(r, engineTimeoutMs))])
        controller.abort() // close the events stream
        await streamP.catch(() => {})

        const reply = assistantText()
        const blocks = parseCodeBlocks(reply).filter((b) => b.path)

        if (ctx) {
          // BUILD: read back the ENTIRE project the agent wrote to its /workspace
          // — a real multi-file tree (index.html, styles, scripts, components,
          // config…), not just one file. Falls back to known entry paths + reply
          // code blocks if the listing is empty.
          let engineFiles = await opencodeService.listProjectFiles()
          if (engineFiles.length === 0) {
            const candidates = [
              "package.json",
              "vite.config.ts",
              "tsconfig.json",
              "index.html",
              "src/main.tsx",
              "src/index.css",
              "src/App.tsx",
              // Legacy single-html era entries (old engine sessions).
              "styles.css",
              "style.css",
              "app.js",
              "script.js",
              "main.js",
            ]
            for (const p of candidates) {
              try {
                const c = await opencodeService.readFile(p)
                if (c && c.trim()) engineFiles.push({ path: p, content: c })
              } catch {
                /* missing file → skip */
              }
            }
          }
          const seen = new Set<string>()
          const merged: Array<{ path: string; content: string }> = []
          for (const f of [...engineFiles, ...blocks.map((b) => ({ path: b.path as string, content: b.content }))]) {
            if (f.path && !seen.has(f.path)) {
              seen.add(f.path)
              merged.push(f)
            }
          }
          // Accept a real project: a runnable/known entry, or simply ≥2 files.
          const hasEntry = merged.some((f) => /(^|\/)(index\.html?|package\.json)$/i.test(f.path))
          if (merged.length > 0 && (hasEntry || merged.length >= 2)) {
            applyFilesToWorkspace(merged)
            finish(
              reply ? `${reply}\n\n_(Motor OpenCode: ${merged.length} archivo(s) →)_` : `✅ Motor OpenCode — ${merged.length} archivo(s) →`,
              { written: merged, read: engineFiles },
            )
            toast.success(`Motor OpenCode — ${merged.length} archivo(s) →`)
            return
          }
          // Engine produced nothing usable → reliable deterministic fallback.
          const n = await runDeterministicInto(ctx)
          finish(
            reply
              ? `${reply}\n\n_(El motor no dejó archivos; usé el builder determinista: ${n} archivos.)_`
              : `✅ App generada (builder determinista, ${n} archivos).`,
          )
          toast.success("App generada (builder determinista) →")
          return
        }

        // Iterate: the agent edited files in its workspace ("change the header").
        // Read the whole project back and sync it so edits land in the tree +
        // preview — this is the Replit-style "modify what's not well done" loop.
        if (iterate) {
          const projectFiles = await opencodeService.listProjectFiles()
          const seen = new Set<string>()
          const synced: Array<{ path: string; content: string }> = []
          for (const f of [...projectFiles, ...blocks.map((b) => ({ path: b.path as string, content: b.content }))]) {
            if (f.path && !seen.has(f.path)) {
              seen.add(f.path)
              synced.push(f)
            }
          }
          if (synced.length > 0) {
            applyFilesToWorkspace(synced)
            finish(
              reply ? `${reply}\n\n_(Motor OpenCode: ${synced.length} archivo(s) →)_` : `✅ Cambios aplicados — ${synced.length} archivo(s) →`,
              { written: synced },
            )
            toast.success(`Cambios aplicados — ${synced.length} archivo(s) →`)
            return
          }
        }

        // Plain engine chat: render the reply + apply any code blocks it returned.
        if (blocks.length > 0) {
          applyFilesToWorkspace(blocks.map((b) => ({ path: b.path as string, content: b.content })))
          finish(reply || `✅ Motor OpenCode — ${blocks.length} archivo(s) aplicados →`, {
            written: blocks.map((b) => ({ path: b.path as string, content: b.content })),
          })
          toast.success(`Motor OpenCode — ${blocks.length} archivo(s) →`)
          return
        }

        finish(reply || "_(el motor no devolvió texto)_")
      } catch (err: any) {
        if (ctx) {
          // Engine unreachable/error during a build → still deliver via the builder.
          try {
            const n = await runDeterministicInto(ctx)
            finish(`✅ App generada (builder determinista, ${n} archivos). El motor no respondió.`)
            toast.success("App generada (builder determinista) →")
            return
          } catch {
            /* fall through to error */
          }
        }
        finish(`_${err?.message || "El motor OpenCode no respondió"}_`, {
          label: "Error en el turno",
          phases: buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: "Sesión del motor lista" },
            context: { status: "done", detail: isBuild ? "Contexto de build listo" : "Workspace leído" },
            generate: { status: "error", detail: err?.message || "El motor OpenCode no respondió" },
          }),
        })
        toast.error(err?.message || "El motor OpenCode no respondió")
      } finally {
        try {
          controller.abort()
        } catch {
          /* already closed */
        }
        abortRef.current = null
        setBusy(false)
      }
    },
    [applyFilesToWorkspace, files, runDeterministicInto, setTurns],
  )

  const dispatch = React.useCallback(
    async (rawInput: string, opts?: { forceDeterministic?: boolean }) => {
      const text = rawInput.trim()
      if (!text) return
      if (busy || buildingApp) {
        toast("Espera — sigo procesando el mensaje anterior…")
        return
      }
      if (!user || !token) {
        toast.error("Inicia sesión para usar el chat de código.")
        return
      }
      if (!sessionId) {
        toast.error("Abre o crea un chat de código (la carpeta/agente no está activo). Recarga si abriste una carpeta local que no montó.")
        return
      }
      const sid = sessionId
      if (isQuickGreeting(text)) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setTurns((prev) => [
          ...prev,
          { id, role: "user", content: text },
          {
            id: `${id}-a`,
            role: "assistant",
            content: "Hola. Dime qué quieres construir o cambiar en esta app y empiezo.",
            streaming: false,
          },
        ])
        setInput("")
        patchAgentState(sid, (s) => ({ ...s, phase: "idle" }))
        return
      }
      const agent = activeCodeChatSession?.agent ?? defaultAgentState()
      const action = nextAgentAction(agent, text, {
        mode: composerMode,
        forceDeterministic: opts?.forceDeterministic,
        hasModel: !!activeModelName,
      })

      switch (action.type) {
        case "ask": {
          const qid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const assistantId = `${qid}-a`
          const staticQuestion = action.question
          setTurns((prev) => [
            ...prev,
            { id: qid, role: "user", content: text },
            {
              id: assistantId,
              role: "assistant",
              content: staticQuestion,
              streaming: true,
              agentLabel: "Formulando la siguiente pregunta",
              agentPhases: buildCodeAgentPhases("context", {
                plan: { status: "done", detail: "Intake en curso" },
                context: { status: "running", detail: "Reviso la conversación" },
              }),
            },
          ])
          setInput("")
          patchAgentState(sid, (s) => ({
            ...s,
            phase: "intake",
            intakeStep: action.nextStep,
            context: action.context,
          }))
          setBusy(true)
          try {
            // Upgrade the hardcoded question to a context-aware, LLM-phrased one
            // (adapts to what the user already said). Static stays as the fallback.
            const convo = [...turns, { role: "user", content: text }]
            const dynamicQuestion = await fetchCodeIntakeQuestion(action.slot, convo, staticQuestion)
            // Real steps this turn took, so even an intake question shows an action
            // row (the agent reviewed the conversation + formulated the question).
            const askActions: CodeChatAction[] = [
              { kind: "file_read", label: "Reviso el contexto de la conversación" },
              { kind: "reasoning", label: "Formulo la siguiente pregunta" },
            ]
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? {
                      ...t,
                      content: dynamicQuestion,
                      streaming: false,
                      actions: askActions,
                      agentLabel: "Pregunta lista",
                      agentPhases: buildCodeAgentPhases("verify", {
                        plan: { status: "done", detail: "Intake en curso" },
                        context: { status: "done", detail: "Contexto revisado" },
                        generate: { status: "done", detail: "Pregunta formulada" },
                        apply: { status: "done", detail: "Sin cambios de archivos" },
                        verify: { status: "done", detail: "Pregunta entregada" },
                      }),
                    }
                  : t,
              ),
            )
          } catch {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? {
                      ...t,
                      content: staticQuestion,
                      streaming: false,
                      agentLabel: "Pregunta lista",
                      agentPhases: buildCodeAgentPhases("verify", {
                        plan: { status: "done", detail: "Intake en curso" },
                        context: { status: "done", detail: "Contexto revisado" },
                        generate: { status: "done", detail: "Pregunta formulada" },
                        apply: { status: "done", detail: "Sin cambios de archivos" },
                        verify: { status: "done", detail: "Pregunta entregada" },
                      }),
                    }
                  : t,
              ),
            )
          } finally {
            setBusy(false)
          }
          return
        }
        case "generate": {
          patchAgentState(sid, (s) => ({ ...s, phase: "generating", context: action.context }))
          const hasIntake = !!(action.context.productType || action.context.brand)
          const genPrompt = hasIntake ? promptFromContext(action.context) : text
          // Deterministic tier: enrich a bare context with the raw prompt so the
          // local scaffold still produces niche-coherent copy.
          const buildCtx = hasIntake ? action.context : { ...action.context, productType: text }
          if (!opts?.forceDeterministic && engineMode && engineAvailable) {
            // OpenCode agent (only truly available in Docker AND opt-in via the
            // "Motor" toggle): it writes the project files into its /workspace via
            // a funded model and runEngine reads them back — deterministic
            // fallback inside. Without an explicit Motor opt-in the deterministic
            // builder below is the primary path (fast, no ~30s GCLB stream cut).
            await runEngine(text, sid, { buildContext: action.context })
            patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "llm" }))
          } else {
            // First build → the deterministic builder is the PRIMARY path. It is
            // LLM-free, returns in seconds, and emits a self-contained index.html
            // live preview, so it never hits the ~30s GCLB stream cut that left
            // the chat-streaming generation "cargando" forever on the Reserved VM.
            // (This branch previously streamed the whole project from the chat
            // model — the source of the hang/errors the user reported.)
            await buildApp(genPrompt, buildCtx)
            patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "deterministic" }))
          }
          return
        }
        case "patch": {
          if (engineMode && engineAvailable) {
            await runEngine(action.instruction, sid, { iterate: true })
          } else {
            await sendPrompt(action.instruction, { autoApply: true })
          }
          return
        }
        case "debug": {
          patchAgentState(sid, (s) => ({ ...s, phase: "debugging", lastError: action.log }))
          if (composerMode === "debug" && activeModelName) {
            await sendPrompt(text, {
              systemPrompt: sreSystemPrompt(action.log, collectConfigFiles(files)),
              autoApply: true,
            })
          } else {
            await runDeterministicSRE(action.log, text, sid)
          }
          return
        }
        default:
          // Ask/Plan/Image are read-only: they must stream an answer via
          // sendPrompt (autoApply stays false because composerMode !== "app")
          // and must NEVER route into runEngine, which would apply files.
          if (
            (composerMode === "app" || composerMode === "build") &&
            engineMode &&
            engineAvailable
          ) {
            await runEngine(text, sid)
          } else {
            await sendPrompt(text, { autoApply: composerMode === "app" || composerMode === "build" })
          }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeCodeChatSession,
      activePath,
      activeFolder,
      activeModelName,
      buildApp,
      busy,
      buildingApp,
      composerMode,
      engineAvailable,
      engineMode,
      files,
      includeContext,
      patchAgentState,
      runDeterministicSRE,
      runEngine,
      sendPrompt,
      sessionId,
      setTurns,
      token,
      user,
    ],
  )

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    dispatch(input)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      dispatch(input)
    }
  }

  const activeFileLabel = activePath ? activePath.split("/").pop() || activePath : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50/70 text-foreground dark:bg-zinc-950">
      <div className="shrink-0 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="flex h-9 items-center justify-between gap-2 px-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Agente</span>
          {activeFileLabel ? (
            <span
              className="min-w-0 truncate rounded-md border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/85"
              title={activePath ?? undefined}
            >
              {activeFileLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 overflow-x-auto px-2 pb-2">
          {codeChatSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setActiveCodeChatSession(session.id)}
              className={cn(
                "h-6 shrink-0 rounded-md border px-2 text-[11px] transition-colors",
                session.id === activeCodeChatSessionId
                  ? "border-[#FF0000]/30 bg-[#FF0000]/[0.07] text-foreground"
                  : "border-transparent bg-muted/45 text-muted-foreground hover:border-border/60 hover:text-foreground",
              )}
            >
              {session.title}
            </button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 rounded-md text-muted-foreground"
            aria-label="Nuevo agente"
            title="Nuevo chat en paralelo"
            onClick={() => createCodeChatSession()}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {turns.length === 0 ? (
          <EmptyChat active={agentsActive} />
        ) : (
          <div className="space-y-3">
            {turns.map((turn) => (
              <CodeChatErrorBoundary key={turn.id} label="code-chat-turn">
                <ChatBubble
                  turn={turn}
                  lookupContent={(path) => files[path]?.content ?? ""}
                />
              </CodeChatErrorBoundary>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 border-t border-border/50 bg-background/80 px-3 pb-3 pt-2 backdrop-blur">
        <div className="group rounded-lg border border-border/70 bg-background px-2.5 py-2 shadow-sm transition-[border-color,box-shadow] focus-within:border-[#FF0000]/35 focus-within:shadow-[0_0_0_3px_rgba(255,0,0,0.08)]">
          <Textarea
            aria-label="Mensaje para el chat de código"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={COMPOSER_PLACEHOLDER[composerMode]}
            rows={1}
            disabled={busy}
            className="max-h-[140px] min-h-[28px] resize-none border-0 bg-transparent px-1 py-0.5 text-[13px] leading-[1.45] shadow-none outline-none ring-0 placeholder:text-muted-foreground/55 focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center gap-1.5">
            <ComposerPlusMenu
              mode={composerMode}
              includeContext={includeContext}
              activeFileLabel={activeFileLabel}
              engineAvailable={engineAvailable}
              engineMode={engineMode}
              onModeChange={(mode) => {
                setComposerMode(mode)
                inputRef.current?.focus()
              }}
              onIncludeContextChange={setIncludeContext}
              onEngineModeChange={setEngineMode}
            />
            <ModelPickerInline
              models={pickerModels}
              selectedModel={activeModelName || ""}
              fast={modelIsFast}
              onSelect={(m) => chooseCodeModel({ name: m.name, provider: m.provider })}
            />
            <span className="min-w-0 flex-1" />
            <DictationButton
              variant="light"
              locale={typeof navigator !== "undefined" ? navigator.language : "es-ES"}
              onTranscript={(text) => {
                const chunk = text.trim()
                if (!chunk) return
                setInput((prev) => normalizeChatInput(prev ? `${prev} ${chunk}` : chunk).value)
                inputRef.current?.focus()
              }}
            />
            {busy ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0 rounded-md text-foreground hover:bg-muted"
                onClick={cancelStream}
                aria-label="Detener"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className={cn(
                  "h-7 w-7 shrink-0 rounded-md transition-colors",
                  input.trim()
                    ? "bg-[#FF0000] text-white hover:bg-[#E00000]"
                    : "bg-transparent text-muted-foreground/40",
                )}
                disabled={!input.trim()}
                aria-label="Enviar"
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

function EmptyChat({ active }: { active: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[hsl(var(--accent-violet)/0.28)] bg-[hsl(var(--accent-violet)/0.10)] text-[hsl(var(--accent-violet))]">
        <Sparkles className={cn("h-5 w-5", active && "animate-pulse")} />
      </span>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
        ¿Qué quieres construir?
      </h2>
      <p className="mt-1.5 max-w-[18rem] text-[13px] leading-relaxed text-muted-foreground">
        Describe tu idea y el agente la crea, la ejecuta y la corrige sola.
      </p>
    </div>
  )
}

function ChatBubble({
  turn,
  lookupContent,
}: {
  turn: CodeChatTurn
  lookupContent: (path: string) => string
}) {
  const isUser = turn.role === "user"
  const blocks = React.useMemo(
    () => (turn.role === "assistant" ? parseCodeBlocks(turn.content) : []),
    [turn.content, turn.role],
  )

  // USER messages: right-aligned dark-blue bubble with light text (the spec's
  // user style). No code-block parsing — the user types prompts, not code cards.
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg border border-[#FF0000]/20 bg-[#FF0000]/[0.08] px-3.5 py-2 text-sm leading-relaxed text-foreground shadow-sm">
          {turn.content}
        </div>
      </div>
    )
  }

  // ASSISTANT messages: left-aligned, plain background, clean typography (no
  // colored bubble) — direct text on the interface, with the code-block cards.
  const blocker = detectBlocker(turn.content)
  // Pull the model's gerund-led planning line into the status badge (like the
  // agent dashboard) and narrate the rest. Falls back to a generic badge while
  // streaming before the planning line lands.
  const { label: planLabel, body } = extractPlanLabel(turn.content)
  const liveAgentLabel = planLabel || turn.agentLabel || (turn.streaming ? "Pensando" : "")
  return (
    <div className="text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Asistente
        {liveAgentLabel ? (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#FF0000]/15 bg-[#FF0000]/[0.07] px-2 py-0.5 normal-case tracking-normal text-[#C80000] dark:text-[#FF6B6B]">
            <BrainCircuit className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-medium">{liveAgentLabel}</span>
            {!turn.streaming && typeof turn.planMs === "number" ? (
              <span className="opacity-60">({formatWorked(turn.planMs)})</span>
            ) : null}
            {turn.streaming ? (
              <DotmCircular15 size={16} dotSize={2} color={THINKING_GLYPH_COLOR} ariaLabel="Pensando" className="inline shrink-0" />
            ) : null}
          </span>
        ) : null}
      </div>
      {/* 5-step agent progress rail (Plan → Contexto → Generar → Aplicar →
          Verificar). Populated from REAL turn state by the build/app/engine
          paths; renders nothing for turns that never set agentPhases. */}
      <CodeAgentProgress phases={turn.agentPhases} />
      {/* An out-of-credits / quota error surfaces as a high-visibility panel
          instead of plain prose; otherwise render the assistant text normally. */}
      {blocker ? (
        <ChatBlockerPanel title={blocker.title} rawError={turn.content} url={blocker.url} />
      ) : (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {/* `body` already drops the planning line (now in the badge); strip
              fenced blocks too so prose isn't shown twice (here + block cards). */}
          {blocks.length > 0 ? stripFences(body) : body}
        </div>
      )}
      {(() => {
        const applicable = blocks.filter((b) => b.path)
        return applicable.length >= 2 ? (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">
              {applicable.length} archivos en esta respuesta
            </span>
          </div>
        ) : null
      })()}
      {blocks.map((block) => (
        <CodeBlockCard
          key={block.index}
          block={block}
          existingContent={block.path ? lookupContent(block.path) : ""}
        />
      ))}
      {/* Real action log + mandatory Worked Summary — only when the turn did
          measurable file work (build/app/engine paths populate these). */}
      {turn.actions && turn.actions.length > 0 ? <ChatActionLog actions={turn.actions} /> : null}
      {turn.metrics ? <ChatWorkedSummary metrics={turn.metrics} /> : null}
    </div>
  )
}

function stripFences(text: string): string {
  return text.replace(/```[^\n`]*\n[\s\S]*?```/g, "").trim()
}

function CodeAgentProgress({ phases }: { phases?: CodeAgentPhase[] }) {
  if (!phases || phases.length === 0) return null

  return (
    <div className="mb-2 grid gap-1.5 sm:grid-cols-5">
      {phases.map((phase) => {
        const isDone = phase.status === "done"
        const isRunning = phase.status === "running"
        const isError = phase.status === "error"
        return (
          <div
            key={phase.key}
            className={cn(
              "min-w-0 rounded-md border px-2 py-1.5 text-[11px] leading-tight transition-colors",
              isDone && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              isRunning && "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300",
              isError && "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300",
              phase.status === "pending" && "border-border/60 bg-muted/20 text-muted-foreground",
            )}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px]",
                  isDone && "border-emerald-500/40 bg-emerald-500 text-white",
                  isRunning && "border-blue-500/40 bg-blue-500 text-white",
                  isError && "border-red-500/40 bg-red-500 text-white",
                  phase.status === "pending" && "border-border bg-background text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {isDone ? <Check className="h-3 w-3" /> : isError ? <AlertTriangle className="h-3 w-3" /> : isRunning ? <DotmCircular15 size={14} dotSize={2} color="#ffffff" ariaLabel="Trabajando" className="shrink-0" /> : null}
              </span>
              <span className="truncate font-medium">{phase.label}</span>
            </div>
            {phase.detail ? <div className="mt-1 truncate opacity-75">{phase.detail}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

// Compact action log: the FULL ordered glyph sequence (">_ 📖 ✎ …") + an
// expandable list of the real file paths the agent wrote/read this turn.
function ChatActionLog({ actions }: { actions: CodeChatAction[] }) {
  const [open, setOpen] = React.useState(false)
  if (!actions.length) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
        aria-expanded={open}
      >
        <span className="flex flex-wrap items-center gap-x-1 font-mono leading-none" aria-hidden="true">
          {actions.map((a, i) => (
            <span key={i}>{glyphForAction(a.kind)}</span>
          ))}
        </span>
        <span className="tabular-nums">
          {actions.length} {actions.length === 1 ? "acción" : "acciones"}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3 text-xs">
          {actions.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="font-mono" aria-hidden="true">{glyphForAction(a.kind)}</span>
              <code className="truncate">{a.label}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// "Trabajó N s" — the mandatory Worked Summary, from REAL measured numbers.
// File/line groups show only when there was file work; tokens/cost show only
// when the stream reported real usage (cost omitted when the price is unknown).
function ChatWorkedSummary({ metrics }: { metrics: CodeChatMetrics }) {
  const hasFiles = metrics.filesChanged > 0
  const hasTokens = typeof metrics.tokensIn === "number" || typeof metrics.tokensOut === "number"
  const orig = metrics.costOriginalUsd
  const applied = typeof metrics.costAppliedUsd === "number" ? metrics.costAppliedUsd : orig
  const hasCost = typeof orig === "number" || typeof applied === "number"
  const showStrike = typeof orig === "number" && typeof applied === "number" && applied < orig
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1 font-medium text-foreground">
        <Clock3 className="h-3.5 w-3.5 text-[#FF0000]" aria-hidden="true" />
        Trabajó {formatWorked(metrics.timeWorkedMs)}
      </span>
      {hasFiles ? (
        <>
          <span>· {metrics.actionsCount} {metrics.actionsCount === 1 ? "acción" : "acciones"}</span>
          <span>· {metrics.filesChanged} archivo(s)</span>
          <span className="tabular-nums">· +{metrics.linesAdded} −{metrics.linesRemoved}</span>
        </>
      ) : null}
      {metrics.itemsReadLines > 0 ? (
        <span className="tabular-nums">· {metrics.itemsReadLines} líneas leídas</span>
      ) : null}
      {hasTokens ? (
        <span className="tabular-nums">
          · {(metrics.tokensIn ?? 0) + (metrics.tokensOut ?? 0)} tokens
        </span>
      ) : null}
      {hasCost ? (
        <span className="tabular-nums">
          ·{" "}
          {showStrike ? (
            <span className="mr-1 text-muted-foreground/60 line-through">{formatUsd(orig as number)}</span>
          ) : null}
          {formatUsd((applied ?? orig) as number)}
        </span>
      ) : null}
    </div>
  )
}

function ChatBlockerPanel({ title, rawError, url }: { title: string; rawError: string; url?: string }) {
  const isInternal = url?.startsWith("/")
  return (
    <div className="my-1 rounded-lg border border-[#FF0000]/30 bg-[#FF0000]/[0.08] p-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-[#C80000] dark:text-[#FF6B6B]">
        <AlertTriangle className="h-4 w-4" /> Acción requerida de su parte
      </div>
      <div className="mt-1 text-sm text-foreground">{title}</div>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-2.5 text-[11px] leading-relaxed text-zinc-300">
        {rawError.trim()}
      </pre>
      {url && (
        <a
          href={url}
          target={isInternal ? undefined : "_blank"}
          rel={isInternal ? undefined : "noopener noreferrer"}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-[#FF0000] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#E00000]"
        >
          Añadir créditos <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  )
}

function ComposerPlusMenu({
  mode,
  includeContext,
  activeFileLabel,
  engineAvailable,
  engineMode,
  onModeChange,
  onIncludeContextChange,
  onEngineModeChange,
}: {
  mode: ComposerMode
  includeContext: boolean
  activeFileLabel: string | null
  engineAvailable: boolean
  engineMode: boolean
  onModeChange: (mode: ComposerMode) => void
  onIncludeContextChange: (value: boolean) => void
  onEngineModeChange: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const itemClass = "h-9 gap-2.5 rounded-md px-2.5 text-sm"
  const iconClass = "h-[18px] w-[18px] text-muted-foreground"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-[#FF0000]/[0.07] hover:text-[#C80000] dark:hover:text-[#FF6B6B]"
          aria-label="Modo, contexto y herramientas"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className="w-[292px] rounded-lg border-border/70 p-1.5 shadow-xl"
      >
        <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-normal text-muted-foreground">
          {COMPOSER_MODE_LABEL[mode]}
          {activeFileLabel && includeContext ? ` · ${activeFileLabel}` : ""}
        </DropdownMenuLabel>
        <DropdownMenuItem
          className={itemClass}
          onClick={() => window.dispatchEvent(new CustomEvent(CODE_OPEN_TOOL_LAUNCHER_EVENT))}
        >
          <LayoutGrid className={iconClass} />
          <span>Todas las herramientas</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem
          className={cn(itemClass, mode === "app" && "bg-[#FF0000]/[0.07] font-medium text-foreground")}
          onClick={() => onModeChange("app")}
        >
          <Rocket className={iconClass} />
          <span>App · construir desde cero</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "build" && "bg-[#FF0000]/[0.07] font-medium text-foreground")}
          onClick={() => onModeChange("build")}
        >
          <Sparkles className={iconClass} />
          <span>Build</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "plan" && "bg-[#FF0000]/[0.07] font-medium text-foreground")}
          onClick={() => onModeChange("plan")}
        >
          <ListChecks className={iconClass} />
          <span>Plan</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "debug" && "bg-[#FF0000]/[0.07] font-medium text-foreground")}
          onClick={() => onModeChange("debug")}
        >
          <Bug className={iconClass} />
          <span>Debug</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "ask" && "bg-[#FF0000]/[0.07] font-medium text-foreground")}
          onClick={() => onModeChange("ask")}
        >
          <CircleHelp className={iconClass} />
          <span>Ask</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem
          className={cn(itemClass, mode === "image" && "bg-[#FF0000]/[0.07] font-medium text-foreground")}
          onClick={() => onModeChange("image")}
        >
          <ImageIcon className={iconClass} />
          <span>Image</span>
        </DropdownMenuItem>
        {engineAvailable ? (
          <DropdownMenuCheckboxItem
            checked={engineMode}
            onCheckedChange={(checked) => onEngineModeChange(checked === true)}
            className="h-9 rounded-md text-sm"
          >
            Motor OpenCode
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClass}>
            <BookOpen className={iconClass} />
            <span>Skills</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-lg p-1.5">
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("plan")}>
              Plan de implementación
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("debug")}>
              Diagnóstico de errores
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("build")}>
              Edición de archivos
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClass}>
            <Server className={iconClass} />
            <span>MCP Servers</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-lg p-1.5">
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("ask")}>
              Workspace local
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onModeChange("debug")}>
              Herramientas de código
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuCheckboxItem
          checked={includeContext}
          onCheckedChange={(checked) => onIncludeContextChange(checked === true)}
          className="h-8 rounded-md text-sm"
        >
          Incluir contexto del workspace
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type ModelOption = { name: string; provider?: string; displayName?: string }

function ModelPickerInline({
  models,
  selectedModel,
  fast,
  onSelect,
}: {
  models: ModelOption[]
  selectedModel: string
  fast?: boolean
  onSelect: (model: ModelOption) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  const grouped = React.useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      const provider = m.provider || "Otros"
      if (!map.has(provider)) map.set(provider, [])
      map.get(provider)!.push(m)
    }
    return Array.from(map.entries())
  }, [models])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return grouped
    return grouped
      .map(([provider, list]) => [
        provider,
        list.filter((m) => {
          const label = (m.displayName || m.name).toLowerCase()
          return label.includes(q) || provider.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        }),
      ] as const)
      .filter(([, list]) => list.length > 0)
  }, [grouped, query])

  const active = models.find((m) => m.name === selectedModel)
  const label = active?.displayName || active?.name || selectedModel || "Modelo"

  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 max-w-[min(168px,38vw)] shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
            "border-border/45 bg-background/60 text-foreground/75 hover:border-border hover:bg-muted/40 hover:text-foreground",
            "data-[state=open]:border-[#FF0000]/30 data-[state=open]:bg-[#FF0000]/[0.06] data-[state=open]:text-foreground",
          )}
          aria-label="Seleccionar modelo"
          title={
            fast
              ? `${label} — recomendado para preview en vivo`
              : `${label} — modelo de razonamiento; puede ser más lento en preview`
          }
        >
          {!fast ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500/80" aria-hidden />
          ) : null}
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-45" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={16}
        className="z-[1000] w-[min(300px,calc(100vw-24px))] overflow-hidden rounded-lg border border-border/60 bg-popover p-0 text-popover-foreground shadow-[0_16px_48px_rgba(15,23,42,0.14)]"
      >
        <div className="border-b border-border/50 px-2.5 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar modelo…"
              className="h-8 border-0 bg-muted/40 pl-8 text-xs shadow-none focus-visible:ring-1"
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
        <div className="max-h-[min(320px,calc(100vh-180px))] overflow-y-auto p-1">
          {models.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Cargando modelos…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Sin coincidencias
            </div>
          ) : (
            filtered.map(([provider, list], i) => (
              <React.Fragment key={provider}>
                {i > 0 ? <DropdownMenuSeparator className="my-1" /> : null}
                <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  {provider}
                </DropdownMenuLabel>
                {list.map((m) => {
                  const selected = m.name === selectedModel
                  const itemLabel = m.displayName || m.name
                  const itemFast = !isSlowModel(m.name)
                  return (
                    <DropdownMenuItem
                      key={m.name}
                      onClick={() => {
                        onSelect(m)
                        setOpen(false)
                      }}
                      className={cn(
                        "cursor-pointer rounded-lg px-2 py-1.5 text-[13px] font-normal",
                        selected && "bg-[#FF0000]/[0.07] text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{itemLabel}</span>
                      {itemFast ? (
                        <span className="ml-2 shrink-0 text-[10px] text-muted-foreground/70">Rápido</span>
                      ) : null}
                      {selected ? <Check className="ml-2 h-3.5 w-3.5 shrink-0 text-[#FF0000]" /> : null}
                    </DropdownMenuItem>
                  )
                })}
              </React.Fragment>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CodeBlockCard({
  block,
  existingContent,
}: {
  block: CodeBlock
  existingContent: string
}) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const diffLines = React.useMemo(
    () => (open && block.path ? computeLineDiff(existingContent, block.content) : []),
    [block.content, block.path, existingContent, open],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span>{block.language || "código"}</span>
        {block.path ? <span className="text-foreground/80">{block.path}</span> : <span className="italic">sin ruta</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={copy}>
            {copied ? "Copiado" : "Copiar"}
          </Button>
          {block.path ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setOpen((v) => !v)}
              >
                {open ? "Ocultar diff" : "Ver diff"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="p-2">
          <DiffView lines={diffLines} />
        </div>
      ) : (
        <pre className="max-h-72 overflow-auto p-3 font-mono text-[12px] leading-relaxed">{block.content}</pre>
      )}
    </div>
  )
}
