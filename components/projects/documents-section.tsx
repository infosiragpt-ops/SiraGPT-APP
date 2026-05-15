"use client"

/**
 * DocumentsSection — card on the project detail page listing the
 * project's ProjectDocument rows. Each row links to the Tiptap
 * editor at /projects/:id/docs/:docId. "+" creates a new empty
 * document and navigates into it directly (zero-step authoring).
 *
 * Deliberately kept light — no search / filter / preview hover;
 * most projects will have 1-5 documents and listing them in
 * reverse-chronological order with a title + snippet is enough.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileText, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  projectDocumentsService, type ProjectDocumentSummary,
} from "@/lib/project-documents-service"

interface Props {
  projectId: string
}

export function DocumentsSection({ projectId }: Props) {
  const router = useRouter()
  const [docs, setDocs] = React.useState<ProjectDocumentSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [creating, setCreating] = React.useState(false)

  const reload = React.useCallback(async () => {
    try {
      setDocs(await projectDocumentsService.list(projectId))
    } catch (err: any) {
      toast.error(err?.message || "Error al listar documentos")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  React.useEffect(() => { reload() }, [reload])

  async function createNew() {
    if (creating) return
    setCreating(true)
    try {
      const doc = await projectDocumentsService.create(projectId, {
        title: "Documento sin título",
        content: "",
      })
      router.push(`/projects/${projectId}/docs/${doc.id}`)
    } catch (err: any) {
      toast.error(err?.message || "Error al crear documento")
      setCreating(false)
    }
  }

  async function handleDelete(id: string, title: string) {
    if (!confirm(`¿Eliminar "${title}"? No se puede deshacer.`)) return
    const prev = docs
    setDocs(cur => cur.filter(d => d.id !== id)) // optimistic
    try {
      await projectDocumentsService.remove(projectId, id)
    } catch (err: any) {
      toast.error(err?.message || "Error al eliminar")
      setDocs(prev)
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h3 className="text-sm font-semibold">Documentos</h3>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={createNew}
          disabled={creating}
          aria-label="Nuevo documento"
        >
          {creating ? <ThinkingIndicator size="sm" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>

      {loading ? (
        <div className="px-4 pb-4 text-xs text-muted-foreground">Cargando…</div>
      ) : docs.length === 0 ? (
        <div className="mx-3 mb-3 rounded-lg bg-muted/40 py-6 px-4 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-background">
            <FileText className="h-4 w-4 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Crea un documento para redactar tesis, notas o borradores dentro del proyecto.
          </p>
        </div>
      ) : (
        <ul className="px-2 pb-2 space-y-0.5">
          {docs.map(d => (
            <li
              key={d.id}
              className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
            >
              <button
                onClick={() => router.push(`/projects/${projectId}/docs/${d.id}`)}
                className="flex items-start gap-2 min-w-0 flex-1 text-left"
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{d.title}</div>
                  {d.snippet && (
                    <div className="text-[10px] text-muted-foreground/80 line-clamp-1 mt-0.5">
                      {d.snippet}
                    </div>
                  )}
                </div>
              </button>
              <button
                onClick={() => handleDelete(d.id, d.title)}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-all shrink-0 mt-0.5"
                aria-label="Eliminar"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
