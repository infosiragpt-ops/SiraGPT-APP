"use client"

/**
 * /projects — index page.
 *
 * Shape mirrors the Claude Projects UX from the user's reference
 * screenshots:
 *   - Title row: "Código" + "+ Nuevo proyecto" CTA
 *   - Full-width search bar
 *   - Right-aligned sort dropdown ("Actividad reciente" / "Última
 *     edición" / "Fecha de creación")
 *   - Responsive grid of project cards (title bold, description
 *     muted 2-line clamp, "Actualizado hace X horas" footer)
 *   - Empty state with a CTA that opens the same create dialog
 *
 * Loading uses a skeleton grid rather than a full-page spinner so the
 * shell renders immediately and the list fills in.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  FolderKanban,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Star,
  Trash2,
  UploadCloud,
  Pencil,
} from "lucide-react"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import { es as dfEs, enUS as dfEn } from "date-fns/locale"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

import { getVisibleProjects, removeProjectFromList, upsertProjectList } from "@/lib/projects-logic"
import { projectsService, type Project, type ProjectSort } from "@/lib/projects-service"
import { CODEX_UPDATED_EVENT, codexIdForProject, upsertCodexProject } from "@/lib/codex-projects"
import { canOpenLocalDirectory, importLocalFolderAsWorkspace } from "@/lib/local-folder-workspace"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"

const SORTS: ProjectSort[] = ["activity", "edited", "created"]
const STORAGE_ACTIVE_FOLDER = "code-workspace:active-folder"
type ProjectCreateMode = "new" | "local"

export default function ProjectsPage() {
  const t = useTranslations("projects")
  const router = useRouter()

  const [projects, setProjects] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(true)
  const [search, setSearch] = React.useState("")
  const [sort, setSort] = React.useState<ProjectSort>("activity")
  const [editingProject, setEditingProject] = React.useState<Project | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [createMode, setCreateMode] = React.useState<ProjectCreateMode>("new")
  const [createName, setCreateName] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [importingLocal, setImportingLocal] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<Project | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  // Debounced search — we don't want to hit the API on every
  // keystroke. 220ms is fast enough to feel responsive without being
  // wasteful on a user typing fluently.
  const [debouncedSearch, setDebouncedSearch] = React.useState(search)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 220)
    return () => clearTimeout(timer)
  }, [search])

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const rows = await projectsService.list({ search: debouncedSearch, sort })
      setProjects(rows)
    } catch (err: any) {
      toast.error(err?.message || t("listFailed"))
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, sort, t])

  React.useEffect(() => { load() }, [load])

  const dateLocale = React.useMemo(() => {
    // next-intl doesn't expose the active locale here directly; sniff
    // from the document if we can, else fall back to English. Good
    // enough — projects page only uses this for relative dates.
    if (typeof document !== "undefined" && document.documentElement.lang?.startsWith("es")) return dfEs
    return dfEn
  }, [])

  const visibleProjects = React.useMemo(
    () => getVisibleProjects(projects, debouncedSearch, sort),
    [projects, debouncedSearch, sort]
  )

  const openCodeProject = React.useCallback((project: Pick<Project, "id" | "name">) => {
    const workspaceId = codexIdForProject(project.id)
    upsertCodexProject({ id: workspaceId, name: project.name, kind: "project" })
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(
          STORAGE_ACTIVE_FOLDER,
          JSON.stringify({ id: project.id, name: project.name }),
        )
      } catch {
        /* fail soft */
      }
      window.dispatchEvent(new CustomEvent(CODEX_UPDATED_EVENT))
    }
    router.push(`/code?folder=${encodeURIComponent(project.id)}`)
  }, [router])

  function openCreate(mode: ProjectCreateMode = "new") {
    setCreateMode(mode)
    setCreateName("")
    setCreating(false)
    setImportingLocal(false)
    setCreateDialogOpen(true)
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault()
    const cleanName = normalizeChatInput(createName).value.trim()
    if (!cleanName || creating) return
    setCreating(true)
    try {
      const project = await projectsService.create({
        name: cleanName,
      })
      setProjects(prev => upsertProjectList(prev, project, sort))
      toast.success(`Proyecto "${project.name}" creado en Código y Apps web`)
      setCreateDialogOpen(false)
      openCodeProject(project)
    } catch (err: any) {
      toast.error(err?.message || t("createFailed"))
      setCreating(false)
    }
  }

  async function handleImportLocalProject() {
    if (importingLocal) return
    if (!canOpenLocalDirectory()) {
      toast.error("Tu navegador no permite seleccionar carpetas locales. Usa Chrome o Edge.")
      return
    }
    setImportingLocal(true)
    try {
      const imported = await importLocalFolderAsWorkspace()
      toast.success(`Proyecto local "${imported.name}" abierto en Código`)
      setCreateDialogOpen(false)
      router.push(`/code?local=${encodeURIComponent(imported.codexId)}`)
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast.error(err?.message || "No se pudo importar la carpeta local")
      }
    } finally {
      setImportingLocal(false)
    }
  }

  async function handleToggleStar(project: Project) {
    const next = !project.isStarred
    setProjects(prev => upsertProjectList(prev, { ...project, isStarred: next }, sort))
    try {
      const updated = await projectsService.update(project.id, { isStarred: next })
      setProjects(prev => upsertProjectList(prev, updated, sort))
    } catch (err: any) {
      setProjects(prev => upsertProjectList(prev, { ...project, isStarred: !next }, sort))
      toast.error(err?.message || t("updateFailed"))
    }
  }

  function handleUpdated(project: Project) {
    setProjects(prev => upsertProjectList(prev, project, sort))
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await projectsService.remove(deleteTarget.id)
      setProjects(prev => removeProjectFromList(prev, deleteTarget.id))
      toast.success(t("deleted"))
      setDeleteTarget(null)
    } catch (err: any) {
      toast.error(err?.message || t("deleteFailed"))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile header with sidebar toggle. The main page chrome
          matches the gpts page so the app feels internally consistent. */}
      <div className="lg:hidden sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-2">
        <SidebarTrigger />
      </div>

      <div className="mx-auto max-w-5xl px-4 sm:px-6 md:px-8 py-8 md:py-12">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-serif tracking-tight" data-testid="projects-page-title">{t("title")}</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => openCreate("local")} className="gap-1.5">
              <UploadCloud className="h-4 w-4" />
              Importar código
            </Button>
            <Button onClick={() => openCreate("new")} className="gap-1.5">
              <Plus className="h-4 w-4" />
              {t("newProject")}
            </Button>
          </div>
        </header>

        <div className="mb-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-11 pl-10"
              data-testid="projects-search-input"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mb-4 text-sm">
          <span className="text-muted-foreground">{t("sortBy")}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-8" data-testid="projects-sort-trigger">
                {t(`sort.${sort}` as any)}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              {SORTS.map(s => (
                <DropdownMenuItem key={s} onClick={() => setSort(s)} className="justify-between">
                  {t(`sort.${s}` as any)}
                  {sort === s && <Check className="h-4 w-4 ml-2" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {loading ? (
          <ProjectsGridSkeleton />
        ) : visibleProjects.length === 0 ? (
          <EmptyState search={debouncedSearch} onCreate={openCreate} t={t} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="projects-grid">
            {visibleProjects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                dateLocale={dateLocale}
                onOpen={() => openCodeProject(p)}
                onToggleStar={() => handleToggleStar(p)}
                onEdit={() => setEditingProject(p)}
                onDelete={() => setDeleteTarget(p)}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      <CreateCodeProjectDialog
        open={createDialogOpen}
        name={createName}
        mode={createMode}
        creating={creating}
        importingLocal={importingLocal}
        onOpenChange={(open) => {
          if (!creating && !importingLocal) setCreateDialogOpen(open)
        }}
        onModeChange={setCreateMode}
        onNameChange={setCreateName}
        onSubmit={handleCreateProject}
        onImportLocal={handleImportLocalProject}
        t={t}
      />
      <EditProjectDialog
        project={editingProject}
        onOpenChange={(open) => { if (!open) setEditingProject(null) }}
        onSaved={handleUpdated}
        t={t}
      />
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteProject")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? t("deleteConfirm", { name: deleteTarget.name }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleConfirmDelete()
              }}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-500"
              disabled={deleting}
            >
              {t("deleteProject")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function CreateCodeProjectDialog({
  open,
  name,
  mode,
  creating,
  importingLocal,
  onOpenChange,
  onModeChange,
  onNameChange,
  onSubmit,
  onImportLocal,
  t,
}: {
  open: boolean
  name: string
  mode: ProjectCreateMode
  creating: boolean
  importingLocal: boolean
  onOpenChange: (open: boolean) => void
  onModeChange: (mode: ProjectCreateMode) => void
  onNameChange: (name: string) => void
  onSubmit: (event: React.FormEvent) => void
  onImportLocal: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const cleanName = normalizeChatInput(name).value.trim()
  const canSubmit = cleanName.length > 0 && !creating && !importingLocal
  const busy = creating || importingLocal
  const [localSupported, setLocalSupported] = React.useState(true)

  React.useEffect(() => {
    setLocalSupported(canOpenLocalDirectory())
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[720px]">
        <DialogHeader>
          <div className="border-b border-border/60 px-6 pb-4 pt-5">
            <DialogTitle className="text-2xl font-serif tracking-tight">
              Crear proyecto de código
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              Elige cómo quieres empezar. Puedes importar una carpeta local o crear un software nuevo.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="space-y-5 px-6 pb-6 pt-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <ProjectStartOption
              selected={mode === "local"}
              icon={<UploadCloud className="h-5 w-5" />}
              title="Proyecto local"
              description="Importa código desde tu computadora."
              meta="Carpeta existente"
              onClick={() => onModeChange("local")}
              disabled={busy}
            />
            <ProjectStartOption
              selected={mode === "new"}
              icon={<Code2 className="h-5 w-5" />}
              title="Proyecto nuevo"
              description="Crea un workspace limpio para construir desde cero."
              meta="Software nuevo"
              onClick={() => onModeChange("new")}
              disabled={busy}
            />
          </div>

          {mode === "local" ? (
            <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="flex gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background text-foreground shadow-sm ring-1 ring-border/70">
                  <FolderOpen className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold tracking-tight">Selecciona tu carpeta de código</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Se abrirá en Código como proyecto local y podrás seguir editándolo desde el workspace.
                  </p>
                  {!localSupported && (
                    <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      Para importar carpetas locales usa Chrome o Edge.
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter className="mt-5 gap-2 sm:gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  {t("cancel")}
                </Button>
                <Button
                  type="button"
                  onClick={onImportLocal}
                  disabled={busy || !localSupported}
                  aria-busy={importingLocal}
                  className="gap-2"
                >
                  {importingLocal ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                  {importingLocal ? "Importando..." : "Seleccionar carpeta"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="space-y-1.5">
                <Label htmlFor="create-code-project-name" className="text-sm">
                  Nombre del proyecto
                </Label>
                <Input
                  id="create-code-project-name"
                  autoFocus
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="Ej. App de inventario"
                  maxLength={120}
                  disabled={busy}
                  className="h-11 bg-background"
                />
                <p className="min-h-[1rem] text-xs text-muted-foreground" aria-live="polite">
                  {creating ? "Creando proyecto..." : "Se guardará en Código y aparecerá en Apps web."}
                </p>
              </div>

              <DialogFooter className="mt-5 gap-2 sm:gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  {t("cancel")}
                </Button>
                <Button type="submit" disabled={!canSubmit} aria-busy={creating} className="gap-2">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {creating ? t("creating") : "Crear y abrir"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProjectStartOption({
  selected,
  icon,
  title,
  description,
  meta,
  disabled,
  onClick,
}: {
  selected: boolean
  icon: React.ReactNode
  title: string
  description: string
  meta: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "group flex min-h-[124px] flex-col rounded-xl border p-4 text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        selected
          ? "border-foreground bg-background shadow-sm"
          : "border-border/70 bg-background/60 hover:border-foreground/40 hover:bg-background",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg border transition",
            selected ? "border-foreground bg-foreground text-background" : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
            selected ? "border-foreground bg-foreground text-background" : "border-border text-transparent",
          )}
        >
          <Check className="h-3.5 w-3.5" />
        </span>
      </span>
      <span className="mt-4 text-sm font-semibold tracking-tight">{title}</span>
      <span className="mt-1 text-sm leading-5 text-muted-foreground">{description}</span>
      <span className="mt-auto pt-3 text-xs font-medium text-muted-foreground">{meta}</span>
    </button>
  )
}

function ProjectCard({
  project, dateLocale, onOpen, onToggleStar, onEdit, onDelete, t,
}: {
  project: Project
  dateLocale: Locale
  onOpen: () => void
  onToggleStar: () => void
  onEdit: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const rel = React.useMemo(() => {
    try {
      return formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true, locale: dateLocale })
    } catch {
      return ""
    }
  }, [project.updatedAt, dateLocale])

  return (
    <Card
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Abrir proyecto ${project.name}`}
      data-testid={`project-card-${project.id}`}
      className={cn(
        "group/project relative cursor-pointer transition-shadow duration-150 hover:shadow-md",
        "border-border/60"
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Más acciones"
            className="absolute right-3 top-3 z-10 h-8 w-8 rounded-full opacity-100 transition-opacity md:opacity-0 md:group-hover/project:opacity-100 md:group-focus-within/project:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={onToggleStar}>
            <Star className={cn("mr-2 h-4 w-4", project.isStarred && "fill-yellow-400 text-yellow-500")} />
            {project.isStarred ? "Quitar estrella" : "Marcar con estrella"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Editar detalles
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="text-red-600 focus:text-red-600">
            <Trash2 className="mr-2 h-4 w-4" />
            {t("deleteProject")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CardHeader className="pb-3 pr-12">
        <CardTitle className="text-base font-semibold tracking-tight line-clamp-1">
          {project.name}
        </CardTitle>
        {project.description && (
          <CardDescription className="line-clamp-2 text-sm">
            {project.description}
          </CardDescription>
        )}
      </CardHeader>
      <CardFooter className="pt-0 text-xs text-muted-foreground">
        {t("updatedRel", { rel })}
      </CardFooter>
    </Card>
  )
}

function EditProjectDialog({
  project,
  onOpenChange,
  onSaved,
  t,
}: {
  project: Project | null
  onOpenChange: (open: boolean) => void
  onSaved: (project: Project) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (project) {
      setName(project.name || "")
      setDescription(project.description || "")
      setSubmitting(false)
    } else {
      setName("")
      setDescription("")
      setSubmitting(false)
    }
  }, [project])

  const open = !!project
  const canSubmit = name.trim().length > 0 && !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!project || !canSubmit) return
    const cleanName = normalizeChatInput(name).value.trim()
    const normalizedDesc = normalizeChatInput(description)
    if (shouldWarnUser(normalizedDesc)) {
      toast.error(
        `La descripción supera el límite (${normalizedDesc.originalLength.toLocaleString()} caracteres). Se recortó.`,
        { duration: 4500 },
      )
    }
    const cleanDesc = normalizedDesc.value.trim()
    setSubmitting(true)
    try {
      const updated = await projectsService.update(project.id, {
        name: cleanName,
        description: cleanDesc || null,
      })
      onSaved(updated)
      toast.success("Proyecto actualizado")
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message || t("updateFailed"))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="text-2xl font-serif tracking-tight">
            Editar detalles
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="edit-project-name" className="text-sm">
              {t("whatWorkingOn")}
            </Label>
            <Input
              id="edit-project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              maxLength={120}
              disabled={submitting}
              className="h-11"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-project-description" className="text-sm">
              {t("whatTryingAchieve")}
            </Label>
            <Textarea
              id="edit-project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={4}
              maxLength={4000}
              disabled={submitting}
              className="resize-none"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProjectsGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-32 rounded-lg border border-border/60 bg-muted/20 animate-pulse" />
      ))}
    </div>
  )
}

function EmptyState({
  search, onCreate, t,
}: {
  search: string
  onCreate: () => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <div className="mx-auto max-w-md text-center py-16">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <FolderKanban className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold tracking-tight mb-1">
        {search ? t("noMatchTitle") : t("emptyTitle")}
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        {search ? t("noMatchDesc") : t("emptyDesc")}
      </p>
      {!search && (
        <Button onClick={onCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t("newProject")}
        </Button>
      )}
    </div>
  )
}

// Helper type for date-fns so we don't have to `import type { Locale }`
// separately — keeping the file self-contained.
type Locale = typeof dfEn
