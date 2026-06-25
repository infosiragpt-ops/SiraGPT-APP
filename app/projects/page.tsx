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
import { ChevronDown, Check, Folder, Globe2, Grid3X3, LayoutGrid, List, Search } from "lucide-react"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import { es as dfEs, enUS as dfEn } from "date-fns/locale"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { projectsService, type Project } from "@/lib/projects-service"
import styles from "./projects-page.module.css"

type StatusFilter = "any" | "active" | "draft"
type ArtifactFilter = "any" | "webapp" | "mobileapp" | "dashboard"
type ViewMode = "grid" | "list"

interface AppProject {
  id: string
  name: string
  description: string | null
  timeLabel: string
  status: "active" | "draft"
  artifactType: "webapp" | "mobileapp" | "dashboard"
  href: string
  seeded?: boolean
}

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "any", label: "Any status" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
]

const ARTIFACT_OPTIONS: Array<{ value: ArtifactFilter; label: string }> = [
  { value: "any", label: "Any artifact type" },
  { value: "webapp", label: "Web app" },
  { value: "mobileapp", label: "Mobile app" },
  { value: "dashboard", label: "Dashboard" },
]

const SEEDED_APP_PROJECT: AppProject = {
  id: "siragpt-app",
  name: "SIRAGPT",
  description: "Plataforma multi-LLM con chat, imagen, documentos y APPS.",
  timeLabel: "8 seconds ago",
  status: "active",
  artifactType: "webapp",
  href: "/code",
  seeded: true,
}

export default function ProjectsPage() {
  const t = useTranslations("projects")
  const router = useRouter()

  const [projects, setProjects] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(true)
  const [search, setSearch] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("any")
  const [artifactFilter, setArtifactFilter] = React.useState<ArtifactFilter>("any")
  const [viewMode, setViewMode] = React.useState<ViewMode>("grid")
  const [openingProjectId, setOpeningProjectId] = React.useState<string | null>(null)

  const dateLocale = React.useMemo(() => {
    if (typeof document !== "undefined" && document.documentElement.lang?.startsWith("es")) return dfEs
    return dfEn
  }, [])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    projectsService
      .list({ type: "webapp", sort: "activity" })
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
  }, [t])

  const appProjects = React.useMemo(() => {
    const rows = projects.map((project) => toAppProject(project, dateLocale))
    const hasSira = rows.some((project) => project.name.replace(/\s+/g, "").toLowerCase() === "siragpt")
    return hasSira ? rows : [SEEDED_APP_PROJECT, ...rows]
  }, [projects, dateLocale])

  const visibleProjects = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return appProjects.filter((project) => {
      if (statusFilter !== "any" && project.status !== statusFilter) return false
      if (artifactFilter !== "any" && project.artifactType !== artifactFilter) return false
      if (!q) return true
      return `${project.name} ${project.description || ""}`.toLowerCase().includes(q)
    })
  }, [appProjects, artifactFilter, search, statusFilter])

  const openAppProject = React.useCallback(
    async (project: AppProject) => {
      if (openingProjectId) return
      setOpeningProjectId(project.id)
      try {
        if (!project.seeded) {
          router.push(project.href)
          return
        }

        const freshProjects = await projectsService.list({ type: "webapp", sort: "activity" })
        const existing = freshProjects.find(
          (row) => row.name.replace(/\s+/g, "").toLowerCase() === "siragpt"
        )
        const target = existing || await projectsService.create({
          name: "SIRAGPT",
          description: SEEDED_APP_PROJECT.description || undefined,
          type: "webapp",
          hostingProvider: "sira-cloud",
        })

        setProjects((prev) => {
          const seen = prev.some((row) => row.id === target.id)
          return seen ? prev : [target, ...prev]
        })
        router.push(codeWorkspaceHref(target.id))
      } catch (err: any) {
        toast.error(err?.message || "No se pudo abrir la app en APPS")
      } finally {
        setOpeningProjectId(null)
      }
    },
    [openingProjectId, router],
  )

  return (
    <div className={styles.page}>
      <div className={styles.mobileHeader}>
        <SidebarTrigger />
      </div>

      <main className={styles.main}>
        <header className={styles.header}>
          <LayoutGrid className={styles.titleIcon} strokeWidth={2.25} />
          <h1 className={styles.title} data-testid="projects-page-title">
            Projects
          </h1>
        </header>

        <section className={styles.toolbar}>
          <div className={styles.filters}>
            <label className={styles.search} role="search">
              <span className="sr-only">Buscar proyectos APPS</span>
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
                  All projects
                  <ChevronDown strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuItem className="justify-between">
                  All projects
                  <Check className="h-4 w-4" />
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

        {loading ? (
          <ProjectsSkeleton />
        ) : visibleProjects.length === 0 ? (
          <NoResults />
        ) : viewMode === "grid" ? (
          <div className={styles.grid} data-testid="projects-grid">
            {visibleProjects.map((project) => (
              <AppProjectCard
                key={project.id}
                project={project}
                opening={openingProjectId === project.id}
                onOpen={() => void openAppProject(project)}
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
              />
            ))}
          </div>
        )}
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
  onOpen,
}: {
  project: AppProject
  opening: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      aria-busy={opening}
      aria-label={`Abrir proyecto ${project.name}`}
      data-testid={`project-card-${project.id}`}
      disabled={opening}
      onClick={onOpen}
      className={styles.card}
    >
      <AppPreview />
      <div className={styles.cardMeta}>
        <h2 className={styles.cardTitle}>{project.name}</h2>
        <div className={styles.cardTime}>
          <Globe2 strokeWidth={2} />
          <span aria-hidden="true">·</span>
          <span>{opening ? "Abriendo en APPS..." : project.timeLabel}</span>
        </div>
      </div>
    </button>
  )
}

function AppProjectRow({ project, onOpen }: { project: AppProject; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={styles.row}
    >
      <div className={styles.rowThumb}>
        <AppPreview compact />
      </div>
      <div className="min-w-0">
        <h2 className="text-[23px] font-semibold text-[#343436]">{project.name}</h2>
        <p className="mt-1 line-clamp-1 text-[15px] text-[#70737b]">{project.description}</p>
        <div className="mt-2 flex items-center gap-2 text-[15px] font-medium text-[#797d86]">
          <Globe2 className="h-4 w-4 text-[#2fbd73]" strokeWidth={2} />
          <span>·</span>
          <span>{project.timeLabel}</span>
        </div>
      </div>
    </button>
  )
}

function AppPreview({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn(styles.preview, compact && styles.previewCompact)}>
      <div className={styles.previewLogo}>
        <img src="/sira-gpt-192.png" alt="" className="h-5 w-5 rounded-sm object-contain" />
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
              <img src="/sira-gpt-192.png" alt="" className="h-4 w-4 rounded-sm" />
              <span>Sira GPT</span>
            </div>
            <div className="flex items-center gap-8">
              <span>Características</span>
              <span>Cómo funciona</span>
              <span>Precios</span>
            </div>
            <div className="flex items-center gap-4">
              <span>Login</span>
              <span className="rounded-full bg-[#352dff] px-4 py-1.5 text-white">Sign Up</span>
            </div>
          </nav>

          <div className="mx-auto max-w-[620px] text-center">
            <span className="mb-8 inline-flex rounded-full bg-[#f1e9ff] px-4 py-1.5 text-[10px] font-semibold text-[#7b43d8]">
              Plataforma de Inteligencia Artificial Multimodal
            </span>
            <h3 className="text-[42px] font-black leading-[0.96] text-[#111827]">
              Todo el poder de la IA en
              <br />
              <span className="text-[#9b4dff]">un solo lugar</span>
            </h3>
            <p className="mx-auto mt-6 max-w-[430px] text-[13px] leading-5 text-[#687180]">
              Chatea con GPT-5.5, Claude Opus 4.7, Gemini 3.5 Pro y más.
              Genera imágenes, analiza documentos, diseña prototipos e investiga con agentes de IA especializados.
            </p>
            <div className="mx-auto mt-12 grid w-[470px] grid-cols-4 overflow-hidden rounded-[10px] bg-white shadow-[0_10px_35px_rgba(31,41,55,0.12)]">
              {[
                ["12+", "MODELOS DE IA"],
                ["10K+", "USUARIOS ACTIVOS"],
                ["500K+", "TOKENS PROCESADOS"],
                ["40+", "PAÍSES"],
              ].map(([value, label]) => (
                <div key={value} className="px-7 py-5 text-center">
                  <div className="text-[20px] font-black text-[#757b84]">{value}</div>
                  <div className="mt-1 text-[6px] font-bold text-[#a4a8ae]">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mx-auto mt-12 h-16 w-[520px] rounded-full bg-[#f0d5ff] blur-2xl" />
        </div>
      </div>
    </div>
  )
}

function ProjectsSkeleton() {
  return (
    <div className={styles.skeletonGrid}>
      <div className={styles.skeletonCard} />
    </div>
  )
}

function NoResults() {
  return (
    <div className={styles.noResults}>
      No matching APPS projects.
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
  }
}

function codeWorkspaceHref(projectId: string) {
  return `/code?folder=${encodeURIComponent(projectId)}`
}

type Locale = typeof dfEn
