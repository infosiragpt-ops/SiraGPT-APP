"use client"

import * as React from "react"
import {
  ArrowLeft,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileCode2,
  FolderOpen,
  Gauge,
  LayoutDashboard,
  ListTree,
  Loader2,
  Network,
  PackageOpen,
  Plus,
  Radio,
  Sparkles,
} from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  AGENT_COMPANY_DEPARTMENTS,
  agentCompanyDisplayName,
  buildAgentCompanySnapshot,
  codeSessionIsActive,
  codeSessionStatus,
  departmentIdForSession,
  type AgentDepartmentDefinition,
} from "@/lib/code-agent-company"
import {
  buildProactiveKickoffPrompt,
  CODE_FOCUS_CEO_CHAT_EVENT,
  departmentBootstrapTitle,
  hydrateProactiveCompany,
  PROACTIVE_CORE_DEPARTMENTS,
  requestProactiveSeedPrompt,
  setProactiveCompanyEnabled,
} from "@/lib/code-agent-company-proactive"
import type { CodeChatSession } from "@/lib/code-chat-sessions"
import { useAuth } from "@/lib/auth-context-integrated"
import { codexIdForProject, listCodexProjects, upsertCodexProject } from "@/lib/codex-projects"
import {
  CODE_OPEN_TOOL_EVENT,
  CODE_PREVIEW_STATE_EVENT,
  getActiveCodexProject,
  type CodePreviewState,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import { codexApi } from "@/lib/codex/codex-api"
import { projectsService, type Project } from "@/lib/projects-service"
import { cn } from "@/lib/utils"

import { AICodeChatPanel } from "./ai-code-chat-panel"

type CompanyView = "home" | "chat" | "dashboard" | "control" | "department" | "task"

type CompanyOption = {
  id: string
  projectId?: string
  name: string
  kind: "project" | "local-folder"
}

type CustomDepartment = AgentDepartmentDefinition & { custom: true }

const CUSTOM_DEPARTMENTS_KEY = "code-workspace:agent-company-departments:v1"

const EMPTY_PREVIEW_STATE: CodePreviewState = {
  phase: "idle",
  src: "",
  staticHtml: "",
  note: "",
  kind: "empty",
  entry: null,
}

const STATUS_STYLES = {
  idle: "bg-zinc-300 dark:bg-zinc-600",
  active: "bg-sky-500",
  ready: "bg-emerald-500",
  attention: "bg-amber-500",
} as const

function customDepartmentStorageKey(workspaceId: string | null | undefined): string {
  return `${CUSTOM_DEPARTMENTS_KEY}:${workspaceId || "__default__"}`
}

function readCustomDepartments(workspaceId: string | null | undefined): CustomDepartment[] {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(customDepartmentStorageKey(workspaceId)) || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((row) => row && typeof row.id === "string" && typeof row.name === "string")
      .map((row) => ({
        id: String(row.id),
        name: String(row.name).slice(0, 70),
        description: typeof row.description === "string" ? row.description.slice(0, 140) : "Departamento personalizado.",
        keywords: Array.isArray(row.keywords) ? row.keywords.filter((value: unknown) => typeof value === "string") : [],
        custom: true as const,
      }))
  } catch {
    return []
  }
}

function writeCustomDepartments(workspaceId: string | null | undefined, rows: CustomDepartment[]) {
  try {
    window.localStorage.setItem(customDepartmentStorageKey(workspaceId), JSON.stringify(rows))
  } catch {
    /* storage disabled */
  }
}

function relativeActivity(updatedAt: number): string {
  const diff = Math.max(0, Date.now() - updatedAt)
  if (diff < 60_000) return "Ahora"
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} h`
  return `${Math.max(1, Math.floor(diff / 86_400_000))} d`
}

function latestSessionLine(session: CodeChatSession): string {
  const lastTurn = [...session.turns].reverse().find((turn) => turn.content.trim())
  if (!lastTurn) return session.title
  const line = lastTurn.content.replace(/\s+/g, " ").trim()
  return line.length > 76 ? `${line.slice(0, 76)}…` : line
}

function initials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.trim() || "SiraGPT"
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

function companyWorkspaceCandidates(option: CompanyOption): string[] {
  const values = [option.id]
  if (option.projectId) values.push(option.projectId, codexIdForProject(option.projectId))
  return Array.from(new Set(values))
}

export function AgentCompanyPanel() {
  const { user } = useAuth()
  const {
    files,
    activeFolder,
    codeChatSessions,
    activeCodeChatSessionId,
    createCodeChatSession,
    setActiveCodeChatSession,
    listCodeChatSessionsForWorkspace,
    switchCodexWorkspace,
  } = useCodeWorkspace()

  const [view, setView] = React.useState<CompanyView>("home")
  const [selectedDepartmentId, setSelectedDepartmentId] = React.useState("ceo-office")
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null)
  const [previewState, setPreviewState] = React.useState<CodePreviewState>(EMPTY_PREVIEW_STATE)
  const [companyMenuOpen, setCompanyMenuOpen] = React.useState(false)
  const [projects, setProjects] = React.useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = React.useState(false)
  const [newCompanyOpen, setNewCompanyOpen] = React.useState(false)
  const [newCompanyName, setNewCompanyName] = React.useState("")
  const [creatingCompany, setCreatingCompany] = React.useState(false)
  const [newDepartmentOpen, setNewDepartmentOpen] = React.useState(false)
  const [newDepartmentName, setNewDepartmentName] = React.useState("")
  const [customDepartments, setCustomDepartments] = React.useState<CustomDepartment[]>([])
  // Modo PROACTIVO (compañía autónoma): estado real del backend por proyecto.
  const [proactiveOn, setProactiveOn] = React.useState(false)
  const [proactiveBusy, setProactiveBusy] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    const hydrated = hydrateProactiveCompany(activeFolder?.id)
    setProactiveOn(hydrated.enabled)

    const load = () => {
      const codexProjectId = getActiveCodexProject()
      if (!codexProjectId) return
      codexApi
        .getProactive(codexProjectId)
        .then((r) => {
          if (!alive) return
          const enabled = Boolean(r.state?.enabled)
          setProactiveOn(enabled)
          setProactiveCompanyEnabled(enabled, { workspaceId: activeFolder?.id || null })
        })
        .catch(() => { /* backend viejo o sin sesión: el chip queda informativo */ })
    }
    load()
    const timer = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [activeFolder?.id])

  const snapshot = React.useMemo(
    () => buildAgentCompanySnapshot(codeChatSessions, files),
    [codeChatSessions, files],
  )
  const companyName = agentCompanyDisplayName(activeFolder?.name)
  const allDepartments = React.useMemo(
    () => [...AGENT_COMPANY_DEPARTMENTS, ...customDepartments],
    [customDepartments],
  )

  React.useEffect(() => {
    setCustomDepartments(readCustomDepartments(activeFolder?.id))
    setView("home")
    setSelectedTaskId(null)
    setPreviewState(EMPTY_PREVIEW_STATE)
  }, [activeFolder?.id])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const onPreviewState = (event: Event) => {
      const detail = (event as CustomEvent<CodePreviewState>).detail
      if (detail) setPreviewState(detail)
    }
    window.addEventListener(CODE_PREVIEW_STATE_EVENT, onPreviewState)
    return () => window.removeEventListener(CODE_PREVIEW_STATE_EVENT, onPreviewState)
  }, [])

  const refreshProjects = React.useCallback(async () => {
    setProjectsLoading(true)
    try {
      setProjects(await projectsService.list({ sort: "activity" }))
    } catch {
      setProjects([])
    } finally {
      setProjectsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  React.useEffect(() => {
    if (companyMenuOpen) void refreshProjects()
  }, [companyMenuOpen, refreshProjects])

  const companyOptions = React.useMemo<CompanyOption[]>(() => {
    const cloud: CompanyOption[] = projects.map((project) => ({
      id: project.id,
      projectId: project.id,
      name: project.name,
      kind: "project",
    }))
    const local: CompanyOption[] = listCodexProjects()
      .filter((entry) => entry.kind === "local-folder")
      .map((entry) => ({ id: entry.id, name: entry.name, kind: "local-folder" }))
    const current: CompanyOption | null = activeFolder
      ? {
          id: activeFolder.id,
          projectId: activeFolder.id.startsWith("local:") ? undefined : activeFolder.id,
          name: activeFolder.name,
          kind: activeFolder.id.startsWith("local:") ? "local-folder" : "project",
        }
      : null
    const merged = current ? [current, ...cloud, ...local] : [...cloud, ...local]
    return merged.filter((entry, index) => merged.findIndex((candidate) => candidate.id === entry.id) === index)
  }, [activeFolder, projects])

  const departmentRows = React.useMemo(() => {
    return allDepartments.map((department) => {
      const sessions = codeChatSessions.filter(
        (session) => departmentIdForSession(session, snapshot.rootSessionId, allDepartments) === department.id,
      )
      const activeCount = sessions.filter(codeSessionIsActive).length
      const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
      return { department, sessions, activeCount, latest }
    })
  }, [allDepartments, codeChatSessions, snapshot.rootSessionId])

  const selectedDepartment = departmentRows.find((row) => row.department.id === selectedDepartmentId) || null
  const selectedTask = codeChatSessions.find((session) => session.id === selectedTaskId) || null

  const openTool = React.useCallback((toolId: string) => {
    window.dispatchEvent(new CustomEvent(CODE_OPEN_TOOL_EVENT, { detail: { toolId } }))
  }, [])

  const openPreview = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))
  }, [])

  const openCeoOffice = React.useCallback(() => {
    let rootSessionId = codeChatSessions.find(
      (session) => session.title.trim().toLowerCase() === "ceo office",
    )?.id
    if (!rootSessionId) rootSessionId = createCodeChatSession({ title: "CEO Office" })
    setActiveCodeChatSession(rootSessionId)
    setView("chat")
  }, [
    createCodeChatSession,
    codeChatSessions,
    setActiveCodeChatSession,
  ])

  React.useEffect(() => {
    const onFocusCeo = () => openCeoOffice()
    window.addEventListener(CODE_FOCUS_CEO_CHAT_EVENT, onFocusCeo)
    return () => window.removeEventListener(CODE_FOCUS_CEO_CHAT_EVENT, onFocusCeo)
  }, [openCeoOffice])

  const ensureDepartmentSessions = React.useCallback(() => {
    const existingTitles = new Set(codeChatSessions.map((session) => session.title.trim().toLowerCase()))
    let rootSessionId = codeChatSessions.find(
      (session) => session.title.trim().toLowerCase() === "ceo office",
    )?.id
    if (!rootSessionId) {
      rootSessionId = createCodeChatSession({ title: "CEO Office" })
      existingTitles.add("ceo office")
    }
    for (const department of PROACTIVE_CORE_DEPARTMENTS) {
      if (department.id === "ceo-office") continue
      const title = departmentBootstrapTitle(department)
      if (existingTitles.has(title.toLowerCase())) continue
      createCodeChatSession({ title })
      existingTitles.add(title.toLowerCase())
    }
    return rootSessionId
  }, [codeChatSessions, createCodeChatSession])

  const toggleProactive = React.useCallback(async () => {
    const next = !proactiveOn
    if (next) {
      const rootSessionId = ensureDepartmentSessions()
      setActiveCodeChatSession(rootSessionId)
      setView("chat")
      setProactiveCompanyEnabled(true, { workspaceId: activeFolder?.id || null })
      window.setTimeout(
        () => requestProactiveSeedPrompt(buildProactiveKickoffPrompt(companyName)),
        120,
      )
    } else {
      setProactiveCompanyEnabled(false, { workspaceId: activeFolder?.id || null })
    }

    const codexProjectId = getActiveCodexProject()
    if (!codexProjectId) {
      setProactiveOn(next)
      toast.info(
        next
          ? "PROACTIVO activo en CEO Office. Cuando exista un proyecto Codex, los departamentos también correrán en el servidor."
          : "Modo PROACTIVO pausado.",
      )
      return
    }

    setProactiveBusy(true)
    try {
      const r = await codexApi.setProactive(codexProjectId, next)
      setProactiveOn(Boolean(r.state?.enabled))
      toast.success(
        next
          ? "Modo PROACTIVO activado — la empresa de agentes opera de forma autónoma."
          : "Modo PROACTIVO desactivado.",
      )
    } catch {
      setProactiveOn(next)
      toast.error("No se pudo sincronizar PROACTIVO con el servidor; el modo local sigue activo.")
    } finally {
      setProactiveBusy(false)
    }
  }, [
    activeFolder?.id,
    companyName,
    ensureDepartmentSessions,
    proactiveOn,
    setActiveCodeChatSession,
  ])

  const selectCompany = React.useCallback(
    async (option: CompanyOption) => {
      setCompanyMenuOpen(false)
      await switchCodexWorkspace({
        id: option.kind === "project" && option.projectId ? codexIdForProject(option.projectId) : option.id,
        name: option.name,
        kind: option.kind,
        projectId: option.projectId,
      })
    },
    [switchCodexWorkspace],
  )

  const createCompany = React.useCallback(async () => {
    const name = newCompanyName.trim()
    if (!name || creatingCompany) return
    setCreatingCompany(true)
    try {
      const project = await projectsService.create({
        name,
        description: "Empresa de agentes",
        type: "webapp",
      })
      upsertCodexProject({ id: codexIdForProject(project.id), name: project.name, kind: "project" })
      await switchCodexWorkspace({
        id: codexIdForProject(project.id),
        name: project.name,
        kind: "project",
        projectId: project.id,
      })
      setNewCompanyName("")
      setNewCompanyOpen(false)
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
      toast.success("Empresa de agentes creada.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo crear la empresa.")
    } finally {
      setCreatingCompany(false)
    }
  }, [creatingCompany, newCompanyName, switchCodexWorkspace])

  const createDepartment = React.useCallback(() => {
    const name = newDepartmentName.trim()
    if (!name) return
    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || Date.now()}`
    if (allDepartments.some((department) => department.id === id || department.name.toLowerCase() === name.toLowerCase())) {
      toast.error("Ese departamento ya existe.")
      return
    }
    const next = [
      ...customDepartments,
      {
        id,
        name,
        description: "Departamento personalizado.",
        keywords: name.toLocaleLowerCase("es").split(/\s+/).filter(Boolean),
        custom: true as const,
      },
    ]
    setCustomDepartments(next)
    writeCustomDepartments(activeFolder?.id, next)
    setNewDepartmentName("")
    setNewDepartmentOpen(false)
    setSelectedDepartmentId(id)
    toast.success("Departamento añadido.")
  }, [activeFolder?.id, allDepartments, customDepartments, newDepartmentName])

  const currentProjectId = activeFolder?.id?.replace(/^project:/, "") || null
  const previewBadge =
    previewState.phase === "ready"
      ? { label: "Live", tone: "bg-red-500" }
      : previewState.phase === "starting"
        ? { label: "Arrancando", tone: "bg-sky-500" }
        : previewState.phase === "error" || previewState.phase === "stuck"
          ? { label: "Revisar", tone: "bg-amber-500" }
          : { label: "Preview", tone: "bg-zinc-400" }

  const previewSandbox =
    previewState.src && typeof window !== "undefined" && !previewState.src.startsWith(window.location.origin)
      ? undefined
      : "allow-scripts allow-forms allow-popups allow-modals"

  const panel = (
    <div
      className="relative h-full min-h-0 overflow-hidden border-r border-border/50 bg-background text-foreground"
      data-agent-company-dock="workspace"
      data-proactive={proactiveOn ? "on" : "off"}
    >
      <div className={cn("absolute inset-0", view === "chat" ? "block" : "invisible pointer-events-none")}>
        <AICodeChatPanel
          embedded
          title="CEO Office"
          onBack={() => setView("home")}
          proactive={proactiveOn}
        />
      </div>

      <div
        className={cn(
          "flex h-full min-h-0 flex-col",
          view === "chat" && "invisible pointer-events-none",
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/55 px-3">
          {view !== "home" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-md"
              onClick={() => setView("home")}
              aria-label="Volver a la empresa"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}

          <Popover open={companyMenuOpen} onOpenChange={setCompanyMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Cambiar empresa de agentes"
              >
                <span className="truncate text-[17px] font-semibold">{companyName}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={8}
              className="w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-lg border-white bg-white/95 p-0 shadow-[0_24px_70px_-34px_rgba(15,23,42,0.45)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/95"
            >
              <div className="flex items-center justify-between border-b border-border/45 px-4 py-3">
                <span className="text-[11px] font-semibold uppercase text-muted-foreground">Empresa de agentes</span>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-foreground/75">
                  <span className={cn("h-2 w-2 rounded-full", snapshot.activeAgents > 0 ? "bg-sky-500" : "bg-zinc-300")} />
                  {snapshot.activeAgents > 0 ? `${snapshot.activeAgents} en ejecución` : "Sin ejecuciones"}
                </span>
              </div>
              <div className="max-h-[340px] space-y-2 overflow-y-auto p-3">
                {projectsLoading && companyOptions.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : companyOptions.length === 0 ? (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">Sin empresas.</p>
                ) : (
                  companyOptions.map((option) => {
                    const optionSessions = companyWorkspaceCandidates(option)
                      .map((candidate) => listCodeChatSessionsForWorkspace(candidate))
                      .find((sessions) => sessions.length > 0) || []
                    const optionSnapshot = buildAgentCompanySnapshot(optionSessions, {})
                    const active = optionSnapshot.activeAgents
                    const isCurrent = Boolean(
                      currentProjectId && companyWorkspaceCandidates(option).some((candidate) => candidate.replace(/^project:/, "") === currentProjectId),
                    )
                    return (
                      <button
                        key={`${option.kind}:${option.id}`}
                        type="button"
                        onClick={() => void selectCompany(option)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
                          isCurrent
                            ? "border-sky-200 bg-sky-50/80 dark:border-sky-900/70 dark:bg-sky-950/25"
                            : "border-border/55 bg-background/65 hover:bg-muted/45",
                        )}
                      >
                        <span className="flex h-9 w-1 shrink-0 rounded-full bg-sky-300" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{agentCompanyDisplayName(option.name)}</span>
                          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                            {optionSnapshot.taskCount} tareas · {active} agentes activos
                          </span>
                        </span>
                        <span className="min-w-[52px] text-right">
                          <span className="block text-xl font-semibold tabular-nums">{active}</span>
                          <span className="block text-[9px] uppercase text-muted-foreground">Activos</span>
                        </span>
                        {isCurrent ? <Check className="h-4 w-4 shrink-0 text-sky-600" /> : null}
                      </button>
                    )
                  })
                )}
              </div>
              <div className="border-t border-border/45 p-2">
                <button
                  type="button"
                  className="flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm font-medium hover:bg-muted/55"
                  onClick={() => {
                    setCompanyMenuOpen(false)
                    setNewCompanyOpen(true)
                  }}
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                    <Plus className="h-4 w-4" />
                  </span>
                  Añadir empresa de agentes
                </button>
              </div>
            </PopoverContent>
          </Popover>

          {view === "home" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full bg-muted/45"
              onClick={() => setNewCompanyOpen(true)}
              aria-label="Añadir empresa de agentes"
              title="Añadir empresa de agentes"
            >
              <Plus className="h-5 w-5" />
            </Button>
          ) : null}
        </header>

        {view === "home" ? (
          <CompanyHome
            companyName={companyName}
            previewState={previewState}
            previewBadge={previewBadge}
            previewSandbox={previewSandbox}
            snapshot={snapshot}
            departmentRows={departmentRows}
            onOpenPreview={openPreview}
            onOpenDashboard={() => setView("dashboard")}
            onOpenControl={() => setView("control")}
            onOpenFiles={() => openTool("files")}
            onOpenResources={() => openTool("skills")}
            onOpenDepartment={(departmentId) => {
              if (departmentId === "ceo-office") {
                openCeoOffice()
                return
              }
              setSelectedDepartmentId(departmentId)
              setView("department")
            }}
            onAddDepartment={() => setNewDepartmentOpen(true)}
            user={user}
            proactiveOn={proactiveOn}
            proactiveBusy={proactiveBusy}
            onToggleProactive={() => void toggleProactive()}
          />
        ) : view === "dashboard" ? (
          <DashboardView
            snapshot={snapshot}
            sessions={codeChatSessions}
            departmentCount={allDepartments.length}
            rootSessionId={snapshot.rootSessionId}
            onOpenTask={(sessionId) => {
              setSelectedTaskId(sessionId)
              setView("task")
            }}
          />
        ) : view === "control" ? (
          <ControlView
            rootSessionId={snapshot.rootSessionId}
            sessions={codeChatSessions}
            activeSessionId={activeCodeChatSessionId}
            onOpenCeo={openCeoOffice}
            onOpenTask={(sessionId) => {
              setSelectedTaskId(sessionId)
              setView("task")
            }}
          />
        ) : view === "department" && selectedDepartment ? (
          <DepartmentView row={selectedDepartment} onOpenCeo={openCeoOffice} />
        ) : view === "task" && selectedTask ? (
          <TaskView session={selectedTask} onOpenCeo={openCeoOffice} />
        ) : null}
      </div>

      <Dialog open={newCompanyOpen} onOpenChange={setNewCompanyOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Nueva empresa de agentes</DialogTitle>
            <DialogDescription>Crea un workspace persistente para su operación.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="agent-company-name">Nombre</Label>
            <Input
              id="agent-company-name"
              value={newCompanyName}
              onChange={(event) => setNewCompanyName(event.target.value)}
              placeholder="Ej. TESIS20.COM"
              autoComplete="organization"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void createCompany()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewCompanyOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={() => void createCompany()} disabled={!newCompanyName.trim() || creatingCompany}>
              {creatingCompany ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Crear empresa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newDepartmentOpen} onOpenChange={setNewDepartmentOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Nuevo departamento</DialogTitle>
            <DialogDescription>Añade una unidad operativa a esta empresa.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="agent-department-name">Nombre</Label>
            <Input
              id="agent-department-name"
              value={newDepartmentName}
              onChange={(event) => setNewDepartmentName(event.target.value)}
              placeholder="Ej. Finanzas y Operaciones"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  createDepartment()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewDepartmentOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={createDepartment} disabled={!newDepartmentName.trim()}>
              Añadir departamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )

  return panel
}

function CompanyHome({
  companyName,
  previewState,
  previewBadge,
  previewSandbox,
  snapshot,
  departmentRows,
  onOpenPreview,
  onOpenDashboard,
  onOpenControl,
  onOpenFiles,
  onOpenResources,
  onOpenDepartment,
  onAddDepartment,
  user,
  proactiveOn,
  proactiveBusy,
  onToggleProactive,
}: {
  companyName: string
  previewState: CodePreviewState
  previewBadge: { label: string; tone: string }
  previewSandbox?: string
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  departmentRows: Array<{
    department: AgentDepartmentDefinition
    sessions: CodeChatSession[]
    activeCount: number
    latest: CodeChatSession | null
  }>
  onOpenPreview: () => void
  onOpenDashboard: () => void
  onOpenControl: () => void
  onOpenFiles: () => void
  onOpenResources: () => void
  onOpenDepartment: (departmentId: string) => void
  onAddDepartment: () => void
  user: ReturnType<typeof useAuth>["user"]
  proactiveOn: boolean
  proactiveBusy: boolean
  onToggleProactive: () => void
}) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
        <button
          type="button"
          onClick={onOpenPreview}
          className="group relative block aspect-[16/9] w-full overflow-hidden rounded-lg border border-border/60 bg-zinc-100 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-zinc-900"
          aria-label="Abrir preview en vivo"
        >
          {previewState.src ? (
            <iframe
              src={previewState.src}
              title="Miniatura del preview en vivo"
              className="pointer-events-none h-full w-full origin-top-left border-0 bg-white"
              sandbox={previewSandbox}
              loading="lazy"
              tabIndex={-1}
            />
          ) : previewState.staticHtml ? (
            <iframe
              srcDoc={previewState.staticHtml}
              title="Miniatura del preview"
              className="pointer-events-none h-full w-full border-0 bg-white"
              sandbox="allow-scripts allow-forms"
              loading="lazy"
              tabIndex={-1}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/opengraph-image.png" alt="SiraGPT" className="h-full w-full object-cover object-top opacity-90" />
          )}
          <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/88 px-2.5 py-1 text-[11px] font-semibold text-zinc-800 shadow-sm backdrop-blur-xl">
            <span className={cn("h-2 w-2 rounded-full", previewBadge.tone)} />
            {previewBadge.label}
          </span>
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-zinc-950/58 px-3 py-2 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="truncate text-[11px] font-medium">{companyName}</span>
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>

        <nav aria-label="Herramientas de la empresa" className="mt-3 space-y-0.5">
          <CompanyNavRow icon={LayoutDashboard} label="Panel" onClick={onOpenDashboard} />
          <CompanyNavRow icon={ListTree} label="Controlar" count={snapshot.taskCount} onClick={onOpenControl} />
          <CompanyNavRow icon={FolderOpen} label="Archivos" count={snapshot.fileCount} onClick={onOpenFiles} />
          <CompanyNavRow icon={BriefcaseBusiness} label="Recursos" count={snapshot.resourceCount} onClick={onOpenResources} />
        </nav>

        <div className="mt-4 flex items-center justify-between px-2">
          <h2 className="text-xs font-semibold text-muted-foreground">Departamentos</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-md text-muted-foreground hover:text-foreground"
            onClick={onAddDepartment}
            aria-label="Añadir departamento"
            title="Añadir departamento"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-1 space-y-0.5">
          {departmentRows.map(({ department, activeCount, latest }) => {
            const status = latest ? codeSessionStatus(latest) : { label: "Disponible", tone: "idle" as const }
            return (
              <button
                key={department.id}
                type="button"
                className={cn(
                  "group flex min-h-[58px] w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  department.id === "ceo-office" && "bg-muted/50",
                )}
                onClick={() => onOpenDepartment(department.id)}
              >
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/55 bg-muted/40 text-muted-foreground">
                  {department.id === "ceo-office" ? <Radio className="h-4 w-4" /> : <Network className="h-4 w-4" />}
                  <span className={cn("absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-background", STATUS_STYLES[status.tone])} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold">{department.name}</span>
                    {activeCount > 0 ? (
                      <span className="shrink-0 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                        {activeCount}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {latest?.turns.some((turn) => turn.content.trim()) ? latestSessionLine(latest) : department.description}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/55 transition-transform group-hover:translate-x-0.5" />
              </button>
            )
          })}
        </div>
      </div>

      <footer
        className="flex h-14 shrink-0 items-center gap-3 border-t border-border/50 bg-background px-3"
      >
        <Avatar className="h-8 w-8 border border-border/60">
          <AvatarImage src={user?.avatar || undefined} alt="" />
          <AvatarFallback>{initials(user?.name, user?.email)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{user?.name || user?.email || "SiraGPT"}</span>
        <button
          type="button"
          onClick={onToggleProactive}
          disabled={proactiveBusy}
          aria-pressed={proactiveOn}
          title={
            proactiveOn
              ? "Modo PROACTIVO ACTIVO (matrix.build-style). Clic para pausar."
              : "Activar PROACTIVO — empresa de agentes autónoma (matrix.build)"
          }
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            proactiveOn || snapshot.activeAgents > 0
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border/60 bg-muted/35 text-foreground/75 hover:bg-muted/60",
          )}
        >
          <Radio
            className={cn(
              "h-3.5 w-3.5",
              snapshot.activeAgents > 0 ? "text-sky-500" : proactiveOn ? "text-emerald-500" : "text-muted-foreground",
            )}
          />
          {snapshot.activeAgents > 0 ? "EN EJECUCIÓN" : proactiveOn ? "PROACTIVO · ON" : "PROACTIVO"}
        </button>
      </footer>
    </>
  )
}

function CompanyNavRow({
  icon: Icon,
  label,
  count,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-[18px] w-[18px] text-muted-foreground group-hover:text-foreground" />
      <span className="flex-1">{label}</span>
      {typeof count === "number" && count > 0 ? (
        <span className="text-xs font-semibold tabular-nums text-sky-500">{count}</span>
      ) : null}
      <ChevronRight className="h-4 w-4 text-muted-foreground/45" />
    </button>
  )
}

function ViewBody({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">{children}</div>
}

function DashboardView({
  snapshot,
  sessions,
  departmentCount,
  rootSessionId,
  onOpenTask,
}: {
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  sessions: CodeChatSession[]
  departmentCount: number
  rootSessionId: string | null
  onOpenTask: (sessionId: string) => void
}) {
  const metrics = [
    { label: "Agentes activos", value: snapshot.activeAgents, icon: Bot },
    { label: "Tareas", value: snapshot.taskCount, icon: ListTree },
    { label: "Archivos", value: snapshot.fileCount, icon: FileCode2 },
    { label: "Recursos", value: snapshot.resourceCount, icon: PackageOpen },
  ]
  return (
    <ViewBody>
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Panel operativo</h2>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div key={label} className="bg-background p-3">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <div className="mt-3 text-2xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground">Actividad reciente</h3>
        <span className="text-[11px] text-muted-foreground">{departmentCount} departamentos</span>
      </div>
      <div className="mt-2 divide-y divide-border/45">
        {[...sessions]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 8)
          .map((session) => {
            const status = codeSessionStatus(session)
            return (
              <button
                key={session.id}
                type="button"
                className="flex w-full items-center gap-3 py-3 text-left hover:text-foreground"
                onClick={() => onOpenTask(session.id)}
              >
                <span className={cn("h-2.5 w-2.5 rounded-full", STATUS_STYLES[status.tone])} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {session.id === rootSessionId ? "CEO Office" : session.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{status.label}</span>
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{relativeActivity(session.updatedAt)}</span>
              </button>
            )
          })}
      </div>
    </ViewBody>
  )
}

function ControlView({
  rootSessionId,
  sessions,
  activeSessionId,
  onOpenCeo,
  onOpenTask,
}: {
  rootSessionId: string | null
  sessions: CodeChatSession[]
  activeSessionId: string | null
  onOpenCeo: () => void
  onOpenTask: (sessionId: string) => void
}) {
  const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt)
  return (
    <ViewBody>
      <div className="flex items-center gap-2">
        <ListTree className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Árbol de tareas</h2>
      </div>
      <div className="mt-4">
        {ordered.map((session, index) => {
          const isRoot = session.id === rootSessionId
          const status = codeSessionStatus(session)
          return (
            <div key={session.id} className={cn("relative", !isRoot && "ml-5 border-l border-border/65 pl-4")}>
              {!isRoot ? <span className="absolute -left-px top-6 h-px w-4 bg-border" /> : null}
              <button
                type="button"
                className={cn(
                  "my-1 flex min-h-[54px] w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted/50",
                  session.id === activeSessionId && "bg-muted/45",
                )}
                onClick={isRoot ? onOpenCeo : () => onOpenTask(session.id)}
              >
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/55 bg-background">
                  {isRoot ? <Sparkles className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
                  <span className={cn("absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-background", STATUS_STYLES[status.tone])} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{isRoot ? "CEO Office" : session.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{status.label}</span>
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{index === 0 ? "Raíz" : relativeActivity(session.updatedAt)}</span>
              </button>
            </div>
          )
        })}
        {ordered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Sin tareas registradas.</div>
        ) : null}
      </div>
    </ViewBody>
  )
}

function DepartmentView({
  row,
  onOpenCeo,
}: {
  row: {
    department: AgentDepartmentDefinition
    sessions: CodeChatSession[]
    activeCount: number
    latest: CodeChatSession | null
  }
  onOpenCeo: () => void
}) {
  return (
    <ViewBody>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
          <Network className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{row.department.name}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.department.description}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-5 border-y border-border/45 py-3 text-xs">
        <span><strong className="font-semibold tabular-nums">{row.activeCount}</strong> activos</span>
        <span><strong className="font-semibold tabular-nums">{row.sessions.length}</strong> tareas</span>
      </div>
      <h3 className="mt-5 text-xs font-semibold text-muted-foreground">Trabajo asignado</h3>
      <div className="mt-2 divide-y divide-border/45">
        {row.sessions.map((session) => {
          const status = codeSessionStatus(session)
          return (
            <div key={session.id} className="flex items-start gap-3 py-3">
              <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", STATUS_STYLES[status.tone])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{session.title}</span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{latestSessionLine(session)}</span>
              </span>
              <span className="text-[10px] text-muted-foreground">{relativeActivity(session.updatedAt)}</span>
            </div>
          )
        })}
        {row.sessions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Sin tareas asignadas.</p>
        ) : null}
      </div>
      <Button type="button" className="mt-5 w-full" onClick={onOpenCeo}>
        Coordinar desde CEO Office
      </Button>
    </ViewBody>
  )
}

function TaskView({ session, onOpenCeo }: { session: CodeChatSession; onOpenCeo: () => void }) {
  const status = codeSessionStatus(session)
  const lastUser = [...session.turns].reverse().find((turn) => turn.role === "user")
  const lastAssistant = [...session.turns].reverse().find((turn) => turn.role === "assistant")
  return (
    <ViewBody>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{session.title}</h2>
          <span className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("h-2.5 w-2.5 rounded-full", STATUS_STYLES[status.tone])} />
            {status.label}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground">{relativeActivity(session.updatedAt)}</span>
      </div>
      <div className="mt-5 space-y-4 border-t border-border/45 pt-4">
        <section>
          <h3 className="text-[11px] font-semibold text-muted-foreground">Decisión más reciente</h3>
          <p className="mt-1 text-sm leading-relaxed">{lastUser?.content || "Sin instrucciones registradas."}</p>
        </section>
        <section>
          <h3 className="text-[11px] font-semibold text-muted-foreground">Resultado</h3>
          <p className="mt-1 line-clamp-[10] whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
            {lastAssistant?.content || "Pendiente."}
          </p>
        </section>
      </div>
      <Button type="button" className="mt-5 w-full" onClick={onOpenCeo}>
        Coordinar desde CEO Office
      </Button>
    </ViewBody>
  )
}
