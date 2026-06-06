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
import type { CodeChatTurn } from "@/lib/code-chat-sessions"
import { computeLineDiff, parseCodeBlocks, type CodeBlock } from "@/lib/code-workspace-utils"

import { DiffView } from "./diff-view"

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
    "2) GENERAR — construye una LANDING PROFESIONAL en React con ARQUITECTURA LIMPIA (nivel agencia, no un mockup pobre). REGLAS DEL RUNTIME DEL PREVIEW (no hay bundler ni npm: el preview concatena los archivos y elimina los import/export, así que cada componente declarado a nivel superior queda como GLOBAL y se usa por su nombre):\n" +
    "   • Stack disponible como GLOBALES (NO importar de npm): React 18 (usa `const { useState, useEffect } = React`), ReactDOM, Tailwind (CDN ya cargado), iconos `lucide`, animaciones framer-motion (`const { motion, AnimatePresence } = window.Motion`), y si hace falta `Recharts`, `d3`, `_` (lodash). NUNCA uses `import X from 'paquete'`.\n" +
    "   • Arquitectura por archivos — UN componente por archivo como función global (puedes escribir import/export por legibilidad: se ignoran al renderizar): `App.jsx` (export default que compone las secciones) + `components/Nav.jsx`, `components/Hero.jsx`, `components/Features.jsx` (o Collections / About / Testimonials según el caso), `components/CTA.jsx`, `components/Footer.jsx`. Opcional `data/content.js` con el copy y constantes.\n" +
    "   • NO generes `index.html` (rompería el modo React del preview). El entry es `App.jsx` con `export default function App()`.\n" +
    "   • Calidad: copy REAL y específico con el nombre de marca (NADA de lorem ipsum), estructura completa (nav sticky con logo+enlaces, hero impactante con CTA, 2-4 secciones, CTA final, footer), paleta cohesiva según el estilo, responsive móvil+desktop, accesible (contraste/alt/aria) y micro-interacciones pulidas (hover, transiciones, motion sutil) con iconos `lucide`.\n" +
    "   • Entrega CADA archivo como un bloque aplicable con su ruta (formato ```jsx components/Hero.jsx con la primera línea `// path: components/Hero.jsx`).\n" +
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
    setSelectedModel,
    setSelectedProivder,
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
  const [includeContext, setIncludeContext] = React.useState(true)
  const [composerMode, setComposerMode] = React.useState<ComposerMode>("app")

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
    async (prompt: string) => {
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
      if (!selectedModel) {
        toast.error("No hay modelo seleccionado todavía. Abre el chat principal una vez para inicializar.")
        return
      }

      if (!sessionId) {
        toast.error("Selecciona o crea un agente de código.")
        return
      }

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
      const finalPrompt = includeContext
        ? `${buildSystemContext(files, activePath, activeFolder)}\n\n${modeInstruction}\n\n${convoBlock}Usuario: ${text}`
        : `${modeInstruction}\n\n${convoBlock}Usuario: ${text}`

      // Accumulate the streamed answer locally so onDone can auto-apply the
      // generated files without reading it back out of a setState updater
      // (updaters must stay pure — applyBlock is a side effect).
      let assistantText = ""

      try {
        await apiClient.generateAIStream(
          {
            provider: selectProvider,
            model: selectedModel,
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
            // App mode = Replit-style "presented output": auto-apply the
            // generated files and open the live preview so the user sees the
            // result immediately, like the screenshot. Other modes keep the
            // manual "Aplicar" button (review-before-write).
            if (composerMode === "app") {
              try {
                const blocks = parseCodeBlocks(assistantText).filter((b) => b.path)
                if (blocks.length > 0) {
                  for (const b of blocks) applyBlock(b.path, b.content)
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
      applyBlock,
      busy,
      composerMode,
      files,
      includeContext,
      selectProvider,
      selectedModel,
      sessionId,
      setTurns,
      token,
      turns,
      user,
    ],
  )

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendPrompt(input)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      sendPrompt(input)
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
              selectedModel={selectedModel}
              onSelect={(m) => {
                setSelectedModel(m.name)
                if (m.provider) setSelectedProivder(m.provider)
              }}
            />
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
    <div className="flex h-full items-center justify-center text-center">
      <div className="max-w-xs space-y-3">
        <Sparkles className="mx-auto h-6 w-6 text-sky-500/80" />
        <p className="text-sm text-muted-foreground">
          Pide un cambio sobre el archivo activo, genera un nuevo archivo o pega un error y pídeme una corrección.
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
  onSelect,
}: {
  models: ModelOption[]
  selectedModel: string
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
          className="h-7 min-w-0 gap-0.5 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground hover:bg-muted/80 hover:text-foreground data-[state=open]:bg-muted/80"
          aria-label="Seleccionar modelo"
        >
          <span className="max-w-[120px] truncate">{label}</span>
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
