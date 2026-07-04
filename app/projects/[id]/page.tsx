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
  FileText, Trash2, Lock, Paperclip, Pencil,
  Share2, Link as LinkIcon, Check, X, BookOpen,
  Search, Database, MessageSquare, ShieldCheck} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  projectsService,
  type ProjectChatSummary,
  type ProjectContextManifest,
  type ProjectDetail,
  type ProjectMemoryItem,
} from "@/lib/projects-service"
import { DocumentsSection } from "@/components/projects/documents-section"
import { MAX_SIMULTANEOUS_DOCUMENTS } from "@/lib/document-batch-limits"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

// ─── Page ─────────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const t = useTranslations("projects")

  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [context, setContext] = React.useState<ProjectContextManifest | null>(null)
  const [memories, setMemories] = React.useState<ProjectMemoryItem[]>([])
  const [projectChats, setProjectChats] = React.useState<ProjectChatSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [chatsLoading, setChatsLoading] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [chatSearch, setChatSearch] = React.useState("")
  const [debouncedChatSearch, setDebouncedChatSearch] = React.useState("")
  const [launching, setLaunching] = React.useState(false)
  const [composerUploading, setComposerUploading] = React.useState(false)
  const [instructionsOpen, setInstructionsOpen] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const composerFileRef = React.useRef<HTMLInputElement | null>(null)
  const openDeleteAfterMenuClose = React.useCallback(() => {
    window.setTimeout(() => setDeleteOpen(true), 0)
  }, [])

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      // Load project + memory in parallel — memory fetch is allowed
      // to fail (memory is a nice-to-have, not required for the
      // page to render), so we catch locally and default to [].
      const [p, mem, ctx] = await Promise.all([
        projectsService.get(id),
        projectsService.listMemory(id).catch(() => [] as ProjectMemoryItem[]),
        projectsService.context(id).catch(() => null),
      ])
      setProject(p)
      setMemories(mem)
      setContext(ctx)
    } catch (err: any) {
      toast.error(err?.message || t("detailLoadFailed"))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => { reload() }, [reload])

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedChatSearch(chatSearch.trim()), 220)
    return () => clearTimeout(timer)
  }, [chatSearch])

  React.useEffect(() => {
    if (!project) return
    let cancelled = false
    setChatsLoading(true)
    projectsService.listChats(project.id, { search: debouncedChatSearch, limit: 50 })
      .then((rows) => { if (!cancelled) setProjectChats(rows) })
      .catch((err: any) => { if (!cancelled) toast.error(err?.message || "No se pudieron cargar las conversaciones de la empresa") })
      .finally(() => { if (!cancelled) setChatsLoading(false) })
    return () => { cancelled = true }
  }, [project, debouncedChatSearch])

  async function handleDeleteMemory(factId: string) {
    if (!project) return
    setMemories(prev => prev.filter(m => m.id !== factId)) // optimistic
    try {
      await projectsService.deleteMemory(project.id, factId)
    } catch (err: any) {
      toast.error(err?.message || t("memoryDeleteFailed"))
      // Re-fetch to restore state if the delete failed.
      projectsService.listMemory(project.id).then(setMemories).catch(() => {})
    }
  }

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

  async function handleDeleteConfirmed() {
    if (!project) return
    await projectsService.remove(project.id)
    toast.success("Proyecto movido a Papelera por 30 días.")
    router.push("/projects")
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
        sessionStorage.setItem(`project-prefill-context:${chat.id}`, JSON.stringify({
          projectId: project.id,
          files: project.files.map(f => ({ id: f.id, name: f.originalName })),
          hasInstructions: Boolean(project.instructions),
          memoryCount: memories.length,
        }))
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

  async function handleComposerFiles(files: FileList | null) {
    if (!project || !files || files.length === 0) return
    setComposerUploading(true)
    try {
      const fd = new FormData()
      Array.from(files).slice(0, MAX_SIMULTANEOUS_DOCUMENTS).forEach((file) => fd.append("files", file))
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      const res = await fetch(`${API_ROOT}/files/upload`, {
        method: "POST",
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) throw new Error(`upload failed (${res.status})`)
      const out = await res.json()
      const uploaded: Array<{ id: string }> = out.files || []
      for (const file of uploaded) await projectsService.attachFile(project.id, file.id)
      await reload()
      toast.success(t("filesAttached", { count: uploaded.length }))
    } catch (err: any) {
      toast.error(err?.message || t("uploadFailed"))
    } finally {
      setComposerUploading(false)
      if (composerFileRef.current) composerFileRef.current.value = ""
    }
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
                    {project.type === "webapp" ? (
                      <DropdownMenuItem disabled>
                        <Lock className="mr-2 h-4 w-4" />
                        Privado del propietario
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setShareOpen(true)}>
                        <Share2 className="mr-2 h-4 w-4" />
                        {t("share")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={openDeleteAfterMenuClose} className="text-red-600 focus:text-red-600">
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
                <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                  <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                    {project.files.length} archivos
                  </span>
                  <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                    {memories.length} memorias
                  </span>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[10px]", project.instructions ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                    {project.instructions ? "Instrucciones activas" : "Sin instrucciones"}
                  </span>
                </div>
                <div className="flex items-center justify-between px-2 pb-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    disabled={composerUploading}
                    onClick={() => composerFileRef.current?.click()}
                    aria-label={t("attachFile")}
                  >
                    {composerUploading ? <ThinkingIndicator size="sm" /> : <Paperclip className="h-4 w-4" />}
                  </Button>
                  <input
                    ref={composerFileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => handleComposerFiles(e.target.files)}
                  />
                  <Button
                    type="submit"
                    disabled={!draft.trim() || launching}
                    size="sm"
                    className="gap-1.5 h-8"
                  >
                    {launching ? <ThinkingIndicator size="sm" className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                    {t("send")}
                  </Button>
                </div>
              </div>
            </form>

            {/* Marco Teórico launcher — prominent entry point to the
                academic-literature-review pipeline. Kept above the
                recent-chats list because this is the signature
                action for a research-oriented project. */}
            <button
              onClick={() => router.push(`/projects/${project.id}/marco-teorico`)}
              className="w-full group mb-3 rounded-xl border border-border/60 bg-card px-4 py-3 text-left hover:border-foreground/30 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-foreground/5 group-hover:bg-foreground/10 transition-colors">
                  <BookOpen className="h-4 w-4 text-foreground/80" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{t("generateMarcoTeorico")}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {t("generateMarcoTeoricoDesc")}
                  </div>
                </div>
                <ArrowLeft className="h-4 w-4 text-muted-foreground rotate-180 group-hover:text-foreground transition-colors shrink-0" />
              </div>
            </button>

            <ProjectChatsSection
              chats={projectChats}
              search={chatSearch}
              loading={chatsLoading}
              onSearchChange={setChatSearch}
              onOpen={openRecentChat}
              emptyText={t("startConversation")}
            />
          </div>

          {/* ── Right column: memory / docs / instructions / files ──────── */}
          <aside className="space-y-4 lg:sticky lg:top-6 self-start">
            <ProjectContextSection project={project} context={context} memoryCount={memories.length} />
            <MemorySection t={t} memories={memories} onDelete={handleDeleteMemory} />
            <DocumentsSection projectId={project.id} />
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

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        project={project}
        onChange={(shareId) => setProject(prev => prev ? { ...prev, shareId } : prev)}
      />

      <DeleteProjectDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        project={project}
        onConfirm={handleDeleteConfirmed}
      />
    </div>
  )
}

// ─── Right-panel cards ────────────────────────────────────────────────────

function ProjectContextSection({
  project,
  context,
  memoryCount,
}: {
  project: ProjectDetail
  context: ProjectContextManifest | null
  memoryCount: number
}) {
  const counts = context?.counts || {
    files: project.files.length,
    chats: project.chats.length,
    memories: memoryCount,
    documents: 0,
  }
  const coverage = context?.textCoverage
  const readyItems = [
    { label: "Instrucciones", ok: Boolean(project.instructions) },
    { label: "Conocimiento", ok: counts.files > 0 },
    { label: "Memoria", ok: counts.memories > 0 },
    { label: "Chats aislados", ok: counts.chats > 0 },
  ]

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.08] via-card to-card" data-testid="project-context-card">
      <div className="flex items-start justify-between px-4 pt-4">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Contexto de la empresa
          </h3>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            Este workspace mantiene archivos, instrucciones, memoria y conversaciones separados del chat general.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4 py-3">
        <ContextMetric icon={Database} label="Archivos" value={counts.files} />
        <ContextMetric icon={MessageSquare} label="Chats" value={counts.chats} />
        <ContextMetric icon={BookOpen} label="Docs" value={counts.documents} />
        <ContextMetric icon={Lock} label="Memoria" value={counts.memories} />
      </div>

      <div className="px-4 pb-4 space-y-2">
        {coverage && coverage.total > 0 && (
          <div className="rounded-lg bg-background/70 px-3 py-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Texto extraído para IA</span>
              <span>{coverage.extracted}/{coverage.total} · {coverage.percent}%</span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${coverage.percent}%` }} />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {readyItems.map(item => (
            <span
              key={item.label}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px]",
                item.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-border/70 bg-background/70 text-muted-foreground"
              )}
            >
              {item.ok ? "Activo" : "Pendiente"} · {item.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function ContextMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number
}) {
  return (
    <div className="rounded-lg bg-background/70 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function ProjectChatsSection({
  chats,
  search,
  loading,
  onSearchChange,
  onOpen,
  emptyText,
}: {
  chats: ProjectChatSummary[]
  search: string
  loading: boolean
  onSearchChange: (value: string) => void
  onOpen: (chatId: string) => void
  emptyText: string
}) {
  return (
    <section className="space-y-3" data-testid="project-chats-section">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60 px-1">
            Conversaciones de la empresa
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            La búsqueda queda aislada a esta empresa.
          </p>
        </div>
        {loading && <ThinkingIndicator size="sm" className="text-muted-foreground" />}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar solo en esta empresa..."
          className="h-10 pl-9"
          data-testid="project-chat-search"
        />
      </div>

      {chats.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 py-8 px-6 text-center text-sm text-muted-foreground">
          {search.trim() ? "No hay conversaciones de la empresa que coincidan." : emptyText}
        </div>
      ) : (
        <div className="space-y-2" data-testid="project-chat-results">
          {chats.map(c => (
            <button
              key={c.id}
              onClick={() => onOpen(c.id)}
              className="w-full text-left rounded-lg border border-border/60 px-4 py-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium truncate">{c.title}</div>
                <div className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {c.messageCount} msg
                </div>
              </div>
              {c.snippet && (
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {c.snippet.replace(/\s+/g, " ")}
                </div>
              )}
              <div className="text-[11px] text-muted-foreground mt-1.5">
                {new Date(c.updatedAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function MemorySection({
  t, memories, onDelete,
}: {
  t: ReturnType<typeof useTranslations>
  memories: ProjectMemoryItem[]
  onDelete: (id: string) => void
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-start justify-between px-4 pt-4">
        <h3 className="text-sm font-semibold">{t("memory")}</h3>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground rounded-full border border-border/60 px-2 py-0.5">
          <Lock className="h-3 w-3" />
          {t("onlyYou")}
        </span>
      </div>

      {memories.length === 0 ? (
        <p className="text-xs text-muted-foreground px-4 pb-4 pt-1 leading-relaxed">
          {t("memoryDesc")}
        </p>
      ) : (
        <ul className="px-2 pb-3 pt-1 space-y-0.5">
          {memories.map(m => (
            <li
              key={m.id}
              className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
            >
              <span className="mt-1.5 h-1 w-1 rounded-full bg-muted-foreground/60 shrink-0" />
              <p className="text-xs leading-snug flex-1 text-foreground/85">{m.fact}</p>
              <button
                onClick={() => onDelete(m.id)}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-all shrink-0"
                aria-label={t("forgetFact")}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
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
          {uploading ? <ThinkingIndicator size="sm" /> : <Plus className="h-4 w-4" />}
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
                className="h-6 w-6 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
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

// ─── Share dialog ─────────────────────────────────────────────────────────
//
// Read-only share link. Toggle via Enable/Disable; URL shows only
// when a share is active. Copy-to-clipboard preserves the same UX
// pattern used elsewhere in the app.

function ShareDialog({
  open, onOpenChange, project, onChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  project: ProjectDetail
  onChange: (shareId: string | null) => void
}) {
  const t = useTranslations("projects")
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const shareUrl = React.useMemo(() => {
    if (!project.shareId) return ""
    if (typeof window === "undefined") return ""
    return `${window.location.origin}/projects/share/${project.shareId}`
  }, [project.shareId])

  async function enable() {
    setBusy(true)
    try {
      const out = await projectsService.enableShare(project.id)
      onChange(out.shareId)
    } catch (err: any) {
      toast.error(err?.message || t("shareFailed"))
    } finally { setBusy(false) }
  }

  async function revoke() {
    setBusy(true)
    try {
      await projectsService.revokeShare(project.id)
      onChange(null)
    } catch (err: any) {
      toast.error(err?.message || t("shareFailed"))
    } finally { setBusy(false) }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t("copyFailed"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("shareTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t("shareDesc")}</p>

        {project.shareId ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input readOnly value={shareUrl} className="h-9 text-xs" onFocus={(e) => e.target.select()} />
              <Button
                variant="outline" size="sm" onClick={copy}
                className="h-9 gap-1.5 shrink-0"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <LinkIcon className="h-3.5 w-3.5" />}
                {copied ? t("copied") : t("copy")}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={revoke} disabled={busy}>
                {busy ? t("revoking") : t("revokeShare")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-dashed border-border/60 p-4">
            <p className="text-xs text-muted-foreground">{t("shareNotEnabled")}</p>
            <Button size="sm" onClick={enable} disabled={busy}>
              {busy ? t("enabling") : t("enableShare")}
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteProjectDialog({
  open,
  onOpenChange,
  project,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectDetail
  onConfirm: () => Promise<void>
}) {
  const t = useTranslations("projects")
  const [step, setStep] = React.useState<1 | 2>(1)
  const [typedName, setTypedName] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setStep(1)
      setTypedName("")
      setBusy(false)
    }
  }, [open])

  const canConfirm = typedName.trim() === project.name

  async function submit() {
    if (!canConfirm || busy) return
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message || t("deleteFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Mover proyecto a Papelera</DialogTitle>
          <DialogDescription>
            "{project.name}" seguirá perteneciendo solo a tu cuenta y podrás restaurarlo durante 30 días.
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-[#ff0000]/20 bg-[#ff0000]/5 p-4 text-sm">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#ff0000]" strokeWidth={2} />
                <div>
                  <p className="font-semibold">No se borra definitivamente.</p>
                  <p className="mt-1 text-muted-foreground">
                    El proyecto queda en Papelera, se revocan enlaces públicos y puedes restaurarlo desde Empresas.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="button" className="bg-[#ff0000] text-white hover:bg-[#d90000]" onClick={() => setStep(2)}>
                Continuar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm font-medium">
              Escribe el nombre exacto
              <Input
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={project.name}
                className="mt-2"
                autoFocus
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={busy}>
                Atrás
              </Button>
              <Button
                type="button"
                className="bg-[#ff0000] text-white hover:bg-[#d90000]"
                disabled={!canConfirm || busy}
                onClick={() => void submit()}
              >
                {busy ? "Moviendo..." : "Mover a Papelera"}
              </Button>
            </DialogFooter>
          </div>
        )}
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
