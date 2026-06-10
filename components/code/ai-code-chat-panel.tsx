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
  ArrowUp,
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  CircleHelp,
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
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { intakeService } from "@/lib/builder/intake-service"
import type { CodeChatTurn } from "@/lib/code-chat-sessions"
import { computeLineDiff, parseCodeBlocks, type CodeBlock } from "@/lib/code-workspace-utils"
import { defaultAgentState, type AgentBuildContext } from "@/lib/code-agent/types"
import {
  classifyBuildError,
  mergeOverridesIntoPackageJson,
  nextAgentAction,
  promptFromContext,
  renderFiveSections,
} from "@/lib/code-agent/orchestrator"
import { landingSystemPrompt, sreSystemPrompt } from "@/lib/code-agent/prompts"
import { isSlowModel, recommendFastModel } from "@/lib/code-agent/model-policy"
import { fetchCodeIntakeQuestion } from "@/lib/code/intake-question"
import { opencodeService } from "@/lib/opencode/opencode-service"
import { useOpencodeEngine } from "@/lib/opencode/use-opencode-engine"

import { DiffView } from "./diff-view"
import { AgentSwarm } from "./agent-swarm"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

type ComposerMode = "app" | "build" | "plan" | "debug" | "ask" | "image"

const COMPOSER_MODE_LABEL: Record<ComposerMode, string> = {
  app: "App",
  build: "Build",
  plan: "Plan",
  debug: "Debug",
  ask: "Ask",
  image: "Image",
}

const COMPOSER_PLACEHOLDER: Record<ComposerMode, string> = {
  app: "Describe tu idea — te haré unas preguntas y la construyo…",
  build: "Pide un cambio, pega código o / para comandos",
  plan: "Objetivo o plan antes de editar archivos…",
  debug: "Error, stack trace o comportamiento esperado…",
  ask: "Pregunta sobre el workspace o el archivo activo…",
  image: "Describe UI, asset o captura…",
}

const COMPOSER_MODE_INSTRUCTION: Record<ComposerMode, string> = {
  app:
    "Modo App (construir desde cero, estilo Replit/Lovable): tu meta es entregar una landing/app COMPLETA y VISTOSA que corra en el PREVIEW EN VIVO al instante.\n" +
    "1) INTAKE OBLIGATORIO (como un product manager) — Si el usuario pide construir algo desde cero (p.ej. 'créame un landing', 'hazme una app', 'crea una web') y NO incluyó ya todos los detalles, tu PRIMERA respuesta DEBE ser ÚNICAMENTE preguntas para entender el contexto. NUNCA generes código en esa primera respuesta. Haz una tanda breve (3-5 preguntas, con opciones cuando ayude), por ejemplo: '¿Qué tipo de producto o servicio vas a ofrecer?', '¿Tienes nombre de marca/negocio o quieres que proponga uno?', '¿Qué estilo visual prefieres (minimalista, oscuro, streetwear, corporativo, colorido…)?', '¿Qué secciones quieres (hero, colecciones/productos, sobre nosotros, testimonios, contacto…)?', '¿Algún color o referencia que te guste?'. Termina pidiendo las respuestas y espera.\n" +
    "   REGLA DE GENERACIÓN: SOLO cuando el usuario ya respondió ese contexto (su segunda respuesta en adelante) o dice explícitamente 'genera'/'hazlo'/'dale', construye el proyecto COMPLETO, asumiendo defaults sensatos para lo que falte. A partir de ahí NUNCA vuelvas a quedarte solo en preguntas: tu salida pasa a ser CÓDIGO.\n" +
    "2) GENERAR — entrega una LANDING PROFESIONAL NIVEL AGENCIA como UN SOLO archivo `index.html` autocontenido (HTML + Tailwind por CDN + JS vanilla). El preview lo renderiza al instante y de forma fiable. El bloque DEBE empezar con la ruta: usa el formato ```html index.html y como PRIMERA línea del contenido `// path: index.html`. Exigencias de calidad (queda PROHIBIDO entregar algo básico o tipo plantilla):\n" +
    "   • Carga Tailwind (https://cdn.tailwindcss.com) y Google Fonts: una tipografía DISPLAY de impacto para titulares (p.ej. Anton, Syne, Archivo Black o similar según el estilo) + una sans limpia para texto. Títulos GRANDES con jerarquía clara.\n" +
    "   • COHERENCIA DE NICHO [CRÍTICO]: analiza el rubro (ropa, restaurante, gym, software…) y alinea TODO a él. Las imágenes DEBEN ilustrar ese negocio (ropa→prendas/moda, restaurante→platos, gym→entrenamiento). PROHIBIDO usar fotos genéricas o aleatorias (paisajes, arquitectura, oficinas stock) sin relación con el rubro.\n" +
    "   • HERO a pantalla completa con imagen de alta calidad de fondo y overlay/gradiente para legibilidad. Para imágenes reales usa `https://images.unsplash.com/...` con términos del nicho (p.ej. `?food,restaurant,dish`), o `https://picsum.photos/seed/PALABRA-DEL-RUBRO/1920/1080` como respaldo fiable; añade siempre un gradiente de marca por si la imagen no carga, y `alt` descriptivo.\n" +
    "   • Copy REAL, persuasivo y específico de la marca y su sector (NADA de lorem ipsum): títulos, descripciones de producto y CTAs propios del negocio. Secciones completas y bien diferenciadas: nav sticky translúcido con logo+enlaces, hero con titular potente + CTA, sección de colecciones/productos (grid con imágenes), bloque editorial/about, testimonios o features, CTA final y footer con redes.\n" +
    "   • Paleta cohesiva según el estilo (ej. oscuro editorial = negros/grises + 1 acento). Mucho espacio en blanco, alineación impecable, hover/transiciones suaves y micro-animaciones de aparición al hacer scroll (IntersectionObserver agregando clases). Menú responsive (hamburguesa en móvil).\n" +
    "   • Responsive MÓVIL-PRIMERO (móvil + desktop) y accesible WCAG AA (alt, aria, foco visible, contraste ≥ 4.5:1). Código moderno y limpio: HTML5 semántico (header/nav/main/section/footer), maquetación con Grid/Flexbox (nunca floats ni tablas), sin estilos en línea innecesarios. TODO en ese único `index.html`. No uses React ni librerías de gráficos (no hacen falta y restan fiabilidad).\n" +
    "3) Cierra con 1-3 siguientes pasos sugeridos para iterar (ej. 'añade sección de precios', 'conecta un formulario', 'modo claro/oscuro').",
  build:
    "Modo Build: implementa cambios de código concretos. Si creas o modificas archivos, entrega bloques aplicables con ruta.",
  plan:
    "Modo Plan: analiza primero, propone una arquitectura o pasos claros, identifica riesgos y no cambies archivos hasta que el usuario lo pida.",
  debug:
    "Modo Debug: diagnostica el error con hipótesis verificables, pide el dato mínimo faltante si hace falta y entrega un parche concreto cuando sea posible.",
  ask:
    "Modo Ask: responde de forma directa y técnica sobre el workspace, priorizando claridad y referencias a archivos.",
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
    "tsconfig.json",
    ".npmrc",
  ])
  return Object.values(files)
    .filter((f) => wanted.has(f.path.split("/").pop() || ""))
    .map((f) => `// ${f.path}\n${f.content}`)
    .join("\n\n")
}

function buildSystemContext(
  files: Record<string, { path: string; language: string; content: string }>,
  activePath: string | null,
  folder: { name: string; description?: string | null; instructions?: string | null } | null,
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
  return [
    "Eres un asistente de programación que trabaja en un workspace en memoria del navegador.",
    "Cuando devuelvas código pensado para un archivo, usa SIEMPRE este formato para que la app pueda aplicarlo:",
    "",
    "\u0060\u0060\u0060<lenguaje> <ruta>",
    "// path: <ruta>",
    "<contenido del archivo>",
    "\u0060\u0060\u0060",
    folderBlock,
    "",
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

  // Resolved model the code chat actually uses. Priority:
  //  1. an explicit code-chat choice (codeModel),
  //  2. a fast model derived inline from the catalog (so the FIRST request is
  //     already fast even before the auto-pick effect has run),
  //  3. the main-chat selection as a last resort (may be a slow model).
  const autoFastModel = React.useMemo(
    () => recommendFastModel(availableModels || []),
    [availableModels],
  )
  const activeModelName = codeModel?.name || autoFastModel?.name || selectedModel
  const activeProvider = codeModel?.provider || autoFastModel?.provider || selectProvider
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

  // "Arreglar con IA" from the preview console pre-loads the composer with the
  // captured error so the user can send a fix in one tap.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text?.trim()
      if (!text) return
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
        { id: assistantId, role: "assistant", content: "", streaming: true },
      ])
      setInput("")
      setBusy(true)

      const controller = new AbortController()
      abortRef.current = controller

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
        ? `${override.systemPrompt}\n\n${convoBlock}Usuario: ${text}`
        : includeContext
          ? `${buildSystemContext(files, activePath, activeFolder)}\n\n${modeInstruction}\n\n${convoBlock}Usuario: ${text}`
          : `${modeInstruction}\n\n${convoBlock}Usuario: ${text}`

      // Accumulate the streamed answer locally so onDone can auto-apply the
      // generated files without reading it back out of a setState updater
      // (updaters must stay pure — applyBlock is a side effect).
      let assistantText = ""

      try {
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
              prev.map((t) =>
                t.id === assistantId ? { ...t, content: t.content + chunk } : t,
              ),
            )
          },
          () => {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId ? { ...t, streaming: false } : t,
              ),
            )
            setBusy(false)
            abortRef.current = null
            // App mode (or an explicit override) = Replit-style "presented
            // output": auto-apply the generated files and open the live preview
            // so the user sees the result immediately. Other modes keep the
            // manual "Aplicar" button (review-before-write).
            if (override?.autoApply ?? composerMode === "app") {
              try {
                const blocks = parseCodeBlocks(assistantText).filter((b) => b.path)
                if (blocks.length > 0) {
                  for (const b of blocks) {
                    if (b.path) applyBlock(b.path, b.content)
                  }
                  const hasHtml = blocks.some((b) => /\.html?$/i.test(b.path || ""))
                  toast.success(
                    hasHtml
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
          },
          (err) => {
            const msg = err?.message || "Error en el chat de código"
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId
                  ? {
                      ...t,
                      streaming: false,
                      content: t.content ? `${t.content}\n\n_${msg}_` : `_${msg}_`,
                    }
                  : t,
              ),
            )
            setBusy(false)
            abortRef.current = null
          },
          controller.signal,
        )
      } catch (err: any) {
        toast.error(err?.message || "Error en el chat de código")
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

  // Deterministic "Construir app" path: bypasses the LLM entirely. Sends the
  // current prompt to /api/builder/generate (pure heuristics → runnable files),
  // writes those files into the workspace, and opens the live preview. This is
  // the reliable build flow that works even when the chat model / API keys are
  // down — same engine the /builder studio uses.
  const buildApp = React.useCallback(
    async (prompt: string) => {
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
        { id: `${id}-a`, role: "assistant", content: "⚙️ Construyendo la app (modo determinista, sin LLM)…", streaming: true },
      ])
      setInput("")
      setBuildingApp(true)

      try {
        const result = await intakeService.generate(text)
        const files = result.files || []
        if (files.length === 0) {
          throw new Error("La generación no devolvió archivos.")
        }
        // Apply index.html LAST so it stays the active tab and the live preview
        // lands on the runnable app rather than a doc file.
        const ordered = [...files].sort((a, b) =>
          (/(^|\/)index\.html?$/i.test(a.path) ? 1 : 0) - (/(^|\/)index\.html?$/i.test(b.path) ? 1 : 0),
        )
        for (const file of ordered) {
          applyBlock(file.path, file.content)
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))
        }

        const entities = result.brief.dataEntities.map((e) => e.name).join(", ") || "—"
        const summary = [
          `✅ App generada (determinista) — ${files.length} archivo(s).`,
          ``,
          `- **Plataforma:** ${result.brief.platform}`,
          `- **Entidades:** ${entities}`,
          `- **Stack:** ${result.blueprint.stack.frontend}`,
          ``,
          `Revisa el **preview en vivo** → y el código en el árbol de archivos. Itera pidiéndome cambios en el chat.`,
        ].join("\n")
        setTurns((prev) =>
          prev.map((t) => (t.id === `${id}-a` ? { ...t, content: summary, streaming: false } : t)),
        )
        toast.success("App generada — revisa el preview en vivo →")
      } catch (err: any) {
        const msg = err?.message || "No se pudo generar la app"
        setTurns((prev) =>
          prev.map((t) =>
            t.id === `${id}-a` ? { ...t, content: `_${msg}_`, streaming: false } : t,
          ),
        )
        toast.error(msg)
      } finally {
        setBuildingApp(false)
      }
    },
    [applyBlock, busy, buildingApp, sessionId, setTurns, token, user],
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
  const runDeterministicInto = React.useCallback(
    async (ctx: AgentBuildContext): Promise<number> => {
      const result = await intakeService.generate(promptFromContext(ctx))
      const files = result.files || []
      applyFilesToWorkspace(files)
      return files.length
    },
    [applyFilesToWorkspace],
  )

  // OpenCode engine path. For a normal chat turn it sends the text; for a BUILD
  // (opts.buildContext) it sends the agency-grade landing instruction and forces
  // the engine to RETURN the code in the reply (no file tools), then applies it.
  // If the engine yields no usable code (or errors), it falls back to the
  // deterministic builder in the SAME turn — so a build always produces a result.
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
        },
      ])
      setInput("")
      setBusy(true)
      const controller = new AbortController()
      abortRef.current = controller

      const finish = (content: string) =>
        setTurns((prev) => prev.map((t) => (t.id === assistantId ? { ...t, content, streaming: false } : t)))

      try {
        let esid = engineSessionRef.current[sid]
        if (!esid) {
          const s = await opencodeService.createSession({})
          esid = String((s && (s.id as string)) || "")
          if (!esid) throw new Error("El motor no devolvió un id de sesión.")
          engineSessionRef.current[sid] = esid
        }

        const sendText = ctx
          ? `${landingSystemPrompt(ctx)}\n\n${
              ctx.goal === "app"
                ? 'IMPORTANTE: Crea un PROYECTO Vite + React REAL con tus herramientas (write/edit), con archivos INDEPENDIENTES — NO un solo archivo:\n- package.json (con "vite" y "react"+"react-dom" en dependencias, y script "dev": "vite")\n- index.html en la raíz que cargue <script type="module" src="/src/main.jsx">\n- src/main.jsx (monta <App/>), src/App.jsx, y componentes en src/components/*.jsx\n- src/index.css con Tailwind por CDN en el index.html o estilos propios.\nOrganiza por componentes/secciones. El usuario lo correrá con npm/bun (dev server).'
                : 'IMPORTANTE: ESCRIBE los archivos con tus herramientas (write/edit). Crea un PROYECTO con archivos INDEPENDIENTES (p.ej. index.html, styles.css, app.js, y un archivo por sección cuando aporte claridad). El archivo de ENTRADA debe llamarse exactamente "index.html", enlazar a los demás (./styles.css, ./app.js) y quedar EJECUTABLE con Tailwind por CDN (sin build).'
            }`
          : iterate
            ? `MODIFICA los archivos que YA existen en tu workspace para lograr: ${text}.\n\nPrimero LEE el código actual con tus herramientas, haz cambios DIRIGIDOS solo donde corresponde y CONSERVA el resto intacto. NO regeneres todo desde cero — edita los archivos existentes (write/edit).`
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
            const candidates = ["index.html", "styles.css", "style.css", "app.js", "script.js", "main.js"]
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
            finish(reply ? `${reply}\n\n_(Motor OpenCode: ${merged.length} archivo(s) →)_` : `✅ Motor OpenCode — ${merged.length} archivo(s) →`)
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
            finish(reply ? `${reply}\n\n_(Motor OpenCode: ${synced.length} archivo(s) →)_` : `✅ Cambios aplicados — ${synced.length} archivo(s) →`)
            toast.success(`Cambios aplicados — ${synced.length} archivo(s) →`)
            return
          }
        }

        // Plain engine chat: render the reply + apply any code blocks it returned.
        if (blocks.length > 0) {
          applyFilesToWorkspace(blocks.map((b) => ({ path: b.path as string, content: b.content })))
          finish(reply || `✅ Motor OpenCode — ${blocks.length} archivo(s) aplicados →`)
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
        finish(`_${err?.message || "El motor OpenCode no respondió"}_`)
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
    [applyFilesToWorkspace, runDeterministicInto, setTurns],
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
            { id: assistantId, role: "assistant", content: staticQuestion, streaming: true },
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
          setTurns((prev) =>
            prev.map((t) =>
              t.id === assistantId ? { ...t, content: dynamicQuestion, streaming: false } : t,
            ),
          )
          return
        }
        case "generate": {
          patchAgentState(sid, (s) => ({ ...s, phase: "generating", context: action.context }))
          if (!opts?.forceDeterministic && engineAvailable) {
            // Prefer the OpenCode agent: it writes the landing files into its
            // /workspace (via a funded model), and runEngine reads them back into
            // the editor/preview — falling back to the deterministic builder if
            // the agent leaves no index.html. Rich AND reliable in Docker.
            await runEngine(text, sid, { buildContext: action.context })
            patchAgentState(sid, (s) => ({ ...s, phase: "preview", generator: "llm" }))
          } else {
            const ctxPrompt = promptFromContext(action.context)
            const genPrompt = action.context.productType || action.context.brand ? ctxPrompt : text
            await buildApp(genPrompt)
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
          if (engineMode && engineAvailable) {
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

  const activeFileLabel = activePath ? activePath.split("/").pop() || activePath : null

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
        <AgentSwarm active={busy || buildingApp} />
        {turns.length === 0 ? (
          <EmptyChat />
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
          <div className="mt-1 flex items-center gap-0.5">
            <ComposerPlusMenu
              mode={composerMode}
              includeContext={includeContext}
              activeFileLabel={activeFileLabel}
              onModeChange={(mode) => {
                setComposerMode(mode)
                inputRef.current?.focus()
              }}
              onIncludeContextChange={setIncludeContext}
            />
            <ModelPickerInline
              models={availableModels || []}
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

function EmptyChat() {
  return (
    <div className="flex h-full items-center justify-center px-2 text-center">
      <div className="max-w-[17rem] space-y-3">
        <div className="relative mx-auto flex h-12 w-12 items-center justify-center">
          <div
            aria-hidden
            className="absolute inset-0 rounded-2xl bg-[radial-gradient(circle,hsl(var(--accent-violet)/0.28),transparent_70%)] blur-md"
          />
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-[hsl(var(--accent-violet)/0.35)] bg-[hsl(var(--accent-violet)/0.10)] text-[hsl(var(--accent-violet))]">
            <Sparkles className="h-6 w-6" />
          </div>
        </div>
        <p className="text-sm font-semibold tracking-tight text-foreground">
          Describe tu idea y se pone a trabajar un enjambre de agentes
        </p>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Más de 1000 agentes en paralelo buscan información, generan imágenes y
          código, refactorizan, revisan y te entregan el resultado en el preview
          en vivo.
        </p>
      </div>
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

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 p-3 text-sm",
        isUser ? "bg-muted/30" : "bg-background",
      )}
    >
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {isUser ? "Tú" : "Asistente"}
        {turn.streaming ? <ThinkingIndicator size="xs" className="ml-2 inline" /> : null}
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed">
        {/* Strip fenced blocks from the prose so the user does not see
            the raw markdown twice — once here and once inside each
            block card below. */}
        {blocks.length > 0 ? stripFences(turn.content) : turn.content}
      </div>
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
    </div>
  )
}

function stripFences(text: string): string {
  return text.replace(/```[^\n`]*\n[\s\S]*?```/g, "").trim()
}

function ComposerPlusMenu({
  mode,
  includeContext,
  activeFileLabel,
  onModeChange,
  onIncludeContextChange,
}: {
  mode: ComposerMode
  includeContext: boolean
  activeFileLabel: string | null
  onModeChange: (mode: ComposerMode) => void
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
          onClick={() => onModeChange("app")}
        >
          <Rocket className={iconClass} />
          <span>App · construir desde cero</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "build" && "bg-muted font-medium")}
          onClick={() => onModeChange("build")}
        >
          <Sparkles className={iconClass} />
          <span>Build</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "plan" && "bg-muted font-medium")}
          onClick={() => onModeChange("plan")}
        >
          <ListChecks className={iconClass} />
          <span>Plan</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "debug" && "bg-muted font-medium")}
          onClick={() => onModeChange("debug")}
        >
          <Bug className={iconClass} />
          <span>Debug</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(itemClass, mode === "ask" && "bg-muted font-medium")}
          onClick={() => onModeChange("ask")}
        >
          <CircleHelp className={iconClass} />
          <span>Ask</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-2" />
        <DropdownMenuItem
          className={cn(itemClass, mode === "image" && "bg-muted font-medium")}
          onClick={() => onModeChange("image")}
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
          <DropdownMenuSubContent className="w-52 rounded-xl p-1.5">
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
