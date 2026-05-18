"use client"

/**
 * AICodeChatPanel — right column of the /code workspace. A focused
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
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  CircleHelp,
  Image as ImageIcon,
  ListChecks,
  Mic,
  Plus,
  Send,
  Server,
  Sparkles,
  StopCircle} from "lucide-react"
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
import { computeLineDiff, parseCodeBlocks, type CodeBlock } from "@/lib/code-workspace-utils"

import { DiffView } from "./diff-view"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
type ChatTurn = {
  id: string
  role: "user" | "assistant"
  content: string
  /** Streaming flag: true while the assistant turn is still receiving tokens. */
  streaming?: boolean
}

type ComposerMode = "build" | "plan" | "debug" | "ask" | "image"

const COMPOSER_MODE_LABEL: Record<ComposerMode, string> = {
  build: "Build",
  plan: "Plan",
  debug: "Debug",
  ask: "Ask",
  image: "Image",
}

const COMPOSER_PLACEHOLDER: Record<ComposerMode, string> = {
  build: "Describe el cambio que quieres construir, pega código o escribe / para comandos",
  plan: "Describe el objetivo y te devuelvo un plan claro antes de tocar archivos",
  debug: "Pega el error, stack trace o comportamiento esperado para diagnosticarlo",
  ask: "Pregunta sobre el workspace, el archivo activo o una decision tecnica",
  image: "Describe la interfaz o asset que quieres analizar o implementar",
}

const COMPOSER_MODE_INSTRUCTION: Record<ComposerMode, string> = {
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
  const { files, activePath, applyBlock, registerChatFocusHandler, activeFolder } = useCodeWorkspace()

  const [turns, setTurns] = React.useState<ChatTurn[]>([])
  const [input, setInput] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [includeContext, setIncludeContext] = React.useState(true)
  const [composerMode, setComposerMode] = React.useState<ComposerMode>("build")

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
    const el = inputRef.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 54), 168)}px`
  }, [input])

  const cancelStream = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setTurns((prev) =>
      prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)),
    )
  }, [])

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
      const finalPrompt = includeContext
        ? `${buildSystemContext(files, activePath, activeFolder)}\n\n${modeInstruction}\n\n---\n\n${text}`
        : `${modeInstruction}\n\n${text}`

      try {
        await apiClient.generateAIStream(
          {
            provider: selectProvider,
            model: selectedModel,
            prompt: finalPrompt,
            streamId: id,
          },
          (chunk) => {
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
    [activePath, activeFolder, busy, composerMode, files, includeContext, selectProvider, selectedModel, token, user],
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

  const activeFileLabel = activePath ? activePath.split("/").pop() || activePath : "Sin archivo activo"
  const hasWorkspaceContext = includeContext && Object.keys(files).length > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-sky-500" />
          <span>Chat de código</span>
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

      <form onSubmit={onSubmit} className="shrink-0 border-t border-border/60 bg-background/95 px-3 py-3">
        <div className="group rounded-[22px] border border-border/70 bg-background px-3 py-2.5 shadow-[0_10px_30px_rgba(15,23,42,0.06)] transition-[border-color,box-shadow,background-color] focus-within:border-foreground/20 focus-within:bg-background focus-within:shadow-[0_14px_38px_rgba(15,23,42,0.1)] focus-within:ring-1 focus-within:ring-foreground/10">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/45 px-2 text-[11px] font-medium text-foreground">
                <Sparkles className="h-3 w-3 text-sky-500" />
                {COMPOSER_MODE_LABEL[composerMode]}
              </span>
              <span className="min-w-0 truncate rounded-full bg-muted/35 px-2 py-1 text-[11px] text-muted-foreground">
                {hasWorkspaceContext ? `Contexto: ${activeFileLabel}` : "Contexto desactivado"}
              </span>
            </div>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
              Enter envía · Shift+Enter nueva línea
            </span>
          </div>
          <Textarea
            aria-label="Mensaje para el chat de código"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={COMPOSER_PLACEHOLDER[composerMode]}
            rows={1}
            disabled={busy}
            className="max-h-[168px] min-h-[54px] resize-none border-0 bg-transparent px-0 py-0 text-sm leading-5 shadow-none outline-none ring-0 placeholder:text-muted-foreground/50 focus-visible:ring-0"
          />
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
            <div className="flex min-w-0 items-center gap-2">
              <ComposerPlusMenu
                mode={composerMode}
                includeContext={includeContext}
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
            </div>
            {busy ? (
              <Button
                type="button"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
                onClick={cancelStream}
                aria-label="Detener"
              >
                <StopCircle className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="h-8 w-8 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted-foreground/20 disabled:text-muted-foreground"
                disabled={!input.trim()}
                aria-label={input.trim() ? "Enviar" : "Dictar"}
              >
                {input.trim() ? <Send className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
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
  turn: ChatTurn
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
  onModeChange,
  onIncludeContextChange,
}: {
  mode: ComposerMode
  includeContext: boolean
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
          variant="secondary"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full border border-transparent bg-muted/70 text-foreground shadow-none hover:border-border/70 hover:bg-muted"
          aria-label="Agregar agentes, contexto y herramientas"
        >
          <Plus className="h-[18px] w-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className="w-[292px] rounded-xl border-border/70 p-1.5 shadow-xl"
      >
        <DropdownMenuLabel className="px-2.5 py-2 text-sm font-normal text-muted-foreground">
          Agentes, contexto y herramientas
        </DropdownMenuLabel>
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
          className="h-8 min-w-0 gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          aria-label="Seleccionar modelo"
        >
          <span className="max-w-[150px] truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-65" />
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
