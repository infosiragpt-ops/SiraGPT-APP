"use client"

/**
 * CodeWorkspace — top-level shell for /code. Three resizable panels
 * (file tree, editor, chat) with a thin top bar showing the active
 * path and a command-palette trigger.
 *
 * The shell stays small and just wires components together; every
 * piece of real state lives in CodeWorkspaceProvider so the layout
 * is purely presentational.
 */

import * as React from "react"
import { AlertTriangle, Command, Download} from "lucide-react"

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
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import {
  browserSupportsLocalFolderSync,
  exportWorkspaceAsZip,
  workspaceExportFilename,
} from "@/lib/code-workspace-utils"

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { EditorPanel } from "./editor-panel"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
export function CodeWorkspace() {
  const {
    files,
    activePath,
    openFile,
    createFile,
    resetWorkspace,
    focusChat,
    registerCommandPaletteHandler,
    openCommandPalette,
    activeFolder,
  } = useCodeWorkspace()

  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState("")

  React.useEffect(() => {
    return registerCommandPaletteHandler(() => setPaletteOpen(true))
  }, [registerCommandPaletteHandler])

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return
      const key = e.key.toLowerCase()
      // Cmd/Ctrl+Shift+P → command palette.
      if (e.shiftKey && key === "p") {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      // Cmd/Ctrl+K opens the palette pre-filtered to "edit" actions —
      // this is the conventional "inline edit" entry point in IDEs.
      if (key === "k" && !e.shiftKey) {
        e.preventDefault()
        setPaletteQuery("edit")
        setPaletteOpen(true)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  const commands = React.useMemo<PaletteCommand[]>(() => {
    const fileItems = Object.keys(files).map((path) => ({
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
        run: () => focusChat(),
      },
      {
        id: "focus-chat",
        label: "Enfocar chat de IA",
        keywords: "focus chat l",
        run: () => focusChat(),
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
  }, [createFile, files, focusChat, openFile, resetWorkspace])

  const filtered = React.useMemo(() => {
    const q = paletteQuery.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    )
  }, [commands, paletteQuery])

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <BrowserCompatBanner />
      <div className="min-h-0 flex-1">
        {/* Layout: AI chat on the left (primary), file tree + editor on the
            right. Putting the chat first matches a "talk to your code"
            workflow where the conversation drives the editor; the right
            side stays as a focused code surface. */}
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={42} minSize={28} maxSize={60} className="min-w-[320px]">
            <AICodeChatPanel />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={58} minSize={40}>
            <EditorPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <Footer />

      <Dialog
        open={paletteOpen}
        onOpenChange={(open) => {
          setPaletteOpen(open)
          if (!open) setPaletteQuery("")
        }}
      >
        <DialogContent className="sm:max-w-[520px] p-0">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Command className="h-4 w-4" />
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
              placeholder="Escribe una acción…"
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
                      "flex w-full items-center justify-between px-3 py-2 text-left text-sm",
                      "hover:bg-muted/50",
                    )}
                    onClick={() => {
                      cmd.run()
                      setPaletteOpen(false)
                      setPaletteQuery("")
                    }}
                  >
                    <span>{cmd.label}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {cmd.id.split(":")[0]}
                    </span>
                  </button>
                ))
              )}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Atajos: Cmd/Ctrl+K abre la paleta para editar, Cmd/Ctrl+L enfoca el chat, Cmd/Ctrl+Shift+P abre la paleta general.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type PaletteCommand = {
  id: string
  label: string
  keywords?: string
  run: () => void
}

/**
 * BrowserCompatBanner — informs the user when the current browser
 * lacks the File System Access API (Safari/Firefox today). In that
 * case the workspace still works (state persists to localStorage)
 * but cannot sync with a folder on disk, so we surface the limitation
 * upfront and point them at Export-as-ZIP.
 *
 * Renders nothing during SSR or on supported browsers.
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

function Footer() {
  const { files } = useCodeWorkspace()
  const [exporting, setExporting] = React.useState(false)
  const fileCount = Object.keys(files).length

  const handleExport = React.useCallback(async () => {
    if (exporting) return
    if (typeof window === "undefined") return
    setExporting(true)
    try {
      const blob = await exportWorkspaceAsZip(files)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = workspaceExportFilename()
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoke after a tick to let the download start without yanking
      // the URL out from under the browser.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      // Surface the failure but keep the button responsive.
      console.error("[code-workspace] export-as-zip failed:", err)
      window.alert(`No se pudo exportar el ZIP: ${(err as Error)?.message || "error desconocido"}`)
    } finally {
      setExporting(false)
    }
  }, [exporting, files])

  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/60 bg-muted/20 px-4 text-[11px] text-muted-foreground">
      <span>Workspace local · cambios guardados en este navegador</span>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={exporting || fileCount === 0}
          onClick={handleExport}
          title={fileCount === 0 ? "Sin archivos para exportar" : `Exportar ${fileCount} archivo(s) como ZIP`}
        >
          {exporting ? (
            <ThinkingIndicator size="xs" className="mr-1" />
          ) : (
            <Download className="mr-1 h-3 w-3" />
          )}
          Exportar como ZIP
        </Button>
        <span className="opacity-80">Inspirado en patrones de Cursor</span>
      </div>
    </div>
  )
}
