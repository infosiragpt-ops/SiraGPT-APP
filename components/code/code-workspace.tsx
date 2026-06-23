"use client"

/**
 * CodeWorkspace — Cursor-inspired shell for /code.
 *
 * Layout: Chat (left) · Editor + terminal (center). Codex workspaces live in the app sidebar.
 */

import * as React from "react"
import { AlertTriangle, Command as CommandIcon, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { type ImperativePanelHandle } from "react-resizable-panels"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { browserSupportsLocalFolderSync } from "@/lib/code-workspace-utils"
import { CODE_TEMPLATES } from "@/lib/code-templates"

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { EditorPanel } from "./editor-panel"
import { PublishingConsole } from "./publishing-console"
import { PreviewPane } from "./preview-pane"
import { StatusBar } from "./status-bar"
import { TerminalPanel } from "./terminal-panel"
import { WorkspaceToolsMenu } from "./workspace-tools-menu"
import { WorkspaceTopBar, type WorkspacePanelId } from "./workspace-top-bar"

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
    applyBlock,
    resetWorkspace,
    focusChat,
    registerCommandPaletteHandler,
  } = useCodeWorkspace()

  const [chatOpen, setChatOpen] = React.useState(true)
  const [terminalOpen, setTerminalOpen] = React.useState(false)
  const [previewOpen, setPreviewOpen] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return true
    return window.localStorage.getItem("code-workspace:preview-open") !== "0"
  })

  React.useEffect(() => {
    try {
      window.localStorage.setItem("code-workspace:preview-open", previewOpen ? "1" : "0")
    } catch {
      /* storage disabled — fail soft */
    }
  }, [previewOpen])
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState("")
  const [publishingOpen, setPublishingOpen] = React.useState(false)
  const [openPanels, setOpenPanels] = React.useState<Set<WorkspacePanelId>>(
    () => new Set<WorkspacePanelId>(["preview", "terminal"]),
  )
  const [activePanel, setActivePanel] = React.useState<WorkspacePanelId | null>("preview")

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

  const toggleTerminal = React.useCallback(() => {
    setTerminalOpen((v) => {
      const next = !v
      if (next) {
        setOpenPanels((prev) => new Set(prev).add("terminal"))
        setActivePanel("terminal")
      } else {
        setOpenPanels((prev) => {
          const panels = new Set(prev)
          panels.delete("terminal")
          return panels
        })
      }
      return next
    })
  }, [])

  const handleTogglePanel = React.useCallback(
    (id: WorkspacePanelId) => {
      setActivePanel(id)
      setOpenPanels((prev) => new Set(prev).add(id))
      if (id === "terminal") {
        setTerminalOpen(true)
        return
      }
      if (id === "preview") {
        setPreviewOpen(true)
        return
      }
      if (id === "git" || id === "validation") {
        setPaletteQuery("")
        setPaletteOpen(true)
      }
    },
    [],
  )

  const handleClosePanel = React.useCallback((id: WorkspacePanelId) => {
    setOpenPanels((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (activePanel === id) setActivePanel(null)
    if (id === "terminal") setTerminalOpen(false)
    if (id === "preview") setPreviewOpen(false)
  }, [activePanel])

  const openComposer = React.useCallback(() => {
    setChatOpen(true)
    chatRef.current?.expand()
    focusChat()
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("siragpt:code-composer-mode"))
    }
  }, [focusChat])

  const handleNewFileFromTools = React.useCallback(() => {
    if (typeof window === "undefined") return
    const path = window.prompt("Nombre del archivo (incluye ruta)")
    if (!path) return
    createFile(path, "")
  }, [createFile])

  const loadTemplate = React.useCallback(
    (templateId: string) => {
      const tpl = CODE_TEMPLATES.find((t) => t.id === templateId)
      if (!tpl) return
      if (typeof window !== "undefined" && Object.keys(files).length > 0) {
        if (!window.confirm(`Cargar la plantilla "${tpl.name}"? Se crearán o sobrescribirán sus archivos.`)) return
      }
      for (const f of tpl.files) applyBlock(f.path, f.content)
      openFile(tpl.entry)
    },
    [applyBlock, files, openFile],
  )

  const toolsHandlers = React.useMemo(
    () => ({
      onTogglePanel: handleTogglePanel,
      onOpenPalette: (query?: string) => {
        setPaletteQuery(query ?? "")
        setPaletteOpen(true)
      },
      onNewFile: handleNewFileFromTools,
      onOpenPublishing: () => setPublishingOpen(true),
      onFocusChat: () => {
        setChatOpen(true)
        chatRef.current?.expand()
        focusChat()
      },
      onOpenComposer: openComposer,
    }),
    [focusChat, handleNewFileFromTools, handleTogglePanel, openComposer],
  )

  React.useEffect(() => {
    return registerCommandPaletteHandler(() => setPaletteOpen(true))
  }, [registerCommandPaletteHandler])

  React.useEffect(() => {
    const openPreview = () => {
      setPreviewOpen(true)
      setOpenPanels((prev) => new Set(prev).add("preview"))
      setActivePanel("preview")
    }
    window.addEventListener("siragpt:code-open-preview", openPreview)
    return () => window.removeEventListener("siragpt:code-open-preview", openPreview)
  }, [])

  React.useEffect(() => {
    const onLoadTemplate = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id
      if (id) loadTemplate(id)
    }
    window.addEventListener("siragpt:code-load-template", onLoadTemplate)
    return () => window.removeEventListener("siragpt:code-load-template", onLoadTemplate)
  }, [loadTemplate])

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) {
        if (e.key === "`" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          toggleTerminal()
        }
        return
      }
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
      if (key === "e") {
        e.preventDefault()
        setPreviewOpen((v) => !v)
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
      if (key === "j") {
        e.preventDefault()
        toggleTerminal()
        return
      }
      if (key === "`") {
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
      ...CODE_TEMPLATES.map((t) => ({
        id: `template:${t.id}`,
        label: `Plantilla: ${t.name}`,
        keywords: `template plantilla scaffold nueva app ${t.id} ${t.name}`,
        hint: "Nuevo",
        run: () => loadTemplate(t.id),
      })),
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
    loadTemplate,
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

      <WorkspaceTopBar
        openPanels={openPanels}
        activePanel={activePanel}
        onTogglePanel={handleTogglePanel}
        onClosePanel={handleClosePanel}
        onOpenPalette={(query) => {
          setPaletteQuery(query ?? "")
          setPaletteOpen(true)
        }}
        onOpenSearch={() => {
          setPaletteQuery("open ")
          setPaletteOpen(true)
        }}
        toolsMenu={
          <WorkspaceToolsMenu handlers={toolsHandlers}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-md text-muted-foreground"
              aria-label="Herramientas y archivos"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </WorkspaceToolsMenu>
        }
      />

      <div className="min-h-0 flex-1">
        <div className="flex h-full min-h-0">
          <div className="min-w-0 flex-1">
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

              <ResizablePanel defaultSize={70} minSize={32}>
                <ResizablePanelGroup direction="horizontal">
                  <ResizablePanel defaultSize={previewOpen ? 56 : 100} minSize={28} className="min-w-0">
                    <ResizablePanelGroup direction="vertical">
                      <ResizablePanel defaultSize={terminalOpen ? 100 - TERMINAL_DEFAULT_SIZE : 100} minSize={30}>
                        <EditorPanel />
                      </ResizablePanel>
                      {terminalOpen ? (
                        <>
                          <ResizableHandle withHandle />
                          <ResizablePanel defaultSize={TERMINAL_DEFAULT_SIZE} minSize={TERMINAL_MIN_SIZE} maxSize={70}>
                            <TerminalPanel open={terminalOpen} onClose={() => setTerminalOpen(false)} />
                          </ResizablePanel>
                        </>
                      ) : null}
                    </ResizablePanelGroup>
                  </ResizablePanel>
                  {previewOpen ? (
                    <>
                      <ResizableHandle withHandle />
                      <ResizablePanel defaultSize={44} minSize={24} className="min-w-0">
                        <PreviewPane onClose={() => handleClosePanel("preview")} />
                      </ResizablePanel>
                    </>
                  ) : null}
                </ResizablePanelGroup>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>
      </div>

      <StatusBar
        terminalOpen={terminalOpen}
        onToggleTerminal={toggleTerminal}
        chatOpen={chatOpen}
        onToggleChat={toggleChat}
      />

      <PublishingConsole open={publishingOpen} onOpenChange={setPublishingOpen} />

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
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
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
        pero <strong>se perderán si limpias los datos del sitio</strong>. Abre <code>/code</code> en Chrome o Edge para
        enlazar una carpeta de tu escritorio.
      </p>
    </div>
  )
}
