"use client"

/**
 * /projects/[id]/docs/[docId] — full-page Tiptap editor for a
 * single ProjectDocument.
 *
 * Flow:
 *   1. Load the document (title + content).
 *   2. Render the editor with that Markdown as initial content.
 *   3. On every change, push to local state; a debounced effect
 *      (1.2s idle) saves to the backend via PUT.
 *   4. Header shows live save status: "Guardando…" → "Guardado hace
 *      3s" so the user trusts the auto-save instead of hitting Cmd+S.
 *
 * The editor itself is fully isolated in components/editor/. This
 * page is the glue: route params → fetch → editor → save.
 */

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft, Download, Trash2, Check, FileText } from "lucide-react"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"

// The Tiptap rich-text editor adds ~150KB+ of vendor JS (prosemirror,
// codemirror, extensions). Only this page mounts it, so we defer the
// chunk until the route boots. SSR is disabled — Tiptap's editor needs
// a DOM and is hydration-incompatible with the empty server output.
const TiptapEditor = dynamic(
  () => import("@/components/editor/tiptap-editor").then((m) => m.TiptapEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full flex-col gap-3 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    ),
  },
)
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  projectDocumentsService, type ProjectDocument,
} from "@/lib/project-documents-service"

const AUTOSAVE_MS = 1200
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error"

export default function ProjectDocumentPage() {
  const { id: projectId, docId } = useParams<{ id: string; docId: string }>()
  const router = useRouter()

  const [doc, setDoc] = React.useState<ProjectDocument | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [title, setTitle] = React.useState("")
  const [content, setContent] = React.useState("")
  const [stats, setStats] = React.useState({ chars: 0, words: 0 })
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle")
  const [lastSavedAt, setLastSavedAt] = React.useState<Date | null>(null)

  // ── Load ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false
    projectDocumentsService.get(projectId, docId)
      .then(d => {
        if (cancelled) return
        setDoc(d)
        setTitle(d.title)
        setContent(d.content)
        setLastSavedAt(new Date(d.updatedAt))
      })
      .catch(err => toast.error(err?.message || "Error al cargar el documento"))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, docId])

  // ── Auto-save ───────────────────────────────────────────────────────────
  //
  // The timer approach is deliberate — we accept one save per
  // idle-cycle rather than coalescing via a ref + setTimeout inside
  // the editor's onUpdate. Keeping the debounce in a React effect
  // lets us surface "Guardando…" state cleanly in the header.
  const prevLoad = React.useRef({ title: "", content: "" })
  React.useEffect(() => {
    if (loading || !doc) return
    // Don't save if nothing changed from the just-loaded state.
    if (title === prevLoad.current.title && content === prevLoad.current.content) return
    if (title === doc.title && content === doc.content) return

    setSaveStatus("dirty")
    const handle = setTimeout(async () => {
      try {
        setSaveStatus("saving")
        const updated = await projectDocumentsService.update(projectId, docId, {
          title: title || "Documento sin título",
          content,
        })
        setDoc(updated)
        prevLoad.current = { title: updated.title, content: updated.content }
        setLastSavedAt(new Date(updated.updatedAt))
        setSaveStatus("saved")
      } catch (err: any) {
        toast.error(err?.message || "Error al guardar")
        setSaveStatus("error")
      }
    }, AUTOSAVE_MS)
    return () => clearTimeout(handle)
  }, [title, content, doc, loading, projectId, docId])

  // Tick the "saved X ago" label so it updates without us re-saving.
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 10000)
    return () => clearInterval(id)
  }, [])

  // ── Actions ─────────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!doc) return
    if (!confirm(`¿Eliminar "${doc.title}"? No se puede deshacer.`)) return
    try {
      await projectDocumentsService.remove(projectId, docId)
      toast.success("Documento eliminado")
      router.push(`/projects/${projectId}`)
    } catch (err: any) {
      toast.error(err?.message || "Error al eliminar")
    }
  }

  function handleExportMd() {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${(title || "documento").replace(/\s+/g, "-").toLowerCase()}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <ThinkingIndicator size="md" className="text-muted-foreground" />
      </div>
    )
  }
  if (!doc) {
    return (
      <div className="min-h-screen p-10 text-center text-muted-foreground">
        Documento no encontrado.
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Thin header — breadcrumb + title + status + actions. The
          editor's own toolbar sits beneath this, so we keep this row
          tight. */}
      <header className="border-b border-border/60 bg-background/95 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-5xl px-4 md:px-6 py-2.5 flex items-center gap-3">
          <button
            onClick={() => router.push(`/projects/${projectId}`)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Empresa</span>
          </button>

          <div className="h-5 w-px bg-border shrink-0" />

          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Documento sin título"
            className="h-8 border-0 shadow-none px-2 text-base font-medium focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
          />

          <SaveIndicator status={saveStatus} lastSavedAt={lastSavedAt} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 h-8 shrink-0">
                <FileText className="h-3.5 w-3.5" />
                <span className="text-xs tabular-nums">{stats.words} palabras</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExportMd}>
                <Download className="mr-2 h-4 w-4" />
                Exportar .md
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDelete} className="text-red-600 focus:text-red-600">
                <Trash2 className="mr-2 h-4 w-4" />
                Eliminar documento
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* Editor — fills remaining vertical space so long docs scroll
          inside the editor rather than the page. */}
      <div className="mx-auto max-w-5xl w-full flex-1 flex flex-col">
        <TiptapEditor
          initialMarkdown={doc.content}
          onChange={(md, chars, words) => {
            setContent(md)
            setStats({ chars, words })
          }}
        />
      </div>
    </div>
  )
}

// ─── Save indicator ───────────────────────────────────────────────────────

function SaveIndicator({
  status, lastSavedAt,
}: {
  status: SaveStatus
  lastSavedAt: Date | null
}) {
  const text = (() => {
    if (status === "saving") return "Guardando…"
    if (status === "dirty") return "Cambios sin guardar"
    if (status === "error") return "Error al guardar"
    if (status === "saved" || (status === "idle" && lastSavedAt)) {
      if (!lastSavedAt) return "Guardado"
      try {
        return `Guardado ${formatDistanceToNow(lastSavedAt, { addSuffix: true })}`
      } catch {
        return "Guardado"
      }
    }
    return ""
  })()

  return (
    <div className={cn(
      "flex items-center gap-1.5 text-[11px] shrink-0 transition-opacity",
      status === "error" ? "text-red-500" : "text-muted-foreground",
    )}>
      {status === "saving" && <ThinkingIndicator size="xs" />}
      {status === "saved" && <Check className="h-3 w-3" />}
      <span className="tabular-nums">{text}</span>
    </div>
  )
}
