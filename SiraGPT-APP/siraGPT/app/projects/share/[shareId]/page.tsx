"use client"

/**
 * /projects/share/[shareId] — public read-only project snapshot.
 *
 * Renders only what a non-owner should see:
 *   - project name + description
 *   - list of attached file names (not their content)
 *   - created / last-updated timestamps
 *
 * NO chat history. NO instructions text. NO owner info. NO "memory"
 * entries. These are all private to the owner — the share link is a
 * "here's the shape of what I'm working on", not a full window in.
 *
 * Unauthenticated clients can hit this page. The backend endpoint
 * (/api/projects/share/:shareId) sits outside the JWT middleware
 * for the same reason.
 */

import * as React from "react"
import { useParams } from "next/navigation"
import { FileText, FolderKanban } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { es as dfEs, enUS as dfEn } from "date-fns/locale"

import { projectsService, type SharedProjectSnapshot } from "@/lib/projects-service"

export default function PublicProjectSharePage() {
  const { shareId } = useParams<{ shareId: string }>()
  const [project, setProject] = React.useState<SharedProjectSnapshot | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    (async () => {
      try {
        const p = await projectsService.getShared(shareId)
        setProject(p)
      } catch (err: any) {
        setError(err?.message || "Not found")
      } finally {
        setLoading(false)
      }
    })()
  }, [shareId])

  const dateLocale = typeof document !== "undefined" && document.documentElement.lang?.startsWith("es") ? dfEs : dfEn

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    )
  }

  if (error || !project) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <FolderKanban className="h-6 w-6 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight mb-1">Project unavailable</h1>
          <p className="text-sm text-muted-foreground">
            This share link is invalid or has been revoked.
          </p>
        </div>
      </div>
    )
  }

  const rel = (() => {
    try { return formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true, locale: dateLocale }) }
    catch { return "" }
  })()

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-8">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-muted-foreground mb-3">
            <FolderKanban className="h-3.5 w-3.5" />
            Shared project
          </div>
          <h1 className="text-3xl font-serif tracking-tight mb-2">{project.name}</h1>
          {project.description && (
            <p className="text-base text-foreground/80 leading-relaxed max-w-2xl">
              {project.description}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-4">Updated {rel}</p>
        </header>

        <section className="rounded-xl border border-border/60 bg-card">
          <h2 className="px-5 pt-4 text-sm font-semibold">Files</h2>
          {project.files.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No files attached to this project.
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {project.files.map(f => (
                <li key={f.id} className="flex items-center gap-3 px-5 py-3">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{f.originalName}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {f.mimeType} · {(f.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-8 text-center text-xs text-muted-foreground">
          This is a read-only snapshot. The owner's chats and instructions stay private.
        </footer>
      </div>
    </div>
  )
}
