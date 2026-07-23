"use client"

/**
 * CodeWorkspace — agent-first build surface for /code.
 *
 * The chat remains the primary control surface, while the advanced workspace
 * tools stay available from the top bar: +, Codigo, Preview, Shell,
 * Git, Validation, command palette, launcher, and publishing surfaces.
 */

import * as React from "react"
import { Command as CommandIcon, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  CODE_OPEN_TOOL_LAUNCHER_EVENT,
  CODE_OPEN_TOOL_EVENT,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import { CODE_TEMPLATES } from "@/lib/code-templates"
import { WORKSPACE_TOOLS, type WorkspaceToolId } from "@/lib/code-workspace-tools"

import {
  CODE_FOCUS_CEO_CHAT_EVENT,
  focusCeoChatColumn,
} from "@/lib/code-agent-company-proactive"

import { AgentCompanyPanel } from "./agent-company-panel"
import { AICodeChatPanel } from "./ai-code-chat-panel"
import { CodeHub } from "./code-hub"
import { NewTabPane } from "./new-tab-pane"
import { PreviewPane } from "./preview-pane"

// The chat panel and preview are the two heaviest subtrees in the workspace
// (the chat alone is a ~3k-line component). Workspace-level state changes —
// opening the "+" picker, palettes, tab toggles — re-rendered BOTH on every
// click, which read as input lag. They take no props (context-driven), so a
// module-level memo makes those interactions skip them entirely.
const MemoAgentCompanyPanel = React.memo(AgentCompanyPanel)
const MemoAICodeChatPanel = React.memo(AICodeChatPanel)
const MemoPreviewPane = React.memo(PreviewPane)

const CHAT_DEFAULT_SIZE = 34
const CHAT_MIN_SIZE = 24
import { ProjectInviteDialog } from "./project-invite-dialog"
import { TerminalPanel } from "./terminal-panel"
import { ToolScreen } from "./tool-screen"
import { WorkspaceTopBar, type WorkspacePanelId } from "./workspace-top-bar"

const TERMINAL_DEFAULT_SIZE = 32
const TERMINAL_MIN_SIZE = 14
const PENDING_CODE_TOOL_KEY = "code-workspace:pending-tool"

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
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState("")
  const [openPanels, setOpenPanels] = React.useState<Set<WorkspacePanelId>>(
    () => new Set<WorkspacePanelId>(["preview", "terminal"]),
  )
  const [activePanel, setActivePanel] = React.useState<WorkspacePanelId | null>("preview")
  const [newTabOpen, setNewTabOpen] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [activeTool, setActiveTool] = React.useState<WorkspaceToolId | null>(null)
  const [codeHubOpen, setCodeHubOpen] = React.useState(false)
  // Mobile: the desktop side-by-side resizable split crams the chat and the
  // preview into two unusable columns on a phone. Instead, show ONE panel at a
  // time with a bottom toggle (Empresa ↔ Preview).
  const isMobile = useIsMobile()
  const [mobileView, setMobileView] = React.useState<"chat" | "preview">("chat")
  const chatColumnRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const onFocusCeo = () => {
      setChatOpen(true)
      setMobileView("chat")
      window.requestAnimationFrame(() => {
        chatColumnRef.current?.querySelector<HTMLElement>("textarea, [contenteditable='true']")?.focus()
      })
    }
    window.addEventListener(CODE_FOCUS_CEO_CHAT_EVENT, onFocusCeo)
    return () => window.removeEventListener(CODE_FOCUS_CEO_CHAT_EVENT, onFocusCeo)
  }, [])

  React.useEffect(() => {
    try {
      window.localStorage.setItem("code-workspace:preview-open", previewOpen ? "1" : "0")
    } catch {
      /* storage disabled - fail soft */
    }
  }, [previewOpen])

  const toggleTerminal = React.useCallback(() => {
    setTerminalOpen((value) => {
      const next = !value
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

  const handleTogglePanel = React.useCallback((id: WorkspacePanelId) => {
    // Focusing a real tab dismisses the "Nueva pestaña" picker (it overlays
    // the main area, so the switch would otherwise be invisible).
    setNewTabOpen(false)
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
      setCodeHubOpen(false)
      setActiveTool(id)
    }
  }, [])

  const handleClosePanel = React.useCallback((id: WorkspacePanelId) => {
    setOpenPanels((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setActivePanel((current) => (current === id ? null : current))
    if (id === "terminal") setTerminalOpen(false)
    if (id === "preview") setPreviewOpen(false)
    // Git/Validation render through the single-tool screen — closing their
    // tab must also dismiss that screen.
    if (id === "git" || id === "validation") {
      setActiveTool((current) => (current === id ? null : current))
    }
  }, [])

  const openComposer = React.useCallback(() => {
    setChatOpen(true)
    setMobileView("chat")
    focusChat()
    window.dispatchEvent(new CustomEvent("siragpt:code-composer-mode"))
  }, [focusChat])

  // Mobile flips Empresa ↔ Preview. Desktop keeps CEO Office available as the
  // direct command surface.
  const toggleChat = React.useCallback(() => {
    if (isMobile) {
      setMobileView((view) => (view === "chat" ? "preview" : "chat"))
      return
    }
    setChatOpen(true)
    focusChat()
  }, [focusChat, isMobile])

  const openToolIds = React.useMemo<WorkspaceToolId[]>(() => {
    const ids = new Set<WorkspaceToolId>()
    if (chatOpen) ids.add("agent")
    if (previewOpen || openPanels.has("preview")) ids.add("preview")
    if (terminalOpen || openPanels.has("terminal")) ids.add("shell")
    if (activeTool) ids.add(activeTool)
    return Array.from(ids)
  }, [activeTool, chatOpen, openPanels, previewOpen, terminalOpen])

  const handleSelectTool = React.useCallback(
    (id: WorkspaceToolId) => {
      setNewTabOpen(false)
      const tool = WORKSPACE_TOOLS[id]
      if (!tool) return
      if (tool.behavior === "action") {
        if (id === "agent") {
          openComposer()
          return
        }
        if (id === "new-file") {
          const path = window.prompt("Nombre del archivo (incluye ruta)")
          if (path) createFile(path, "")
        }
        return
      }
      // Preview, Shell, Git and Validation already live as first-class panel
      // tabs — picking them from the "Nueva pestaña" pane goes through the
      // panel toggle so their tab shows up in the strip (Replit behavior).
      if (id === "preview" || id === "shell" || id === "git" || id === "validation") {
        setMobileView("preview")
        handleTogglePanel(id === "shell" ? "terminal" : id)
        if (id === "preview" || id === "shell") setActiveTool(null)
        return
      }
      setCodeHubOpen(false)
      // The full-screen ToolScreen also lives in the preview pane — on mobile
      // switch to it so the opened tool is actually visible.
      setMobileView("preview")
      setActiveTool(id)
    },
    [createFile, handleTogglePanel, openComposer],
  )

  // "Ir a pestaña existente": focus something that is already open.
  const handleJumpToOpen = React.useCallback(
    (id: WorkspaceToolId) => {
      setNewTabOpen(false)
      if (id === "agent") {
        setChatOpen(true)
        setMobileView("chat")
        focusChat()
        return
      }
      if (id === "preview" || id === "shell") {
        setMobileView("preview")
        handleTogglePanel(id === "shell" ? "terminal" : "preview")
        return
      }
      // An already-open tool screen sits right under the picker.
      setMobileView("preview")
      setActiveTool(id)
    },
    [focusChat, handleTogglePanel],
  )

  React.useEffect(() => {
    const openTool = (id: unknown) => {
      if (typeof id !== "string" || !(id in WORKSPACE_TOOLS)) return
      handleSelectTool(id as WorkspaceToolId)
    }

    try {
      const pending = window.localStorage.getItem(PENDING_CODE_TOOL_KEY)
      if (pending) {
        window.localStorage.removeItem(PENDING_CODE_TOOL_KEY)
        window.setTimeout(() => openTool(pending), 0)
      }
    } catch {
      /* fail soft */
    }

    const onOpenTool = (event: Event) => {
      openTool((event as CustomEvent<{ toolId?: string }>).detail?.toolId)
    }
    const onOpenLauncher = () => setNewTabOpen(true)
    window.addEventListener(CODE_OPEN_TOOL_EVENT, onOpenTool)
    window.addEventListener(CODE_OPEN_TOOL_LAUNCHER_EVENT, onOpenLauncher)
    return () => {
      window.removeEventListener(CODE_OPEN_TOOL_EVENT, onOpenTool)
      window.removeEventListener(CODE_OPEN_TOOL_LAUNCHER_EVENT, onOpenLauncher)
    }
  }, [handleSelectTool])

  const loadTemplate = React.useCallback(
    (templateId: string) => {
      const template = CODE_TEMPLATES.find((item) => item.id === templateId)
      if (!template) return
      if (Object.keys(files).length > 0) {
        const confirmed = window.confirm(
          `Cargar la plantilla "${template.name}"? Se crearán o sobrescribirán sus archivos.`,
        )
        if (!confirmed) return
      }
      for (const file of template.files) applyBlock(file.path, file.content)
      openFile(template.entry)
    },
    [applyBlock, files, openFile],
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
    const onLoadTemplate = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id) loadTemplate(id)
    }
    window.addEventListener("siragpt:code-load-template", onLoadTemplate)
    return () => window.removeEventListener("siragpt:code-load-template", onLoadTemplate)
  }, [loadTemplate])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey
      if (!isMod) return

      const key = event.key.toLowerCase()
      if (event.shiftKey && key === "p") {
        event.preventDefault()
        setPaletteQuery("")
        setPaletteOpen(true)
        return
      }
      if (key === "p" && !event.shiftKey) {
        event.preventDefault()
        setPaletteQuery("open ")
        setPaletteOpen(true)
        return
      }
      if (key === "k" && !event.shiftKey) {
        event.preventDefault()
        setPaletteQuery("edit")
        setPaletteOpen(true)
        return
      }
      if (key === "e") {
        event.preventDefault()
        setPreviewOpen((value) => !value)
        return
      }
      if (key === "b") {
        event.preventDefault()
        setNewTabOpen((value) => !value)
        return
      }
      if (key === "l") {
        event.preventDefault()
        setChatOpen(true)
        focusChat()
        return
      }
      if (key === "i") {
        event.preventDefault()
        openComposer()
        return
      }
      if (key === "j" || key === "`") {
        event.preventDefault()
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
      ...CODE_TEMPLATES.map((template) => ({
        id: `template:${template.id}`,
        label: `Plantilla: ${template.name}`,
        keywords: `template plantilla scaffold nueva app ${template.id} ${template.name}`,
        hint: "Nuevo",
        run: () => loadTemplate(template.id),
      })),
      {
        id: "new-file",
        label: "Nuevo archivo...",
        keywords: "new file create",
        run: () => {
          const path = window.prompt("Nombre del archivo (incluye ruta)")
          if (path) createFile(path, "")
        },
      },
      {
        id: "edit-active",
        label: "Editar archivo activo con IA",
        keywords: "edit ai cmd k inline",
        hint: "Cmd K",
        run: () => {
          setChatOpen(true)
          focusChat()
        },
      },
      {
        id: "focus-chat",
        label: "Abrir chat del agente",
        keywords: "focus chat l",
        hint: "Cmd L",
        run: () => {
          setChatOpen(true)
          focusChat()
        },
      },
      {
        id: "composer",
        label: "Composer multi-archivo",
        keywords: "composer multi file plan agent",
        hint: "Cmd I",
        run: openComposer,
      },
      {
        id: "toggle-terminal",
        label: terminalOpen ? "Ocultar Shell" : "Mostrar Shell",
        keywords: "terminal shell repl",
        hint: "Cmd J",
        run: toggleTerminal,
      },
      {
        id: "reset",
        label: "Restaurar ejemplo",
        keywords: "reset starter",
        run: () => {
          const confirmed = window.confirm("Esto restaurará los archivos de ejemplo y descartará el workspace actual.")
          if (confirmed) resetWorkspace()
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

  const filteredCommands = React.useMemo(() => {
    const query = paletteQuery.trim().toLowerCase()
    if (!query) return commands
    return commands.filter((command) =>
      `${command.label} ${command.keywords ?? ""}`.toLowerCase().includes(query),
    )
  }, [commands, paletteQuery])

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WorkspaceTopBar
        openPanels={openPanels}
        activePanel={activePanel}
        onTogglePanel={handleTogglePanel}
        onClosePanel={handleClosePanel}
        toolTab={
          activeTool && activeTool !== "git" && activeTool !== "validation"
            ? WORKSPACE_TOOLS[activeTool]
            : null
        }
        toolTabActive={!newTabOpen}
        onFocusToolTab={() => {
          setMobileView("preview")
          setNewTabOpen(false)
        }}
        onCloseToolTab={() => setActiveTool(null)}
        newTabOpen={newTabOpen}
        onCloseNewTab={() => setNewTabOpen(false)}
        toolsMenu={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Abrir herramientas"
            onClick={() => {
              // On mobile the picker lives in the preview pane, which is
              // hidden behind the Agente view — surface it before opening.
              setMobileView("preview")
              setNewTabOpen(true)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        }
        onOpenSearch={() => {
          setPaletteQuery("")
          setPaletteOpen(true)
        }}
        onOpenInvite={() => setInviteOpen(true)}
        inviteOpen={inviteOpen}
        onOpenCode={() => {
          setActiveTool(null)
          setNewTabOpen(false)
          setCodeHubOpen(true)
          setMobileView("preview")
        }}
        codeOpen={codeHubOpen}
        onOpenPublishing={() => {
          setCodeHubOpen(false)
          setNewTabOpen(false)
          setActiveTool("publishing")
          setMobileView("preview")
        }}
        publishingOpen={activeTool === "publishing"}
        onToggleChat={toggleChat}
      />

      <div className="relative min-h-0 flex-1">
        {(() => {
          // Shared right-hand area: the preview + optional terminal (plus the
          // code-hub / tool / launcher overlays). The panel tabs live in the
          // global header, so the pane starts directly with the preview.
          const mainArea = (
            <>
              <div className="absolute inset-0">
                <ResizablePanelGroup direction="vertical">
                  <ResizablePanel defaultSize={terminalOpen ? 100 - TERMINAL_DEFAULT_SIZE : 100} minSize={30}>
                    <MemoPreviewPane />
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
              </div>

              {codeHubOpen ? (
                <CodeHub open onClose={() => setCodeHubOpen(false)} />
              ) : activeTool ? (
                <ToolScreen
                  toolId={activeTool}
                  onClose={() => setActiveTool(null)}
                  onBackToLauncher={() => {
                    setActiveTool(null)
                    setNewTabOpen(true)
                  }}
                />
              ) : null}

              <NewTabPane
                open={newTabOpen}
                onClose={() => setNewTabOpen(false)}
                onSelectTool={handleSelectTool}
                onJumpToOpen={handleJumpToOpen}
                openToolIds={openToolIds}
              />
            </>
          )

          // ── Mobile: one panel at a time + a bottom Agente/Preview toggle ──
          // The desktop horizontal resizable split is unusable on a phone
          // (two crammed columns). Both panels stay MOUNTED (toggled with
          // hidden) so chat state and the live preview survive switching.
          if (isMobile) {
            return (
              <div className="flex h-full min-h-0 flex-col">
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <div className={cn("absolute inset-0", mobileView === "chat" ? "block" : "hidden")}>
                    <MemoAgentCompanyPanel />
                  </div>
                  <div className={cn("absolute inset-0", mobileView === "preview" ? "block" : "hidden")}>
                    {mainArea}
                  </div>
                </div>
                <div className="flex shrink-0 border-t border-border/60 bg-background">
                  {([
                    { id: "chat", label: "Empresa" },
                    { id: "preview", label: "Preview" },
                  ] as const).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setMobileView(tab.id)}
                      aria-pressed={mobileView === tab.id}
                      className={cn(
                        "flex-1 px-3 py-2.5 text-xs font-medium transition-colors",
                        mobileView === tab.id
                          ? "border-t-2 border-primary text-foreground"
                          : "border-t-2 border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          }

          // ── Desktop: [APPS company rail] | [CEO Office] | [Preview]
          // The company panel portals into the sidebar while CEO Office remains
          // the direct workspace command surface.
          return (
            <>
              <MemoAgentCompanyPanel />
              <ResizablePanelGroup direction="horizontal" className="h-full">
                {chatOpen ? (
                  <>
                    <ResizablePanel
                      defaultSize={CHAT_DEFAULT_SIZE}
                      minSize={CHAT_MIN_SIZE}
                      maxSize={50}
                      className="min-w-0"
                    >
                      <div ref={chatColumnRef} className="h-full min-h-0 border-r border-border/50">
                        <MemoAICodeChatPanel embedded title="CEO Office" />
                      </div>
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                  </>
                ) : null}
                <ResizablePanel defaultSize={chatOpen ? 66 : 100} minSize={32} className="relative min-w-0">
                  {mainArea}
                </ResizablePanel>
              </ResizablePanelGroup>
            </>
          )
        })()}
      </div>

      <ProjectInviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <Dialog
        open={paletteOpen}
        onOpenChange={(open) => {
          setPaletteOpen(open)
          if (!open) setPaletteQuery("")
        }}
      >
        <DialogContent className="p-0 sm:max-w-[560px]">
          <DialogHeader className="px-4 pb-2 pt-4">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <CommandIcon className="h-4 w-4" />
              Paleta de comandos
            </DialogTitle>
            <DialogDescription className="sr-only">
              Acciones del workspace de codigo.
            </DialogDescription>
          </DialogHeader>
          <div className="px-4 pb-4">
            <Input
              autoFocus
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="Escribe una accion o un archivo..."
              className="h-9"
            />
            <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border/60">
              {filteredCommands.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Sin resultados
                </div>
              ) : (
                filteredCommands.map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
                    onClick={() => {
                      command.run()
                      setPaletteOpen(false)
                      setPaletteQuery("")
                    }}
                  >
                    <span className="truncate">{command.label}</span>
                    <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {command.hint ? <kbd className="rounded bg-muted px-1.5 py-px">{command.hint}</kbd> : null}
                      <span>{command.id.split(":")[0]}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Atajos: Cmd P abre archivos, Cmd Shift P paleta, Cmd K editar con IA, Cmd L chat, Cmd I composer, Cmd J shell.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
