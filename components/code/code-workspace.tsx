"use client"

/**
 * CodeWorkspace — Cursor-inspired shell for /code.
 *
 * Current layout (chat on the left, editor on the right — the
 * conversation drives the work; the editor is the artifact):
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ TitleBar — "Cursor" branding · breadcrumb · palette        │
 *   ├──────────────────────────┬─────────────────────────────────┤
 *   │ Cursor Chat (collapsible)│ Editor (tabs + Monaco)          │
 *   │                          │ ┌─────────────────────────────┐ │
 *   │                          │ │ Terminal (toggle, ⌘J)       │ │
 *   │                          │ └─────────────────────────────┘ │
 *   └──────────────────────────┴─────────────────────────────────┘
 *
 * The shell stays layout-only. Real state continues to live in
 * CodeWorkspaceProvider and per-panel components.
 */

import * as React from "react"
import { AlertTriangle, ChevronRight, Command as CommandIcon, Download, FolderTree } from "lucide-react"
import Image from "next/image"
import { type ImperativePanelHandle } from "react-resizable-panels"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import {
  browserSupportsLocalFolderSync,
  exportWorkspaceAsZip,
  workspaceExportFilename,
} from "@/lib/code-workspace-utils"

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { EditorPanel } from "./editor-panel"
import { TerminalPanel } from "./terminal-panel"

const CHAT_DEFAULT_SIZE = 30
const CHAT_MIN_SIZE = 22
const TERMINAL_DEFAULT_SIZE = 32
const TERMINAL_MIN_SIZE = 14

type PaletteCommand = {
  id: string
  label: string
  keywords?: string
  hint?: string
  run: () => void
}

export function CodeWorkspace() {
  const {
    files,
    openFile,
    createFile,
    resetWorkspace,
    focusChat,
    registerCommandPaletteHandler,
    activeFolder,
    workspaceSource,
  } = useCodeWorkspace()

  const [chatOpen, setChatOpen] = React.useState(true)
  const [terminalOpen, setTerminalOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState("")

  const chatRef = React.useRef<ImperativePanelHandle>(null)

  const toggleChat = React.useCallback(() => {
    setChatOpen((prev) => {
      const next = !prev
      const panel = chatRef.current
      if (panel) {
        if (next) panel.expand()
        else panel.collapse()
      }
      return next
    })
  }, [])

  const toggleTerminal = React.useCallback(() => setTerminalOpen((v) => !v), [])

  const openComposer = React.useCallback(() => {
    setChatOpen(true)
    chatRef.current?.expand()
    focusChat()
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("siragpt:code-composer-mode"))
    }
  }, [focusChat])

  // Imperative bridge: any nested component can request the palette.
  React.useEffect(() => {
    return registerCommandPaletteHandler(() => setPaletteOpen(true))
  }, [registerCommandPaletteHandler])

  // Global keybindings — match Cursor / VS Code conventions.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return
      const key = e.key.toLowerCase()
      if (e.shiftKey && key === "p") {
        e.preventDefault()
        setPaletteQuery("")
        setPaletteOpen(true)
        return
      }
      if (key === "p" && !e.shiftKey) {
        e.preventDefault()
        setPaletteQuery("open ")
        setPaletteOpen(true)
        return
      }
      if (key === "k" && !e.shiftKey) {
        e.preventDefault()
        setPaletteQuery("edit")
        setPaletteOpen(true)
        return
      }
      if (key === "l") {
        e.preventDefault()
        setChatOpen(true)
        chatRef.current?.expand()
        focusChat()
        return
      }
      if (key === "i") {
        e.preventDefault()
        openComposer()
        return
      }
      if (key === "j" || key === "`") {
        e.preventDefault()
        toggleTerminal()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [focusChat, openComposer, toggleTerminal])

  const commands = React.useMemo<PaletteCommand[]>(() => {
    const fileItems: PaletteCommand[] = Object.keys(files).map((path) => ({
      id: `open:${path}`,
      label: `Abrir ${path}`,
      keywords: `open file ${path}`,
      run: () => openFile(path),
    }))
    return [
      ...fileItems,
      {
        id: "new-file",
        label: "Nuevo archivo…",
        keywords: "new file create",
        run: () => {
          if (typeof window === "undefined") return
          const path = window.prompt("Nombre del archivo (incluye ruta)")
          if (!path) return
          createFile(path, "")
        },
      },
      {
        id: "edit-active",
        label: "Editar archivo activo con IA",
        keywords: "edit ai cmd k inline",
        hint: "⌘K",
        run: () => {
          setChatOpen(true)
          chatRef.current?.expand()
          focusChat()
        },
      },
      {
        id: "focus-chat",
        label: "Abrir Cursor Chat",
        keywords: "focus chat l",
        hint: "⌘L",
        run: () => {
          setChatOpen(true)
          chatRef.current?.expand()
          focusChat()
        },
      },
      {
        id: "composer",
        label: "Composer · multi-archivo",
        keywords: "composer multi file plan agent",
        hint: "⌘I",
        run: openComposer,
      },
      {
        id: "toggle-terminal",
        label: terminalOpen ? "Ocultar terminal" : "Mostrar terminal",
        keywords: "terminal shell repl",
        hint: "⌘J",
        run: toggleTerminal,
      },
      {
        id: "reset",
        label: "Restaurar ejemplo",
        keywords: "reset starter",
        run: () => {
          if (typeof window === "undefined") return
          if (!window.confirm("Esto restaurará los archivos de ejemplo y descartará el workspace actual.")) return
          resetWorkspace()
        },
      },
    ]
  }, [
    createFile,
    files,
    focusChat,
    openComposer,
    openFile,
    resetWorkspace,
    terminalOpen,
    toggleTerminal,
  ])

  const filtered = React.useMemo(() => {
    const q = paletteQuery.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.keywords ?? ""}`.toLowerCase().includes(q))
  }, [commands, paletteQuery])

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <BrowserCompatBanner />
      <TitleBar
        activeFolderName={activeFolder?.name || workspaceSource.name}
        onOpenPalette={() => setPaletteOpen(true)}
        onExport={async () => exportWorkspaceFiles(files)}
      />

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel
            ref={chatRef}
            collapsible
            collapsedSize={0}
            defaultSize={CHAT_DEFAULT_SIZE}
            minSize={CHAT_MIN_SIZE}
            maxSize={50}
            onCollapse={() => setChatOpen(false)}
            onExpand={() => setChatOpen(true)}
            className="min-w-0"
          >
            <AICodeChatPanel />
          </ResizablePanel>

          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={70} minSize={40}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel
                defaultSize={terminalOpen ? 100 - TERMINAL_DEFAULT_SIZE : 100}
                minSize={30}
              >
                <EditorPanel />
              </ResizablePanel>
              {terminalOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    defaultSize={TERMINAL_DEFAULT_SIZE}
                    minSize={TERMINAL_MIN_SIZE}
                    maxSize={70}
                  >
                    <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} />
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <Dialog
        open={paletteOpen}
        onOpenChange={(open) => {
          setPaletteOpen(open)
          if (!open) setPaletteQuery("")
        }}
      >
        <DialogContent className="sm:max-w-[560px] p-0">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <CommandIcon className="h-4 w-4" />
              Paleta de comandos
            </DialogTitle>
            <DialogDescription className="sr-only">
              Acciones del workspace de código.
            </DialogDescription>
          </DialogHeader>
          <div className="px-4 pb-4">
            <Input
              autoFocus
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              placeholder="Escribe una acción o un archivo…"
              className="h-9"
            />
            <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border/60">
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Sin resultados
                </div>
              ) : (
                filtered.map((cmd) => (
                  <button
                    key={cmd.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm",
                      "hover:bg-muted/50",
                    )}
                    onClick={() => {
                      cmd.run()
                      setPaletteOpen(false)
                      setPaletteQuery("")
                    }}
                  >
                    <span className="truncate">{cmd.label}</span>
                    <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {cmd.hint ? <kbd className="rounded bg-muted px-1.5 py-px">{cmd.hint}</kbd> : null}
                      <span>{cmd.id.split(":")[0]}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Atajos: ⌘P abre archivos · ⌘⇧P paleta · ⌘K editar con IA · ⌘L Cursor Chat · ⌘I Composer · ⌘J terminal.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TitleBar({
  activeFolderName,
  onOpenPalette,
  onExport,
}: {
  activeFolderName: string
  onOpenPalette: () => void
  onExport: () => Promise<void>
}) {
  const [exporting, setExporting] = React.useState(false)
  const handleExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await onExport()
    } finally {
      setExporting(false)
    }
  }
  return (
    <TooltipProvider delayDuration={250}>
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border/60 bg-muted/40 px-3 text-[11px]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Image src="/sira-gpt.png" alt="" width={14} height={14} className="rounded-sm" />
          <span className="font-medium text-foreground">Cursor</span>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="flex items-center gap-1 truncate">
            <FolderTree className="h-3 w-3" />
            <span className="max-w-[280px] truncate">{activeFolderName}</span>
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenPalette}
          className={cn(
            "group flex h-6 w-[260px] items-center justify-between rounded border border-border/60 bg-background/60 px-2",
            "text-[11px] text-muted-foreground hover:bg-background",
          )}
        >
          <span className="flex items-center gap-1.5">
            <CommandIcon className="h-3 w-3" />
            <span>Buscar acciones o archivos…</span>
          </span>
          <kbd className="rounded bg-muted px-1 text-[10px]">⌘K</kbd>
        </button>

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                disabled={exporting}
                onClick={handleExport}
              >
                {exporting ? <ThinkingIndicator size="xs" className="mr-1" /> : <Download className="mr-1 h-3 w-3" />}
                Exportar ZIP
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              Descarga todo el workspace como un .zip
            </TooltipContent>
          </Tooltip>
        </div>
      </header>
    </TooltipProvider>
  )
}

async function exportWorkspaceFiles(files: ReturnType<typeof useCodeWorkspace>["files"]): Promise<void> {
  if (typeof window === "undefined") return
  if (!Object.keys(files).length) return
  try {
    const blob = await exportWorkspaceAsZip(files)
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = workspaceExportFilename()
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (err) {
    console.error("[code-workspace] export-as-zip failed:", err)
    window.alert(`No se pudo exportar el ZIP: ${(err as Error)?.message || "error desconocido"}`)
  }
}

/**
 * BrowserCompatBanner — informs the user when the current browser
 * lacks the File System Access API (Safari/Firefox today). The
 * workspace still works (state persists to localStorage) but cannot
 * sync with a folder on disk, so we surface the limitation upfront
 * and point them at Export-as-ZIP.
 */
function BrowserCompatBanner() {
  const [supported, setSupported] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    setSupported(browserSupportsLocalFolderSync())
  }, [])
  if (supported !== false) return null
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[12px] text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
      <p className="leading-snug">
        Tu navegador no permite sincronizar con una carpeta local del disco. Tus cambios se guardan en este navegador,
        pero <strong>se perderán si limpias los datos del sitio</strong>. Usa <strong>Exportar como ZIP</strong> antes
        de cerrar, o abre <code>/code</code> en Chrome o Edge para enlazar una carpeta de tu escritorio.
      </p>
    </div>
  )
}
