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
  Bug,
  Check,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  Image as ImageIcon,
  ListChecks,
  Plus,
  Rocket,
  Server,
  Sparkles,
  StopCircle,
} from "lucide-react"
import { toast } from "sonner"

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
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { CODE_OPEN_TOOL_EVENT, useCodeWorkspace } from "@/lib/code-workspace-context"
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
import { defaultAgentState, type AgentBuildContext, type AgentPhase, type ComposerMode } from "@/lib/code-agent/types"
import { getComposerQuickAction, type ComposerQuickActionId } from "@/lib/code-agent/composer-actions"
import {
  classifyBuildError,
  isQuickGreeting,
  mergeOverridesIntoPackageJson,
  nextAgentAction,
  promptFromContext,
  renderFiveSections,
} from "@/lib/code-agent/orchestrator"
import {
  engineTransportInstructions,
  FULL_STACK_APP_CONTRACT_PATHS,
  contractPathsForContext,
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
import { AgentSwarm } from "./agent-swarm"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

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

type AgentRuntimeStep = {
  phase: AgentPhase
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const AGENT_RUNTIME_STEPS: AgentRuntimeStep[] = [
  { phase: "intake", label: "Plan", icon: CircleHelp },
  { phase: "generating", label: "Diseñar", icon: Rocket },
  { phase: "preview", label: "Resultado", icon: Check },
  { phase: "debugging", label: "Reparar", icon: Bug },
]

const AGENT_RUNTIME_STATUS: Record<AgentPhase, string> = {
  idle: "Listo",
  intake: "Planificando",
  generating: "Diseñando",
  preview: "Resultado listo",
  debugging: "Diagnosticando",
}

const COMPOSER_MODE_INSTRUCTION: Record<ComposerMode, string> = {
  app:
    "Modo App (construir desde cero, estilo Replit/Codex): tu meta es entregar software FULL-STACK profesional como un proyecto Next.js 14 + TypeScript + Prisma, con frontend, backend y base de datos desde una sola instrucción.\n" +
    "1) AUTONOMÍA TOTAL — NO hagas preguntas de intake. Si falta contexto, PROPÓN internamente un brief completo con defaults razonables (producto, marca, público, estética, secciones/funciones, datos demo) y ejecuta. El usuario pidió que la IA proponga y que los agentes trabajen: diseña el plan extendido tú mismo y entrega resultado.\n" +
    "2) PLAN + EJECUCIÓN — antes de escribir código, planifica internamente arquitectura, entidades, relaciones, API, UX, estados, responsive, accesibilidad y validación del preview. No esperes confirmación; convierte ese plan en archivos aplicables.\n" +
    "3) GENERAR — entrega un PROYECTO Next.js 14 App Router COMPLETO. Capas obligatorias:\n" +
    "   • Frontend: app/page.tsx y app/<entidad>/page.tsx con navegación, formularios, tablas, filtros, estados vacío/cargando/error y UI responsive profesional.\n" +
    "   • Backend: app/api/<entidad>/route.ts y app/api/<entidad>/[id]/route.ts con CRUD real. Cada acción visible debe usar fetch contra una API propia.\n" +
    "   • Base de datos: prisma/schema.prisma, lib/db.ts, .env.example y README con comandos. Usa Prisma como fuente de verdad; PROHIBIDO dejar arrays en memoria como persistencia principal.\n" +
    "   • Calidad: dominio coherente, copy real del negocio, diseño sobrio de software operativo, validaciones de formulario y rutas listas para publicación.\n" +
    streamOutputFormat({ strictStart: false, paths: FULL_STACK_APP_CONTRACT_PATHS }) +
    "\n" +
    "4) Cierra con 1-3 siguientes pasos sugeridos para iterar (ej. 'añade autenticación', 'conecta pagos', 'agrega roles').",
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
  const activeIndex = Math.max(0, CODE_AGENT_PHASE_BLUEPRINT.findIndex((p) => p.key === activeKey))
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

function countWorkspaceContextLines(
  files: Record<string, { path: string; language: string; content: string }>,
  activePath: string | null,
  includeContext: boolean,
): number {
  if (!includeContext) return 0
  const active = activePath && files[activePath] ? files[activePath] : null
  const fileListLines = Object.keys(files).length
  const activeLines = active?.content ? active.content.split("\n").length : 0
  return fileListLines + activeLines
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
  const expectFullStackApp = mode === "app"
  const expectViteProject = hasNodeProject && !expectFullStackApp
  const previewBlock = expectFullStackApp
    ? [
        hasNodeProject
          ? "El workspace contiene un PROYECTO Node REAL y el modo App debe mantenerlo como software full-stack."
          : "El workspace alojará un PROYECTO Node REAL (modo App) con tres capas.",
        "Contrato App: Next.js 14 App Router + TypeScript, páginas en app/**, Route Handlers",
        "en app/api/**, Prisma como capa de base de datos, lib/db.ts como cliente compartido,",
        ".env.example con DATABASE_URL y README con comandos de ejecución/publicación.",
        "Cada entidad visible debe tener UI, API y modelo de datos; no uses arrays en memoria como persistencia principal.",
      ].join("\n")
    : expectViteProject
    ? [
        hasNodeProject
          ? "El workspace contiene un PROYECTO Node REAL (hay package.json) — típicamente"
          : "El workspace alojará un PROYECTO Node REAL — típicamente",
        "Vite 7 + React 18 + TypeScript. Usa imports npm normales y extensiones",
        ".tsx/.ts; el usuario lo ejecuta con ▶ Ejecutar (dev server). RESPETA el",
        "contrato del proyecto: Tailwind v4 vía @tailwindcss/vite (PROHIBIDO crear",
        "tailwind.config.js/postcss.config.js o usar directivas v3 `@tailwind`),",
        'src/index.css empieza con `@import "tailwindcss";` + paleta como CSS custom',
        "properties en :root, animaciones con Framer Motion e iconos lucide-react.",
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
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: ComposerMode; prompt?: string }>).detail
      setComposerMode(detail?.mode ?? "build")
      if (typeof detail?.prompt === "string") setInput(detail.prompt)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener("siragpt:code-composer-mode", handler)
    return () => window.removeEventListener("siragpt:code-composer-mode", handler)
  }, [])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ mode?: ComposerMode; prompt?: string }>).detail
      setComposerMode(detail?.mode ?? "app")
      setInput(
        detail?.prompt ??
          "Quiero construir una app web completa. Ayúdame a definirla y genera el proyecto con preview.",
      )
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener("siragpt:code-agent-prompt", handler)
    return () => window.removeEventListener("siragpt:code-agent-prompt", handler)
  }, [])

  // "Arreglar con IA" from the preview console pre-loads the composer with the
  // captured error so the user can send a fix in one tap.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim()
      if (!text) return
      setComposerMode("debug")
      setInput(`Arregla este error que aparece en el preview en vivo:\n\n${text}`)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    window.addEventListener("siragpt:code-fix-error", handler)
    return () => window.removeEventListener("siragpt:code-fix-error", handler)
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

      const contextLines = countWorkspaceContextLines(files, activePath, includeContext)
      const baseActions: CodeChatAction[] = [
        { kind: "reasoning", label: "Planifico el objetivo y el modo del composer" },
        ...(includeContext
          ? [{ kind: "file_read" as const, label: activePath ? `Leo contexto de ${activePath}` : "Leo contexto del workspace" }]
          : []),
      ]

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
            // The /code panel owns a browser-workspace agent (intake FSM,
            // OpenCode engine, deterministic builder, auto-apply + preview).
            // Do not route this turn into the backend host-file/web agent:
            // that runtime sees the server filesystem, not the in-browser
            // workspace the user is editing here.
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
            // App mode (or an explicit override) = Replit-style "presented
            // output": auto-apply the generated files and open the live preview
            // so the user sees the result immediately. Other modes keep the
            // manual "Aplicar" button (review-before-write). `applied` is fed to
            // the Worked-Summary/action-log metrics on the turn (real numbers).
            let applied: Array<{ path: string; content: string }> = []
            patchAssistant({
              agentLabel: "Aplicando cambios al workspace",
              agentPhases: buildCodeAgentPhases("apply", {
                context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                generate: { status: "done", detail: "Stream completado" },
              }),
            })
            if (override?.autoApply ?? composerMode === "app") {
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
                      ? "Proyecto generado — pulsa ▶ Ejecutar para levantar el dev server"
                      : hasHtml
                        ? "App generada — revisa el preview en vivo →"
                        : `Generados ${blocks.length} archivo(s) — abriendo preview`,
                  )
                  // applyBlock already emits "siragpt:code-open-preview"; make
                  // sure the preview pane is shown even if it was collapsed.
                  if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))
                  }
                }
              } catch {
                /* parsing/apply failure → user can still apply manually */
              }
            }
            const writeSummary = buildWriteMetrics(applied, {
              startedAt,
              now: Date.now(),
              getPrevContent: (p) => files[p]?.content ?? "",
            })
            const effectiveActions: CodeChatAction[] = [
              ...baseActions,
              ...(writeSummary.actions.length > 0
                ? writeSummary.actions
                : [{ kind: "reasoning" as const, label: "Genero la respuesta final" }]),
            ]
            const effectiveMetrics: CodeChatMetrics = {
              ...writeSummary.metrics,
              actionsCount: effectiveActions.length,
              itemsReadLines: writeSummary.metrics.itemsReadLines + contextLines,
              ...(usage
                ? {
                    tokensIn: usage.tokensIn,
                    tokensOut: usage.tokensOut,
                    ...(usage.costOriginalUsd != null ? { costOriginalUsd: usage.costOriginalUsd } : {}),
                    ...(usage.costAppliedUsd != null ? { costAppliedUsd: usage.costAppliedUsd } : {}),
                  }
                : {}),
            }
            const verifyDetail = applied.length > 0
              ? `${applied.length} archivo(s) aplicado(s)`
              : "Respuesta sin escritura de archivos"
            setTurns((prev) =>
              prev.map((t) => {
                if (t.id !== assistantId) return t
                const base = { ...t, streaming: false }
                return {
                  ...base,
                  agentLabel: "Turno completado",
                  agentPhases: buildCodeAgentPhases("verify", {
                    context: { status: "done", detail: includeContext ? "Contexto usado" : "Sin contexto" },
                    generate: { status: "done", detail: "Respuesta generada" },
                    apply: { status: "done", detail: applied.length > 0 ? "Cambios escritos" : "Nada que aplicar" },
                    verify: { status: "done", detail: verifyDetail },
                  }),
                  actions: effectiveActions,
                  metrics: effectiveMetrics,
                }
              }),
            )
            setBusy(false)
            abortRef.current = null
          },
          (err) => {
            const msg = err?.message || "Error en el chat de código"
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? {
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
          {
            onUsage: (u) => { usage = u },
            onReplace: (replacement) => {
              assistantText = replacement
              patchAssistant({ content: replacement })
            },
          },
        )
      } catch (err: any) {
        toast.error(err?.message || "Error en el chat de código")
        patchAssistant({
          streaming: false,
          agentLabel: "Error en el turno",
          agentPhases: buildCodeAgentPhases("generate", {
            generate: { status: "error", detail: err?.message || "Error en el chat de código" },
          }),
        })
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
          content: "Construyendo la app (modo determinista, sin LLM)...",
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
            `Pulsa **▶ Ejecutar** para instalar dependencias y ver la landing en vivo. Itera pidiéndome cambios en el chat.`,
          ].join("\n")
          toastMsg = "Landing generada — pulsa ▶ Ejecutar →"
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
            `- **Stack:** ${result.blueprint.stack.frontend}`,
            ``,
            `Revisa el **preview en vivo** → y el código en el árbol de archivos. Itera pidiéndome cambios en el chat.`,
          ].join("\n")
          toastMsg = "App generada — revisa el preview en vivo →"
        }
        // Apply index.html LAST so it stays the active tab and the live preview
        // lands on the runnable app rather than a doc file.
        const ordered = [...appliedFiles].sort((a, b) =>
          (/(^|\/)index\.html?$/i.test(a.path) ? 1 : 0) - (/(^|\/)index\.html?$/i.test(b.path) ? 1 : 0),
        )
        for (const file of ordered) {
          applyBlock(file.path, file.content)
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))
        }
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

  // Apply a set of {path,content} files to the workspace (index.html last so the
  // live preview lands on the runnable app) and open the preview.
  const applyFilesToWorkspace = React.useCallback(
    (files: Array<{ path: string; content: string }>) => {
      const ordered = [...files].sort(
        (a, b) =>
          (/(^|\/)index\.html?$/i.test(a.path) ? 1 : 0) - (/(^|\/)index\.html?$/i.test(b.path) ? 1 : 0),
      )
      for (const f of ordered) applyBlock(f.path, f.content)
      if (files.length > 0 && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))
      }
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
          agentLabel: isBuild ? "OpenCode construyendo" : "OpenCode trabajando",
          agentPhases: buildCodeAgentPhases("generate", {
            plan: { status: "done", detail: isBuild ? "Contrato de build preparado" : "Instrucción recibida" },
            context: { status: "running", detail: "Sincronizando sesión del motor" },
          }),
        },
      ])
      setInput("")
      setBusy(true)
      const controller = new AbortController()
      abortRef.current = controller

      const startedAt = Date.now()
      const finish = (
        content: string,
        meta?: { written?: Array<{ path: string; content: string }>; read?: Array<{ path: string; content: string }> },
      ) =>
        setTurns((prev) =>
          prev.map((t) => {
            if (t.id !== assistantId) return t
            const base = { ...t, content, streaming: false }
            if (meta?.written && meta.written.length > 0) {
              const { actions, metrics } = buildWriteMetrics(meta.written, {
                startedAt,
                now: Date.now(),
                getPrevContent: (p) => files[p]?.content ?? "",
                read: meta.read,
              })
              return {
                ...base,
                agentLabel: "Motor completado",
                agentPhases: buildCodeAgentPhases("verify", {
                  plan: { status: "done", detail: "Objetivo definido" },
                  context: { status: "done", detail: meta.read?.length ? `${meta.read.length} archivo(s) leido(s)` : "Sesión lista" },
                  generate: { status: "done", detail: "Respuesta recibida" },
                  apply: { status: "done", detail: `${meta.written.length} archivo(s)` },
                  verify: { status: "done", detail: "Workspace sincronizado" },
                }),
                actions,
                metrics,
              }
            }
            return {
              ...base,
              agentLabel: "Motor completado",
              agentPhases: buildCodeAgentPhases("verify", {
                plan: { status: "done", detail: "Objetivo definido" },
                context: { status: "done", detail: "Sesión lista" },
                generate: { status: "done", detail: "Respuesta recibida" },
                apply: { status: "done", detail: "Nada que aplicar" },
                verify: { status: "done", detail: "Texto entregado" },
              }),
            }
          }),
        )

      try {
        let esid = engineSessionRef.current[sid]
        if (!esid) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === assistantId
                ? {
                    ...t,
                    agentLabel: "Creando sesión OpenCode",
                    agentPhases: buildCodeAgentPhases("context", {
                      plan: { status: "done", detail: "Objetivo definido" },
                      context: { status: "running", detail: "Creando sesión" },
                    }),
                  }
                : t,
            ),
          )
          const s = await opencodeService.createSession({})
          esid = String((s && (s.id as string)) || "")
          if (!esid) throw new Error("El motor no devolvió un id de sesión.")
          engineSessionRef.current[sid] = esid
        }

        const sendText = ctx
          ? `${landingSystemPrompt(ctx)}\n\n${engineTransportInstructions({ paths: contractPathsForContext(ctx) })}`
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

        // Kick off the turn (fire-and-forget; content comes via events) and wait
        // for idle, with a safety timeout so we never hang the UI.
        opencodeService.prompt(esid, sendText).catch(() => {})
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantId
              ? {
                  ...t,
                  agentLabel: "Ejecutando herramientas",
                  agentPhases: buildCodeAgentPhases("generate", {
                    plan: { status: "done", detail: "Objetivo definido" },
                    context: { status: "done", detail: "Sesión conectada" },
                    generate: { status: "running", detail: "Esperando eventos del motor" },
                  }),
                }
              : t,
          ),
        )
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
        const msg = err?.message || "El motor OpenCode no respondió"
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantId
              ? {
                  ...t,
                  content: `_${msg}_`,
                  streaming: false,
                  agentLabel: "Error en OpenCode",
                  agentPhases: buildCodeAgentPhases("generate", {
                    generate: { status: "error", detail: msg },
                  }),
                }
              : t,
          ),
        )
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
              agentLabel: "Revisando contexto",
              agentPhases: buildCodeAgentPhases("context", {
                plan: { status: "done", detail: "Detecto dato faltante" },
                context: { status: "running", detail: "Analizando conversación" },
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
                    agentLabel: "Pregunta lista",
                    agentPhases: buildCodeAgentPhases("verify", {
                      plan: { status: "done", detail: "Dato faltante identificado" },
                      context: { status: "done", detail: "Conversación revisada" },
                      generate: { status: "done", detail: "Pregunta formulada" },
                      apply: { status: "done", detail: "Nada que aplicar" },
                      verify: { status: "done", detail: "Esperando respuesta del usuario" },
                    }),
                    actions: askActions,
                  }
                : t,
            ),
          )
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
            await sendPrompt(text, { autoApply: composerMode === "app" })
          }
      }
    },
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

  const runComposerQuickAction = React.useCallback((actionId: ComposerQuickActionId) => {
    const action = getComposerQuickAction(actionId)
    setComposerMode(action.mode)
    if (action.includeContext) setIncludeContext(true)
    setInput((current) => {
      const text = current.trim()
      if (text && !isQuickGreeting(text)) return current
      return action.prompt
    })
    if (typeof window !== "undefined") {
      if (action.toolId) {
        window.dispatchEvent(
          new CustomEvent(CODE_OPEN_TOOL_EVENT, { detail: { toolId: action.toolId } }),
        )
      }
      window.requestAnimationFrame(() => inputRef.current?.focus())
    }
    toast.message(action.toast)
  }, [])

  const activeFileLabel = activePath ? activePath.split("/").pop() || activePath : null
  const agentPhase = activeCodeChatSession?.agent?.phase ?? "idle"
  const agentsActive = busy || buildingApp || agentPhase === "generating" || agentPhase === "debugging"

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border/50">
        <div className="flex h-8 items-center justify-between gap-2 px-3">
          <span className="text-[11px] font-medium text-muted-foreground">Chat</span>
          {activeFileLabel ? (
            <span
              className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80"
              title={activePath ?? undefined}
            >
              {activeFileLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 overflow-x-auto px-2 pb-1.5">
          {codeChatSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setActiveCodeChatSession(session.id)}
              className={cn(
                "h-6 shrink-0 rounded-md px-2 text-[11px] transition-colors",
                session.id === activeCodeChatSessionId
                  ? "bg-foreground text-background"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground",
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

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        <AgentSwarm active={agentsActive && turns.length > 0} />
        {turns.length === 0 ? (
          <EmptyChat active={agentsActive} phase={agentPhase} />
        ) : (
          <div className="space-y-3">
            {turns.map((turn) => (
              <ChatBubble
                key={turn.id}
                turn={turn}
                onApply={(block) => {
                  if (!block.path) {
                    toast.message("Este bloque no incluye una ruta de archivo. Usa el botón de copiar.")
                    return
                  }
                  applyBlock(block.path, block.content)
                  toast.success(`Aplicado a ${block.path}`)
                }}
                lookupContent={(path) => files[path]?.content ?? ""}
              />
            ))}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 px-3 pb-3 pt-2">
        <div className="group rounded-2xl border border-border/60 bg-muted/20 px-2.5 py-2 transition-colors focus-within:border-border focus-within:bg-background focus-within:shadow-sm">
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
          <div className="mt-1 flex items-center gap-1">
            <PrimaryModeToggle
              mode={composerMode === "ask" ? "ask" : "agent"}
              onChange={(m) => {
                setComposerMode(m === "ask" ? "ask" : "app")
                inputRef.current?.focus()
              }}
            />
            <ComposerPlusMenu
              mode={composerMode}
              includeContext={includeContext}
              activeFileLabel={activeFileLabel}
              onQuickAction={runComposerQuickAction}
              onIncludeContextChange={setIncludeContext}
            />
            <ModelPickerInline
              models={pickerModels}
              selectedModel={activeModelName || ""}
              fast={modelIsFast}
              onSelect={(m) => chooseCodeModel({ name: m.name, provider: m.provider })}
            />
            {engineAvailable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 shrink-0 gap-1 rounded-md px-2 text-[11px] font-medium",
                  engineMode
                    ? "bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))] hover:bg-[hsl(var(--accent-violet)/0.24)]"
                    : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                )}
                onClick={() => setEngineMode((v) => !v)}
                aria-pressed={engineMode}
                aria-label="Usar el motor OpenCode"
                title={
                  engineMode
                    ? "Motor OpenCode activo — el chat usa el agente real"
                    : "Activar el motor OpenCode (agente real) para este chat"
                }
              >
                <Server className="h-3.5 w-3.5" />
                <span>Motor{engineMode ? " ✓" : ""}</span>
              </Button>
            ) : null}
            <span className="min-w-0 flex-1" />
            {busy ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0 rounded-lg text-foreground hover:bg-muted"
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
                  "h-7 w-7 shrink-0 rounded-lg transition-colors",
                  input.trim()
                    ? "bg-foreground text-background hover:bg-foreground/90"
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

function EmptyChat({ active, phase }: { active: boolean; phase: AgentPhase }) {
  const currentIndex = AGENT_RUNTIME_STEPS.findIndex((step) => step.phase === phase)

  return (
    <div className="flex min-h-full items-center justify-center px-2 py-4">
      <section
        aria-live="polite"
        data-testid="code-agent-runtime"
        data-agent-active={active ? "true" : "false"}
        data-agent-phase={phase}
        className="w-full max-w-[19rem] rounded-2xl border border-border/60 bg-background/80 p-3 text-left shadow-sm"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[hsl(var(--accent-violet)/0.28)] bg-[hsl(var(--accent-violet)/0.10)] text-[hsl(var(--accent-violet))]">
              <Sparkles className={cn("h-4 w-4", active && "animate-pulse")} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">Agentes</h2>
              <p className="truncate text-[11px] text-muted-foreground">1,044 en paralelo</p>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[10.5px] font-medium",
              active
                ? "bg-[hsl(var(--accent-violet)/0.12)] text-[hsl(var(--accent-violet))]"
                : "bg-muted text-muted-foreground",
            )}
          >
            {AGENT_RUNTIME_STATUS[phase]}
          </span>
        </div>

        <ol className="mt-3 space-y-1.5">
          {AGENT_RUNTIME_STEPS.map((step, index) => {
            const Icon = step.icon
            const isPreview = phase === "preview"
            const state =
              phase === "idle"
                ? "pending"
                : phase === step.phase
                  ? isPreview
                    ? "done"
                    : "running"
                  : currentIndex >= 0 && index < currentIndex
                    ? "done"
                    : "pending"

            return (
              <li key={step.phase} className="flex h-8 items-center gap-2">
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                    state === "done" && "border-emerald-500/35 bg-emerald-500/10 text-emerald-600",
                    state === "running" &&
                      "border-[hsl(var(--accent-violet)/0.45)] bg-[hsl(var(--accent-violet)/0.12)] text-[hsl(var(--accent-violet))]",
                    state === "pending" && "border-border/50 bg-muted/30 text-muted-foreground/55",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", state === "running" && "animate-pulse")} />
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12px] font-medium",
                    state === "pending" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.label}
                </span>
                <span className="w-11 shrink-0 text-right font-mono text-[10px] text-muted-foreground/75">
                  {state === "done" ? "done" : state === "running" ? "run" : "wait"}
                </span>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}

function ChatBubble({
  turn,
  onApply,
  lookupContent,
}: {
  turn: CodeChatTurn
  onApply: (block: CodeBlock) => void
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
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-blue-900 px-3.5 py-2 text-sm leading-relaxed text-zinc-50 shadow-sm">
          {turn.content}
        </div>
      </div>
    )
  }

  // ASSISTANT messages: left-aligned, plain background, clean typography (no
  // colored bubble) — direct text on the interface, with the code-block cards.
  const blocker = detectBlocker(turn.content)
  // Pull the model's gerund-led planning line into the "🧠 …" badge (like the
  // agent dashboard) and narrate the rest. Falls back to a generic badge while
  // streaming before the planning line lands.
  const { label: planLabel, body } = extractPlanLabel(turn.content)
  const liveAgentLabel = planLabel || turn.agentLabel || (turn.streaming ? "Pensando" : "")
  return (
    <div className="text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Asistente
        {liveAgentLabel ? (
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-violet-500/10 px-2 py-0.5 normal-case tracking-normal text-violet-300">
            <span aria-hidden="true">🧠</span>
            <span className="truncate font-medium">{liveAgentLabel}</span>
            {!turn.streaming && typeof turn.planMs === "number" ? (
              <span className="opacity-60">({formatWorked(turn.planMs)})</span>
            ) : null}
            {turn.streaming ? <ThinkingIndicator size="xs" className="inline" /> : null}
          </span>
        ) : null}
      </div>
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
          <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">
              {applicable.length} archivos en esta respuesta
            </span>
            <button
              type="button"
              onClick={() => applicable.forEach((b) => onApply(b))}
              className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
            >
              Aplicar todo y ver
            </button>
          </div>
        ) : null
      })()}
      {blocks.map((block) => (
        <CodeBlockCard
          key={block.index}
          block={block}
          onApply={() => onApply(block)}
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
                {isDone ? <Check className="h-3 w-3" /> : isError ? <AlertTriangle className="h-3 w-3" /> : isRunning ? <ThinkingIndicator size="xs" className="text-white" /> : null}
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
      <span className="font-medium text-foreground">⏱️ Trabajó {formatWorked(metrics.timeWorkedMs)}</span>
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
    <div className="my-1 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-red-300">
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
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
        >
          Añadir créditos <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  )
}

// Primary, Replit-style mode switch: two clear pills (Agent / Ask) shown up
// front in the composer so the user always knows whether the AI will BUILD
// (Agent → autonomous app/edit pipeline) or just ANSWER (Ask → conversational,
// never touches files). Advanced sub-modes (build/plan/debug/image) stay in the
// "+" menu. "agent" maps to the existing "app" composer mode.
function PrimaryModeToggle({
  mode,
  onChange,
}: {
  mode: "agent" | "ask"
  onChange: (mode: "agent" | "ask") => void
}) {
  const base =
    "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors"
  return (
    <div
      role="group"
      aria-label="Modo del agente: Agent o Ask"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5"
    >
      <button
        type="button"
        aria-pressed={mode === "agent"}
        onClick={() => onChange("agent")}
        title="Agent — describe algo y el agente lo construye o lo cambia"
        className={cn(
          base,
          mode === "agent"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span>Agent</span>
      </button>
      <button
        type="button"
        aria-pressed={mode === "ask"}
        onClick={() => onChange("ask")}
        title="Ask — pregunta sobre tu app o tu código; responde sin tocar archivos"
        className={cn(
          base,
          mode === "ask"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <CircleHelp className="h-3.5 w-3.5" />
        <span>Ask</span>
      </button>
    </div>
  )
}

function ComposerPlusMenu({
  mode,
  includeContext,
  activeFileLabel,
  onQuickAction,
  onIncludeContextChange,
}: {
  mode: ComposerMode
  includeContext: boolean
  activeFileLabel: string | null
  onQuickAction: (actionId: ComposerQuickActionId) => void
  onIncludeContextChange: (value: boolean) => void
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
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/80 hover:text-foreground"
          aria-label="Modo, contexto y herramientas"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className="w-[292px] rounded-xl border-border/70 p-1.5 shadow-xl"
      >
        <DropdownMenuLabel className="px-2.5 py-1.5 text-[11px] font-normal text-muted-foreground">
          {COMPOSER_MODE_LABEL[mode]}
          {activeFileLabel && includeContext ? ` · ${activeFileLabel}` : ""}
        </DropdownMenuLabel>
        <DropdownMenuItem
          className={cn(itemClass, mode === "app" && "bg-muted font-medium")}
          onClick={() => onQuickAction("app-from-scratch")}
        >
          <Rocket className={iconClass} />
          <span>App · construir desde cero</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "build" && "bg-muted font-medium")}
          onClick={() => onQuickAction("build-change")}
        >
          <Sparkles className={iconClass} />
          <span>Build</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "plan" && "bg-muted font-medium")}
          onClick={() => onQuickAction("plan-architecture")}
        >
          <ListChecks className={iconClass} />
          <span>Plan</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "debug" && "bg-muted font-medium")}
          onClick={() => onQuickAction("debug-preview")}
        >
          <Bug className={iconClass} />
          <span>Debug</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "ask" && "bg-muted font-medium")}
          onClick={() => onQuickAction("ask-workspace")}
        >
          <CircleHelp className={iconClass} />
          <span>Ask</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem
          className={cn(itemClass, mode === "image" && "bg-muted font-medium")}
          onClick={() => onQuickAction("image-design")}
        >
          <ImageIcon className={iconClass} />
          <span>Image</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClass}>
            <BookOpen className={iconClass} />
            <span>Skills</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-xl p-1.5">
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onQuickAction("skills-implementation")}>
              Plan de implementación
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onQuickAction("skills-debugging")}>
              Diagnóstico de errores
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onQuickAction("skills-review")}>
              Revisión técnica
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={itemClass}>
            <Server className={iconClass} />
            <span>MCP Servers</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 rounded-xl p-1.5">
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onQuickAction("mcp-workspace")}>
              Workspace local
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onQuickAction("mcp-code-tools")}>
              Herramientas de código
            </DropdownMenuItem>
            <DropdownMenuItem className="rounded-lg text-sm" onClick={() => onQuickAction("mcp-integrations")}>
              Conectores e integraciones
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
  const grouped = React.useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      const provider = m.provider || "Otros"
      if (!map.has(provider)) map.set(provider, [])
      map.get(provider)!.push(m)
    }
    return Array.from(map.entries())
  }, [models])

  const active = models.find((m) => m.name === selectedModel)
  const label = active?.displayName || active?.name || selectedModel || "Modelo"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 gap-1 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground hover:bg-muted/80 hover:text-foreground data-[state=open]:bg-muted/80"
          aria-label="Seleccionar modelo"
          title={
            fast
              ? "Modelo rápido (auto-seleccionado) — ideal para el preview en vivo"
              : "Modelo lento (reasoning) — puede cortar el preview en vivo"
          }
        >
          {fast ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
              ⚡ rápido
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              ⏳ lento
            </span>
          )}
          <span className="max-w-[110px] truncate">{label}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        collisionPadding={16}
        className="z-[1000] max-h-[min(360px,calc(100vh-140px))] w-[284px] overflow-y-auto rounded-2xl border border-border/70 bg-background p-1.5 text-foreground shadow-[0_24px_70px_rgba(15,23,42,0.22)]"
      >
        {models.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            Cargando modelos…
          </div>
        ) : (
          grouped.map(([provider, list], i) => (
            <React.Fragment key={provider}>
              {i > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                {provider}
              </DropdownMenuLabel>
              {list.map((m) => (
                <DropdownMenuItem
                  key={m.name}
                  onClick={() => onSelect(m)}
                  className={cn(
                    "cursor-pointer rounded-xl px-2.5 py-2 text-sm",
                    m.name === selectedModel && "bg-muted font-semibold"
                  )}
                >
                  <span className="truncate">{m.displayName || m.name}</span>
                  {m.name === selectedModel ? <Check className="ml-auto h-3.5 w-3.5 text-sky-500" /> : null}
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CodeBlockCard({
  block,
  onApply,
  existingContent,
}: {
  block: CodeBlock
  onApply: () => void
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
              <Button
                type="button"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={onApply}
              >
                Aplicar
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
