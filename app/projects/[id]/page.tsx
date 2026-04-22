"use client"

/**
 * /projects/[id] — project detail + launchpad.
 *
 * Matches the Claude Projects reference: a breadcrumb back to the
 * index, a title + description row, a prominent composer ("¿Cómo
 * puedo ayudarle hoy?") that launches a new chat inside the project,
 * and a right-hand side panel with Memoria / Instrucciones /
 * Archivos sections.
 *
 * Launch flow (composer → chat):
 *   1. User types and hits send.
 *   2. We POST /api/projects/:id/chat to create a new Chat row bound
 *      to this project (the AI route then auto-injects project
 *      instructions + file content into the system prompt).
 *   3. We stash the typed prompt in sessionStorage under
 *      "project-prefill:<chatId>" so the chat page can pre-fill its
 *      composer on mount. Prefill, not auto-send — we let the user
 *      review/edit before sending to keep the UX unsurprising.
 *   4. Router.push to /chat?id=<chatId>. The chat context picks up
 *      the new chat id, loads messages (none yet), and the user hits
 *      Send from the full-featured chat UI.
 *
 * No AI call happens on this page — we leave all streaming /
 * persistence concerns to the existing chat stack.
 */

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArrowLeft, MoreHorizontal, Star, Plus, Send,
  FileText, Trash2, Lock, Loader2, Paperclip, Pencil,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { projectsService, type ProjectDetail } from "@/lib/projects-service"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

// ─── Page ─────────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const t = useTranslations("projects")

  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [draft, setDraft] = React.useState("")
  const [launching, setLaunching] = React.useState(false)
  const [instructionsOpen, setInstructionsOpen] = React.useState(false)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      setProject(await projectsService.get(id))
    } catch (err: any) {
      toast.error(err?.message || t("detailLoadFailed"))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => { reload() }, [reload])

  async function handleToggleStar() {
    if (!project) return
    const next = !project.isStarred
    setProject({ ...project, isStarred: next }) // optimistic
    try {
      await projectsService.update(project.id, { isStarred: next })
    } catch (err: any) {
      setProject({ ...project, isStarred: !next }) // rollback
      toast.error(err?.message || t("updateFailed"))
    }
  }

  async function handleDelete() {
    if (!project) return
    if (!confirm(t("deleteConfirm", { name: project.name }))) return
    try {
      await projectsService.remove(project.id)
      toast.success(t("deleted"))
      router.push("/projects")
    } catch (err: any) {
      toast.error(err?.message || t("deleteFailed"))
    }
  }

  async function handleLaunch(e?: React.FormEvent) {
    e?.preventDefault()
    if (!project || !draft.trim() || launching) return
    setLaunching(true)
    try {
      const titleFromDraft = draft.trim().split("\n")[0].slice(0, 80)
      const chat = await projectsService.startChat(project.id, { title: titleFromDraft })
      // Prefill the chat composer with what the user just typed, so
      // one click in /chat doesn't cost them their draft. We don't
      // auto-send — that would surprise the user if they wanted to
      // tweak the prompt on the way in.
      try {
        sessionStorage.setItem(`project-prefill:${chat.id}`, draft)
      } catch {
        /* private-mode / quota-exceeded — non-fatal, worst case is a lost draft */
      }
      router.push(`/chat?id=${chat.id}`)
    } catch (err: any) {
      toast.error(err?.message || t("launchFailed"))
      setLaunching(false)
    }
  }

  function openRecentChat(chatId: string) {
    router.push(`/chat?id=${chatId}`)
  }

  if (loading) return <LoadingState />
  if (!project) return <NotFoundState t={t} />

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 md:px-8 py-6 md:py-10">
        {/* Breadcrumb */}
        <button
          onClick={() => router.push("/projects")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("allProjects")}
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 lg:gap-8">
          {/* ── Left column: title + composer + recent chats ─────────────── */}
          <div>
            <header className="flex items-start justify-between gap-3 mb-5">
              <div className="min-w-0">
                <h1 className="text-3xl font-serif tracking-tight truncate">{project.name}</h1>
                {project.description && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{project.description}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleToggleStar} aria-label={t("star")}>
                  <Star className={cn("h-4 w-4", project.isStarred && "fill-yellow-400 text-yellow-400")} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setInstructionsOpen(true)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      {t("editInstructions")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleDelete} className="text-red-600 focus:text-red-600">
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("deleteProject")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>

            {/* Composer (launcher) — intentionally minimal. Full chat
                features live in the /chat page; this is just the
                entry point. */}
            <form onSubmit={handleLaunch} className="mb-4">
              <div className="rounded-xl border border-border/60 bg-background shadow-sm focus-within:border-foreground/40 focus-within:shadow-md transition-all">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleLaunch() }
                  }}
                  placeholder={t("composerPlaceholder")}
                  rows={3}
                  disabled={launching}
                  className="border-0 resize-none bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
                />
                <div className="flex items-center justify-between px-2 pb-2">
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button
                    type="submit"
                    disabled={!draft.trim() || launching}
                    size="sm"
                    className="gap-1.5 h-8"
                  >
                    {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    {t("send")}
                  </Button>
                </div>
              </div>
            </form>

            {/* Recent chats within this project — empty state when
                the project has none yet, mirroring the reference UX. */}
            {project.chats.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 py-8 px-6 text-center text-sm text-muted-foreground">
                {t("startConversation")}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60 px-1">
                  {t("chatsInProject")}
                </div>
                {project.chats.map(c => (
                  <button
                    key={c.id}
                    onClick={() => openRecentChat(c.id)}
                    className="w-full text-left rounded-lg border border-border/60 px-4 py-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="text-sm font-medium truncate">{c.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(c.updatedAt).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Right column: memory / instructions / files ────────────── */}
          <aside className="space-y-4 lg:sticky lg:top-6 self-start">
            <MemorySection t={t} />
            <InstructionsSection
              t={t}
              project={project}
              onEdit={() => setInstructionsOpen(true)}
            />
            <FilesSection
              t={t}
              project={project}
              onChange={reload}
            />
          </aside>
        </div>
      </div>

      <InstructionsDialog
        open={instructionsOpen}
        onOpenChange={setInstructionsOpen}
        project={project}
        onSaved={(updated) => {
          setProject(prev => prev ? { ...prev, instructions: updated.instructions } : prev)
          setInstructionsOpen(false)
          toast.success(t("instructionsSaved"))
        }}
      />
    </div>
  )
}

// ─── Right-panel cards ────────────────────────────────────────────────────

function MemorySection({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-start justify-between px-4 pt-4">
        <h3 className="text-sm font-semibold">{t("memory")}</h3>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground rounded-full border border-border/60 px-2 py-0.5">
          <Lock className="h-3 w-3" />
          {t("onlyYou")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground px-4 pb-4 pt-1 leading-relaxed">
        {t("memoryDesc")}
      </p>
    </div>
  )
}

function InstructionsSection({
  t, project, onEdit,
}: {
  t: ReturnType<typeof useTranslations>
  project: ProjectDetail
  onEdit: () => void
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between px-4 pt-4">
        <h3 className="text-sm font-semibold">{t("instructions")}</h3>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit} aria-label={t("editInstructions")}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {project.instructions ? (
        <p className="text-xs text-foreground/80 px-4 pb-4 pt-1 leading-relaxed whitespace-pre-wrap line-clamp-6">
          {project.instructions}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground px-4 pb-4 pt-1 leading-relaxed">
          {t("instructionsDesc")}
        </p>
      )}
    </div>
  )
}

function FilesSection({
  t, project, onChange,
}: {
  t: ReturnType<typeof useTranslations>
  project: ProjectDetail
  onChange: () => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = React.useState(false)

  async function handlePickFile() {
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setUploading(true)
    try {
      // Upload first, then attach. We reuse the existing /api/files
      // upload endpoint — projects just borrow the File model via its
      // projectId FK, so no new upload plumbing is needed.
      const fd = new FormData()
      for (const f of files) fd.append("files", f)
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      const res = await fetch(`${API_ROOT}/files/upload`, {
        method: "POST",
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) throw new Error(`upload failed (${res.status})`)
      const out = await res.json()
      const uploaded: Array<{ id: string }> = out.files || []
      for (const u of uploaded) {
        await projectsService.attachFile(project.id, u.id)
      }
      onChange()
      toast.success(t("filesAttached", { count: uploaded.length }))
    } catch (err: any) {
      toast.error(err?.message || t("uploadFailed"))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function detach(fileId: string) {
    try {
      await projectsService.detachFile(project.id, fileId)
      onChange()
    } catch (err: any) {
      toast.error(err?.message || t("detachFailed"))
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h3 className="text-sm font-semibold">{t("files")}</h3>
        <Button
          size="icon" variant="ghost" className="h-7 w-7"
          onClick={handlePickFile}
          disabled={uploading}
          aria-label={t("attachFile")}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {project.files.length === 0 ? (
        <div className="mx-3 mb-3 rounded-lg bg-muted/40 py-8 px-4 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-background">
            <Paperclip className="h-4 w-4 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t("filesEmpty")}
          </p>
        </div>
      ) : (
        <div className="px-2 pb-2">
          {project.files.map(f => (
            <div
              key={f.id}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/40 transition-colors"
            >
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{f.originalName}</div>
                <div className="text-[10px] text-muted-foreground">
                  {(f.size / 1024).toFixed(1)} KB
                </div>
              </div>
              <Button
                size="icon" variant="ghost"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => detach(f.id)}
                aria-label={t("detachFile")}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Dialogs ──────────────────────────────────────────────────────────────

function InstructionsDialog({
  open, onOpenChange, project, onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  project: ProjectDetail
  onSaved: (p: { instructions: string | null }) => void
}) {
  const t = useTranslations("projects")
  const [value, setValue] = React.useState(project.instructions || "")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) setValue(project.instructions || "")
  }, [open, project.instructions])

  async function save() {
    setSaving(true)
    try {
      const updated = await projectsService.update(project.id, {
        instructions: value.trim() || null,
      })
      onSaved({ instructions: updated.instructions ?? null })
    } catch (err: any) {
      toast.error(err?.message || t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("instructions")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("instructionsDesc")}</p>
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            maxLength={16000}
            className="resize-none"
            placeholder={t("instructionsPlaceholder")}
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Skeletons / fallbacks ────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 md:px-8 py-10">
      <div className="h-4 w-32 bg-muted/40 rounded animate-pulse mb-4" />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
        <div>
          <div className="h-8 w-1/2 bg-muted/40 rounded animate-pulse mb-2" />
          <div className="h-4 w-1/3 bg-muted/40 rounded animate-pulse mb-6" />
          <div className="h-32 rounded-xl border border-border/60 bg-muted/20 animate-pulse" />
        </div>
        <div className="space-y-4">
          <div className="h-24 rounded-xl border border-border/60 bg-muted/20 animate-pulse" />
          <div className="h-24 rounded-xl border border-border/60 bg-muted/20 animate-pulse" />
          <div className="h-40 rounded-xl border border-border/60 bg-muted/20 animate-pulse" />
        </div>
      </div>
    </div>
  )
}

function NotFoundState({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <h2 className="text-lg font-semibold tracking-tight mb-1">{t("notFoundTitle")}</h2>
      <p className="text-sm text-muted-foreground mb-6">{t("notFoundDesc")}</p>
    </div>
  )
}
