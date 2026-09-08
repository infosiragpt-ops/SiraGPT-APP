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
 *   4. Router.push to /agentes/:id. The chat context picks up
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
  MoreHorizontal, Star, Plus, Send,
  FileText, Trash2, Lock, Paperclip, Pencil,
  Share2, Link as LinkIcon, Check, X, BookOpen,
  Search, MessageSquare, ShieldCheck,
  CalendarDays, Upload, Mic,
} from "lucide-react"
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
  type ProjectDetail,
  type ProjectMemoryItem,
} from "@/lib/projects-service"
import { MAX_SIMULTANEOUS_DOCUMENTS } from "@/lib/document-batch-limits"
import {
  readProjectScheduledTasks,
  writeProjectScheduledTasks,
  type ProjectScheduledTask,
} from "@/lib/project-scheduled-tasks"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

// ─── Page ─────────────────────────────────────────────────────────────────

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const t = useTranslations("projects")

  const [project, setProject] = React.useState<ProjectDetail | null>(null)
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
  const [scheduledOpen, setScheduledOpen] = React.useState(false)
  const [textContentOpen, setTextContentOpen] = React.useState(false)
  const [composerMode, setComposerMode] = React.useState<"chat" | "cowork">("chat")
  const [scheduledTasks, setScheduledTasks] = React.useState<ProjectScheduledTask[]>([])
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
      const [p, mem] = await Promise.all([
        projectsService.get(id),
        projectsService.listMemory(id).catch(() => [] as ProjectMemoryItem[]),
      ])
      setProject(p)
      setMemories(mem)
    } catch (err: any) {
      toast.error(err?.message || t("detailLoadFailed"))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => { reload() }, [reload])

  React.useEffect(() => {
    if (!id) return
    setScheduledTasks(readProjectScheduledTasks(id))
  }, [id])

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
    toast.success("Empresa movida a Papelera por 30 días.")
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
      router.push(`/agentes?id=${chat.id}`)
    } catch (err: any) {
      toast.error(err?.message || t("launchFailed"))
      setLaunching(false)
    }
  }

  function openRecentChat(chatId: string) {
    router.push(`/agentes?id=${chatId}`)
  }

  async function handleComposerFiles(files: FileList | null) {
    if (!project || !files || files.length === 0) return
    setComposerUploading(true)
    try {
      const uploaded = await projectsService.uploadFiles(
        Array.from(files).slice(0, MAX_SIMULTANEOUS_DOCUMENTS),
      )
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
        <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => router.push("/projects")}
            className="hover:text-foreground"
          >
            {t("title")}
          </button>
          <span aria-hidden="true">/</span>
          <span className="truncate text-foreground">{project.name}</span>
        </nav>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <header className="mb-8 flex items-start justify-between gap-3">
              <h1 className="font-serif text-4xl tracking-tight text-foreground">{project.name}</h1>
              <div className="flex shrink-0 items-center gap-1">
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
                    <DropdownMenuItem onClick={() => router.push(`/projects/${project.id}/marco-teorico`)}>
                      <BookOpen className="mr-2 h-4 w-4" />
                      {t("generateMarcoTeorico")}
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

            <form onSubmit={handleLaunch} className="mb-10">
              <div className="rounded-2xl border border-border/70 bg-background px-4 py-3 shadow-sm">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleLaunch() }
                  }}
                  placeholder={t("composerPlaceholder")}
                  rows={2}
                  disabled={launching}
                  className="min-h-[44px] resize-none border-0 bg-transparent px-0 py-1 text-[15px] focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                <div className="mt-1 flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground"
                    disabled={composerUploading}
                    onClick={() => composerFileRef.current?.click()}
                    aria-label={t("attachFile")}
                  >
                    {composerUploading ? <ThinkingIndicator size="sm" /> : <Plus className="h-4 w-4" />}
                  </Button>
                  <input
                    ref={composerFileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => handleComposerFiles(e.target.files)}
                  />
                  <button
                    type="button"
                    onClick={() => setComposerMode("chat")}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium",
                      composerMode === "chat" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    {t("chatMode")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerMode("cowork")}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium",
                      composerMode === "cowork" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    {t("cowork")}
                  </button>
                  <div className="ml-auto flex items-center gap-1 text-muted-foreground">
                    <Mic className="h-4 w-4" />
                    {draft.trim() ? (
                      <Button type="submit" disabled={launching} size="sm" className="h-8 gap-1.5">
                        {launching ? <ThinkingIndicator size="sm" /> : <Send className="h-3.5 w-3.5" />}
                        {t("send")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </form>

            {projectChats.length === 0 && !chatSearch.trim() ? (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <MessageSquare className="mb-3 h-8 w-8 text-muted-foreground/50" />
                <p className="max-w-md text-sm text-muted-foreground">{t("knowledgeHint")}</p>
              </div>
            ) : (
              <ProjectChatsSection
                chats={projectChats}
                search={chatSearch}
                loading={chatsLoading}
                onSearchChange={setChatSearch}
                onOpen={openRecentChat}
                emptyText={t("startConversation")}
              />
            )}
          </div>

          <aside className="self-start lg:sticky lg:top-6">
            <ProjectKnowledgeRail
              t={t}
              project={project}
              memories={memories}
              scheduledTasks={scheduledTasks}
              onEditInstructions={() => setInstructionsOpen(true)}
              onAddFiles={(files) => void handleComposerFiles(files)}
              onAddText={() => setTextContentOpen(true)}
              onSchedule={() => setScheduledOpen(true)}
              onDeleteMemory={handleDeleteMemory}
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
      <ScheduledTaskDialog
        open={scheduledOpen}
        onOpenChange={setScheduledOpen}
        projectId={project.id}
        onSaved={(tasks) => setScheduledTasks(tasks)}
      />
      <TextContentDialog
        open={textContentOpen}
        onOpenChange={setTextContentOpen}
        onSubmit={async (text) => {
          const file = new File([text], "contexto.txt", { type: "text/plain" })
          const list = { 0: file, length: 1, item: () => file } as unknown as FileList
          await handleComposerFiles(list)
        }}
      />
    </div>
  )
}

// ─── Right-panel cards ────────────────────────────────────────────────────

function ProjectKnowledgeRail({
  t,
  project,
  memories,
  scheduledTasks,
  onEditInstructions,
  onAddFiles,
  onAddText,
  onSchedule,
  onDeleteMemory,
}: {
  t: ReturnType<typeof useTranslations>
  project: ProjectDetail
  memories: ProjectMemoryItem[]
  scheduledTasks: ProjectScheduledTask[]
  onEditInstructions: () => void
  onAddFiles: (files: FileList | null) => void
  onAddText: () => void
  onSchedule: () => void
  onDeleteMemory: (id: string) => void
  onChange: () => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card" data-testid="project-knowledge-rail">
      <section className="px-4 py-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("instructions")}</h3>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEditInstructions} aria-label={t("editInstructions")}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {project.instructions ? project.instructions : t("instructionsDesc")}
        </p>
      </section>

      <div className="h-px bg-border/70" />

      <section className="px-4 py-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("memory")}</h3>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" />
            {t("onlyYou")}
          </span>
        </div>
        {memories.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{t("memoryDesc")}</p>
        ) : (
          <ul className="space-y-1 pt-1">
            {memories.slice(0, 4).map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-xs text-foreground/85">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
                <span className="flex-1 leading-snug">{item.fact}</span>
                <button type="button" onClick={() => onDeleteMemory(item.id)} aria-label={t("forgetFact")}>
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="h-px bg-border/70" />

      <section className="px-4 py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("context")}</h3>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t("attachFile")}>
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                {t("uploadFromDevice")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onAddText}>
                <FileText className="mr-2 h-4 w-4" />
                {t("addTextContent")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { window.location.href = "/conexiones" }}>
                GitHub
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { window.location.href = "/conexiones" }}>
                Drive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => onAddFiles(event.target.files)}
          />
        </div>
        {project.files.length === 0 ? (
          <div className="rounded-xl bg-muted/40 px-4 py-8 text-center">
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-background">
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("filesEmpty")}</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {project.files.map((file) => (
              <li key={file.id} className="flex items-center gap-2 text-xs">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{file.originalName}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="h-px bg-border/70" />

      <section className="px-4 py-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("scheduled")}</h3>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onSchedule} aria-label={t("scheduledCreate")}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        {scheduledTasks.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{t("scheduledDesc")}</p>
        ) : (
          <ul className="space-y-1 pt-1">
            {scheduledTasks.map((task) => (
              <li key={task.id} className="flex items-center gap-2 text-xs">
                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{task.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
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
          <DialogTitle>{t("instructionsSetupTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("instructionsSetupDesc")}</p>
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

function TextContentDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (text: string) => Promise<void>
}) {
  const t = useTranslations("projects")
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setText("")
      setBusy(false)
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] rounded-2xl">
        <DialogHeader>
          <DialogTitle>{t("addTextTitle")}</DialogTitle>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("addTextPlaceholder")}
          rows={8}
          className="resize-none"
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={!text.trim() || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onSubmit(text.trim())
                onOpenChange(false)
              } catch (err: any) {
                toast.error(err?.message || t("uploadFailed"))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ScheduledTaskDialog({
  open,
  onOpenChange,
  projectId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  onSaved: (tasks: ProjectScheduledTask[]) => void
}) {
  const t = useTranslations("projects")
  const [name, setName] = React.useState("")
  const [instructions, setInstructions] = React.useState("")
  const [frequency, setFrequency] = React.useState<"manual" | "daily" | "weekly">("manual")
  const [requireComputer, setRequireComputer] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setName("")
      setInstructions("")
      setFrequency("manual")
      setRequireComputer(false)
    }
  }, [open])

  const canSave = name.trim().length > 0 && instructions.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] rounded-2xl">
        <DialogHeader>
          <DialogTitle>{t("scheduledCreate")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("scheduledName")} *</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("scheduledInstructions")} *</label>
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={5}
              className="resize-none"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-24 text-sm">{t("scheduledFrequency")}</span>
            <select
              value={frequency}
              onChange={(event) => setFrequency(event.target.value as typeof frequency)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="manual">{t("scheduledManual")}</option>
              <option value="daily">{t("scheduledDaily")}</option>
              <option value="weekly">{t("scheduledWeekly")}</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-24 text-sm">{t("scheduledPermissions")}</span>
            <span className="rounded-md border border-input px-3 py-1.5 text-sm">{t("scheduledApproveManual")}</span>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={requireComputer}
              onChange={(event) => setRequireComputer(event.target.checked)}
            />
            <span>
              <span className="font-medium">{t("scheduledRequireComputer")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t("scheduledRequireComputerHint")}</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => {
              const next = writeProjectScheduledTasks(projectId, [
                ...readProjectScheduledTasks(projectId),
                {
                  id: `task_${Date.now()}`,
                  name: name.trim(),
                  instructions: instructions.trim(),
                  frequency,
                  approval: "manual",
                  requireComputer,
                  createdAt: new Date().toISOString(),
                },
              ])
              onSaved(next)
              onOpenChange(false)
              toast.success("Tarea programada")
            }}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
