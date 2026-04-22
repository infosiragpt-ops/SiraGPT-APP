"use client"

/**
 * /projects — index page.
 *
 * Shape mirrors the Claude Projects UX from the user's reference
 * screenshots:
 *   - Title row: "Proyectos" + "+ Nuevo proyecto" CTA
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
import { Plus, Search, ChevronDown, Check, FolderKanban } from "lucide-react"
import { toast } from "sonner"
import { formatDistanceToNow } from "date-fns"
import { es as dfEs, enUS as dfEn } from "date-fns/locale"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

import { CreateProjectDialog } from "@/components/projects/create-project-dialog"
import { projectsService, type Project, type ProjectSort } from "@/lib/projects-service"

const SORTS: ProjectSort[] = ["activity", "edited", "created"]

export default function ProjectsPage() {
  const t = useTranslations("projects")
  const router = useRouter()

  const [projects, setProjects] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(true)
  const [search, setSearch] = React.useState("")
  const [sort, setSort] = React.useState<ProjectSort>("activity")
  const [dialogOpen, setDialogOpen] = React.useState(false)

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

  function openCreate() {
    setDialogOpen(true)
  }

  function handleCreated(p: Project) {
    // Go straight into the new project so the user can start
    // attaching files / chatting immediately. Also prepend locally
    // so if they hit back, the card is already visible.
    setProjects(prev => [p, ...prev])
    router.push(`/projects/${p.id}`)
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
          <h1 className="text-3xl font-serif tracking-tight">{t("title")}</h1>
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="h-4 w-4" />
            {t("newProject")}
          </Button>
        </header>

        <div className="mb-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-11 pl-10"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mb-4 text-sm">
          <span className="text-muted-foreground">{t("sortBy")}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-8">
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
        ) : projects.length === 0 ? (
          <EmptyState search={debouncedSearch} onCreate={openCreate} t={t} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                dateLocale={dateLocale}
                onOpen={() => router.push(`/projects/${p.id}`)}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />
    </div>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function ProjectCard({
  project, dateLocale, onOpen, t,
}: {
  project: Project
  dateLocale: Locale
  onOpen: () => void
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
      className={cn(
        "cursor-pointer transition-shadow duration-150 hover:shadow-md",
        "border-border/60"
      )}
    >
      <CardHeader className="pb-3">
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
