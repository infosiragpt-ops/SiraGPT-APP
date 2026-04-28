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
import { Command } from "lucide-react"

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

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { EditorPanel } from "./editor-panel"

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

function Footer() {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/60 bg-muted/20 px-4 text-[11px] text-muted-foreground">
      <span>Workspace local · cambios guardados en este navegador</span>
      <span className="opacity-80">Inspirado en patrones de Cursor</span>
    </div>
  )
}
