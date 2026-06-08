"use client"

/**
 * CodeHub — the "Código" surface for /code. Opened from the top-bar
 * "Código" button. Shows the whole workspace: file tree (left) + editor
 * (right). Picking a file in the tree opens it in the editor. Includes
 * Export ZIP (real, client-side) and GitHub push (coming soon).
 *
 * This replaces the always-on central editor: code now lives here, on
 * demand, keeping the main workspace focused on chat + live preview.
 */

import * as React from "react"
import { Download, FolderGit2, Github, Loader2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

import { EditorPanel } from "./editor-panel"
import { FileTreePanel } from "./file-tree-panel"

type Props = {
  open: boolean
  onClose: () => void
}

export function CodeHub({ open, onClose }: Props) {
  const { files, activeFolder } = useCodeWorkspace()
  const [exporting, setExporting] = React.useState(false)

  // Esc closes the hub.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const fileCount = Object.keys(files).length

  const exportZip = React.useCallback(async () => {
    const entries = Object.values(files)
    if (entries.length === 0) {
      toast.message("No hay archivos para exportar todavía.")
      return
    }
    setExporting(true)
    try {
      // Dynamically import the heavy zip libs so they never touch the
      // critical path — only loaded when the user actually exports.
      const [{ default: JSZip }, fileSaver] = await Promise.all([
        import("jszip"),
        import("file-saver"),
      ])
      const zip = new JSZip()
      for (const f of entries) {
        zip.file(f.path, f.content ?? "")
      }
      const blob = await zip.generateAsync({ type: "blob" })
      const safeName =
        (activeFolder?.name || "siragpt-workspace")
          .toLowerCase()
          .replace(/[^a-z0-9-_]+/g, "-")
          .replace(/^-+|-+$/g, "") || "workspace"
      fileSaver.saveAs(blob, `${safeName}.zip`)
      toast.success(`Exportado ${entries.length} archivo(s) → ${safeName}.zip`)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo exportar el ZIP")
    } finally {
      setExporting(false)
    }
  }, [files, activeFolder])

  if (!open) return null

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-background"
      role="dialog"
      aria-label="Código del proyecto"
    >
      {/* futurist violet edge */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[hsl(var(--accent-violet)/0.85)] to-transparent"
      />

      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))]">
            <FolderGit2 className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">
            Código
          </span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            · {activeFolder?.name || "Workspace"} · {fileCount} archivo{fileCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-md px-2.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            onClick={exportZip}
            disabled={exporting}
            aria-label="Exportar proyecto como ZIP"
          >
            {exporting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            Exportar ZIP
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 cursor-not-allowed rounded-md px-2.5 text-[11px] font-normal text-muted-foreground/70"
            onClick={() => toast.message("GitHub: conexión disponible próximamente.")}
            aria-label="Subir a GitHub (próximamente)"
          >
            <Github className="mr-1.5 h-3.5 w-3.5" />
            GitHub
            <span className="ml-1.5 rounded bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide">
              Pronto
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Cerrar Código"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={24} minSize={14} maxSize={40} className="min-w-0">
            <FileTreePanel />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={76} minSize={40} className="min-w-0">
            <EditorPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
