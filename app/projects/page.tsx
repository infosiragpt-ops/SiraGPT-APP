"use client"

/**
 * /projects — APPS project gallery.
 *
 * This surface intentionally mirrors the APPS/projects reference: open canvas,
 * compact filters, grid/list controls, and large app preview cards.
 */

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  CalendarClock,
  ChevronDown,
  Check,
  Database,
  Folder,
  Globe2,
  Grid3X3,
  LayoutGrid,
  List,
  MoreVertical,
  Plus,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import { es as dfEs, enUS as dfEn } from "date-fns/locale"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { projectsService, type Project } from "@/lib/projects-service"
import {
  daysUntilProjectDelete,
  getProjectVisualIdentity,
  type ProjectVisualIdentity,
} from "@/lib/projects-logic"
import styles from "./projects-page.module.css"

type StatusFilter = "any" | "active" | "draft"
type ArtifactFilter = "any" | "webapp" | "mobileapp" | "dashboard"
type ViewMode = "grid" | "list"
type ProjectScope = "active" | "trash"

interface AppProject {
  id: string
  name: string
  description: string | null
  timeLabel: string
  status: "active" | "draft"
  artifactType: "webapp" | "mobileapp" | "dashboard"
  href: string
  deletedAt: string | null
  deleteAfter: string | null
  visual: ProjectVisualIdentity
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "any", label: "Cualquier estado" },
  { value: "active", label: "Activo" },
  { value: "draft", label: "Borrador" },
]

const ARTIFACT_OPTIONS: Array<{ value: ArtifactFilter; label: string }> = [
  { value: "any", label: "Cualquier tipo" },
  { value: "webapp", label: "Web app" },
  { value: "mobileapp", label: "Mobile app" },
  { value: "dashboard", label: "Dashboard" },
]

export default function ProjectsPage() {
  const t = useTranslations("projects")
  const router = useRouter()

  const [projects, setProjects] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(true)
  const [search, setSearch] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("any")
  const [artifactFilter, setArtifactFilter] = React.useState<ArtifactFilter>("any")
  const [viewMode, setViewMode] = React.useState<ViewMode>("grid")
  const [projectScope, setProjectScope] = React.useState<ProjectScope>("active")
  const [openingProjectId, setOpeningProjectId] = React.useState<string | null>(null)
  const [restoringProjectId, setRestoringProjectId] = React.useState<string | null>(null)
  const [deleteProject, setDeleteProject] = React.useState<AppProject | null>(null)

  const dateLocale = React.useMemo(() => {
    if (typeof document !== "undefined" && document.documentElement.lang?.startsWith("es")) return dfEs
    return dfEn
  }, [])

  const loadProjects = React.useCallback(() => {
    let cancelled = false
    setLoading(true)
    projectsService
      .list({ type: "webapp", sort: "activity", trash: projectScope === "trash" })
      .then((rows) => {
        if (!cancelled) setProjects(rows)
      })
      .catch((err: any) => {
        if (!cancelled) {
          setProjects([])
          toast.error(err?.message || t("listFailed"))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectScope, t])

  React.useEffect(() => loadProjects(), [loadProjects])

  const appProjects = React.useMemo(() => {
    const rows = projects.map((project) => toAppProject(project, dateLocale))
    return rows
  }, [projects, dateLocale])

  const visibleProjects = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return appProjects.filter((project) => {
      if (projectScope === "active" && statusFilter !== "any" && project.status !== statusFilter) return false
      if (artifactFilter !== "any" && project.artifactType !== artifactFilter) return false
      if (!q) return true
      return `${project.name} ${project.description || ""}`.toLowerCase().includes(q)
    })
  }, [appProjects, artifactFilter, projectScope, search, statusFilter])

  const openAppProject = React.useCallback(
    async (project: AppProject) => {
      if (openingProjectId) return
      if (project.deletedAt) {
        toast.info("Restaura la empresa antes de abrir su workspace.")
        return
      }
      setOpeningProjectId(project.id)
      try {
        router.push(project.href)
      } catch (err: any) {
        toast.error(err?.message || "No se pudo abrir la app en APPS")
      } finally {
        setOpeningProjectId(null)
      }
    },
    [openingProjectId, router],
  )

  const requestDeleteProject = React.useCallback((project: AppProject) => {
    if (project.deletedAt) return
    setDeleteProject(project)
  }, [])

  const moveProjectToTrash = React.useCallback(async (project: AppProject) => {
    await projectsService.remove(project.id)
    setProjects((prev) => prev.filter((row) => row.id !== project.id))
    toast.success(`"${project.name}" se movió a Papelera por 30 días.`)
  }, [])

  const restoreProject = React.useCallback(async (project: AppProject) => {
    if (restoringProjectId) return
    setRestoringProjectId(project.id)
    try {
      await projectsService.restore(project.id)
      setProjects((prev) => prev.filter((row) => row.id !== project.id))
      toast.success(`"${project.name}" restaurada.`)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo restaurar la empresa")
    } finally {
      setRestoringProjectId(null)
    }
  }, [restoringProjectId])

  const createFullStackProject = React.useCallback(async () => {
    if (openingProjectId) return
    setOpeningProjectId("new-fullstack")
    try {
      const target = await projectsService.create({
        name: "Nueva app full-stack",
        description: "Frontend, backend y base de datos creados desde una sola instrucción.",
        type: "webapp",
        hostingProvider: "sira-cloud",
      })
      setProjects((prev) => [target, ...prev.filter((row) => row.id !== target.id)])
      router.push(codeWorkspaceHref(target.id))
    } catch (err: any) {
      toast.error(err?.message || "No se pudo crear la app full-stack")
    } finally {
      setOpeningProjectId(null)
    }
  }, [openingProjectId, router])

  return (
    <div className={styles.page}>
      <div className={styles.mobileHeader}>
        <SidebarTrigger />
      </div>

      <main className={styles.main}>
        <header className={styles.header}>
          <LayoutGrid className={styles.titleIcon} strokeWidth={2.25} />
          <h1 className={styles.title} data-testid="projects-page-title">
            {t("title")}
          </h1>
        </header>

        <section className={styles.toolbar}>
          <div className={styles.filters}>
            <label className={styles.search} role="search">
              <span className="sr-only">{t("searchPlaceholder")}</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar"
                className={styles.searchInput}
                data-testid="projects-search-input"
              />
              <Search className={styles.searchIcon} strokeWidth={1.8} />
            </label>

            <FilterDropdown
              value={statusFilter}
              options={STATUS_OPTIONS}
              onChange={setStatusFilter}
            />
            <FilterDropdown
              value={artifactFilter}
              options={ARTIFACT_OPTIONS}
              onChange={setArtifactFilter}
            />
          </div>

          <div className={styles.viewControls}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className={styles.scopeButton}
                >
                  <Folder strokeWidth={1.8} />
                  {projectScope === "trash" ? "Papelera" : t("allProjects")}
                  <ChevronDown strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuItem
                  className="justify-between"
                  onClick={() => setProjectScope("active")}
                >
                  {t("allProjects")}
                  {projectScope === "active" && <Check className="h-4 w-4" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="justify-between"
                  onClick={() => setProjectScope("trash")}
                >
                  Papelera · 30 días
                  {projectScope === "trash" && <Check className="h-4 w-4" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <ViewButton
              active={viewMode === "grid"}
              label="Vista de grilla"
              onClick={() => setViewMode("grid")}
            >
              <Grid3X3 className="h-7 w-7" strokeWidth={1.8} />
            </ViewButton>
            <ViewButton
              active={viewMode === "list"}
              label="Vista de lista"
              onClick={() => setViewMode("list")}
            >
              <List className="h-7 w-7" strokeWidth={1.8} />
            </ViewButton>
          </div>
        </section>

        <section className={styles.builderStrip} aria-label="Constructor full-stack de APPS">
          <div className={styles.builderCopy}>
            <div className={styles.builderIcon} aria-hidden="true">
              <Server strokeWidth={2} />
            </div>
            <div>
              <h2 className={styles.builderTitle}>Crear software profesional</h2>
            </div>
          </div>
          <div className={styles.builderLayers} aria-label="Capas incluidas">
            <span>Frontend</span>
            <span>Backend</span>
            <span><Database strokeWidth={1.8} /> Base de datos</span>
          </div>
          <Button
            type="button"
            className={styles.builderButton}
            disabled={openingProjectId === "new-fullstack"}
            onClick={() => void createFullStackProject()}
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            {openingProjectId === "new-fullstack" ? "Creando..." : "Nuevo software"}
          </Button>
        </section>

        {loading ? (
          <ProjectsSkeleton />
        ) : visibleProjects.length === 0 ? (
          <NoResults label={projectScope === "trash" ? "No hay empresas en papelera." : t("noMatchTitle")} />
        ) : viewMode === "grid" ? (
          <div className={styles.grid} data-testid="projects-grid">
            {visibleProjects.map((project) => (
              <AppProjectCard
                key={project.id}
                project={project}
                opening={openingProjectId === project.id}
                restoring={restoringProjectId === project.id}
                onOpen={() => void openAppProject(project)}
                onDelete={() => requestDeleteProject(project)}
                onRestore={() => void restoreProject(project)}
              />
            ))}
          </div>
        ) : (
          <div className="max-w-5xl space-y-3" data-testid="projects-list">
            {visibleProjects.map((project) => (
              <AppProjectRow
                key={project.id}
                project={project}
                onOpen={() => void openAppProject(project)}
                onDelete={() => requestDeleteProject(project)}
                onRestore={() => void restoreProject(project)}
                restoring={restoringProjectId === project.id}
              />
            ))}
          </div>
        )}

        <DeleteProjectDialog
          project={deleteProject}
          onOpenChange={(open) => {
            if (!open) setDeleteProject(null)
          }}
          onConfirm={moveProjectToTrash}
        />
      </main>
    </div>
  )
}

function FilterDropdown<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const selected = options.find((option) => option.value === value) || options[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={styles.filterTrigger}
        >
          <span>{selected.label}</span>
          <ChevronDown strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onChange(option.value)}
            className="justify-between"
          >
            {option.label}
            {option.value === value && <Check className="h-4 w-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ViewButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        styles.viewButton,
        active ? styles.viewButtonActive : styles.viewButtonInactive
      )}
    >
      {children}
    </button>
  )
}

function AppProjectCard({
  project,
  opening,
  restoring,
  onOpen,
  onDelete,
  onRestore,
}: {
  project: AppProject
  opening: boolean
  restoring: boolean
  onOpen: () => void
  onDelete: () => void
  onRestore: () => void
}) {
  const inTrash = Boolean(project.deletedAt)
  return (
    <article
      data-testid={`project-card-${project.id}`}
      className={styles.card}
    >
      <button
        type="button"
        aria-busy={opening || restoring}
        aria-label={inTrash ? `Restaurar empresa ${project.name}` : `Abrir proyecto ${project.name}`}
        disabled={opening || restoring}
        onClick={inTrash ? onRestore : onOpen}
        className={styles.previewButton}
      >
        <AppPreview project={project} />
      </button>
      <div className={styles.cardMeta}>
        <div className={styles.cardTitleRow}>
          <h2 className={styles.cardTitle}>{project.name}</h2>
          <ProjectActions
            project={project}
            onOpen={onOpen}
            onDelete={onDelete}
            onRestore={onRestore}
            busy={opening || restoring}
          />
        </div>
        <div className={styles.cardTime}>
          {inTrash ? <CalendarClock strokeWidth={2} /> : <Globe2 strokeWidth={2} />}
          <span aria-hidden="true">·</span>
          <span>{statusLabel(project, opening, restoring)}</span>
        </div>
      </div>
    </article>
  )
}

function AppProjectRow({
  project,
  onOpen,
  onDelete,
  onRestore,
  restoring,
}: {
  project: AppProject
  onOpen: () => void
  onDelete: () => void
  onRestore: () => void
  restoring: boolean
}) {
  const inTrash = Boolean(project.deletedAt)
  return (
    <article
      className={styles.row}
    >
      <button
        type="button"
        className={styles.rowThumb}
        onClick={inTrash ? onRestore : onOpen}
        disabled={restoring}
        aria-label={inTrash ? `Restaurar empresa ${project.name}` : `Abrir proyecto ${project.name}`}
      >
        <AppPreview project={project} compact />
      </button>
      <div className="min-w-0">
        <h2 className="text-[23px] font-semibold text-[#343436]">{project.name}</h2>
        <p className="mt-1 line-clamp-1 text-[15px] text-[#70737b]">{project.description}</p>
        <div className="mt-2 flex items-center gap-2 text-[15px] font-medium text-[#797d86]">
          {inTrash ? <CalendarClock className="h-4 w-4 text-[#ff0000]" strokeWidth={2} /> : <Globe2 className="h-4 w-4 text-[#2fbd73]" strokeWidth={2} />}
          <span>·</span>
          <span>{statusLabel(project, false, restoring)}</span>
        </div>
      </div>
      <div className={styles.rowActions}>
        <ProjectActions
          project={project}
          onOpen={onOpen}
          onDelete={onDelete}
          onRestore={onRestore}
          busy={restoring}
        />
      </div>
    </article>
  )
}

function ProjectActions({
  project,
  onOpen,
  onDelete,
  onRestore,
  busy,
}: {
  project: AppProject
  onOpen: () => void
  onDelete: () => void
  onRestore: () => void
  busy: boolean
}) {
  const inTrash = Boolean(project.deletedAt)
  const runAfterMenuClose = React.useCallback((action: () => void) => {
    window.setTimeout(action, 0)
  }, [])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Acciones de ${project.name}`}
          className={styles.cardMenuButton}
          disabled={busy}
        >
          <MoreVertical strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[210px]">
        {inTrash ? (
          <DropdownMenuItem onSelect={() => runAfterMenuClose(onRestore)}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Restaurar empresa
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => runAfterMenuClose(onOpen)}>
              <Globe2 className="mr-2 h-4 w-4" />
              Abrir en APPS
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => runAfterMenuClose(onDelete)} className="text-[#ff0000] focus:text-[#ff0000]">
              <Trash2 className="mr-2 h-4 w-4" />
              Mover a papelera
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AppPreview({ project, compact = false }: { project: AppProject; compact?: boolean }) {
  const visual = project.visual
  const title = previewTitle(visual.title)
  return (
    <div className={cn(styles.preview, compact && styles.previewCompact)}>
      <div
        className={styles.previewLogo}
        style={{ background: visual.soft, borderColor: visual.accent, color: visual.accent }}
      >
        {visual.initials}
      </div>

      <div className={styles.previewMark}>
        <div className={styles.previewMarkLines} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>

      <div className={cn(styles.previewScale, compact && styles.previewScaleCompact)}>
        <div className={styles.previewCanvas}>
          <nav className="mb-10 flex items-center justify-between text-[10px] font-medium text-[#35363a]">
            <div className="flex items-center gap-2">
              <span
                className="flex h-4 w-4 items-center justify-center rounded-sm text-[7px] font-black text-white"
                style={{ background: visual.accent, color: visual.ink }}
              >
                {visual.initials.slice(0, 1)}
              </span>
              <span>{visual.title}</span>
            </div>
            <div className="flex items-center gap-8">
              <span>Inicio</span>
              <span>Producto</span>
              <span>Contacto</span>
            </div>
            <div className="flex items-center gap-4">
              <span>Login</span>
              <span className="rounded-full px-4 py-1.5 text-white" style={{ background: visual.accent }}>Entrar</span>
            </div>
          </nav>

          <div className="mx-auto max-w-[620px] text-center">
            <span
              className="mb-8 inline-flex rounded-full px-4 py-1.5 text-[10px] font-semibold"
              style={{ background: visual.soft, color: visual.accent }}
            >
              {visual.eyebrow}
            </span>
            <h3 className="text-[42px] font-black leading-[0.96] text-[#111827]">
              {title.primary}
              <br />
              <span style={{ color: visual.accent }}>{title.accent}</span>
            </h3>
            <p className="mx-auto mt-6 max-w-[430px] text-[13px] leading-5 text-[#687180]">
              {visual.subtitle}
            </p>
            <div className="mx-auto mt-12 grid w-[470px] grid-cols-4 overflow-hidden rounded-[10px] bg-white shadow-[0_10px_35px_rgba(31,41,55,0.12)]">
              {[
                ["01", "EMPRESA"],
                ["30d", "PAPELERA"],
                ["1", "DUEÑO"],
                ["100%", "PRIVADO"],
              ].map(([value, label]) => (
                <div key={value} className="px-7 py-5 text-center">
                  <div className="text-[20px] font-black text-[#757b84]">{value}</div>
                  <div className="mt-1 text-[6px] font-bold text-[#a4a8ae]">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mx-auto mt-12 h-16 w-[520px] rounded-full blur-2xl" style={{ background: visual.soft }} />
        </div>
      </div>
    </div>
  )
}

function previewTitle(name: string): { primary: string; accent: string } {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { primary: words[0] || "Nueva", accent: "plataforma" }
  const midpoint = Math.max(1, Math.ceil(words.length / 2))
  return {
    primary: words.slice(0, midpoint).join(" "),
    accent: words.slice(midpoint).join(" ") || "digital",
  }
}

function statusLabel(project: AppProject, opening: boolean, restoring: boolean): string {
  if (opening) return "Abriendo en APPS..."
  if (restoring) return "Restaurando..."
  if (project.deletedAt) {
    const days = daysUntilProjectDelete(project.deleteAfter)
    return days == null ? "En papelera" : `En papelera · ${days} días restantes`
  }
  return project.timeLabel
}

function DeleteProjectDialog({
  project,
  onOpenChange,
  onConfirm,
}: {
  project: AppProject | null
  onOpenChange: (open: boolean) => void
  onConfirm: (project: AppProject) => Promise<void>
}) {
  const [step, setStep] = React.useState<1 | 2>(1)
  const [typedName, setTypedName] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!project) {
      setStep(1)
      setTypedName("")
      setBusy(false)
    }
  }, [project])

  const canConfirm = Boolean(project && typedName.trim() === project.name)

  async function submit() {
    if (!project || !canConfirm || busy) return
    setBusy(true)
    try {
      await onConfirm(project)
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message || "No se pudo mover la empresa a Papelera")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={Boolean(project)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Mover empresa a Papelera</DialogTitle>
          <DialogDescription>
            {project ? `"${project.name}" seguirá siendo privada y podrás restaurarla durante 30 días.` : ""}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-[#ff0000]/20 bg-[#ff0000]/5 p-4 text-sm text-[#343436]">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#ff0000]" strokeWidth={2} />
                <div>
                  <p className="font-semibold">No se elimina definitivamente.</p>
                  <p className="mt-1 text-[#70737b]">
                    El workspace, nombre y archivos quedan retenidos en Papelera. Los enlaces públicos se revocan.
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
            <label className="block text-sm font-medium text-[#242426]">
              Escribe el nombre exacto para confirmar
              <Input
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={project?.name || ""}
                className="mt-2"
                autoFocus
              />
            </label>
            <p className="text-xs text-[#70737b]">
              Esta segunda confirmación evita borrar por accidente un proyecto de código importante.
            </p>
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

function ProjectsSkeleton() {
  return (
    <div className={styles.skeletonGrid}>
      <div className={styles.skeletonCard} />
    </div>
  )
}

function NoResults({ label }: { label: string }) {
  return (
    <div className={styles.noResults}>
      {label}
    </div>
  )
}

function toAppProject(project: Project, dateLocale: Locale): AppProject {
  let rel = "just now"
  try {
    rel = formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true, locale: dateLocale })
  } catch {
    rel = "just now"
  }
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    timeLabel: rel,
    status: "active",
    artifactType: "webapp",
    href: codeWorkspaceHref(project.id),
    deletedAt: project.deletedAt || null,
    deleteAfter: project.deleteAfter || null,
    visual: getProjectVisualIdentity(project),
  }
}

function codeWorkspaceHref(projectId: string) {
  return `/code?folder=${encodeURIComponent(projectId)}`
}

type Locale = typeof dfEn
