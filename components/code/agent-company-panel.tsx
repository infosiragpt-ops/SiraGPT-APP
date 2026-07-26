"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Boxes,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  CircleDot,
  Clock3,
  Code2,
  Cpu,
  Download,
  ExternalLink,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Gauge,
  Languages,
  LayoutDashboard,
  Link2,
  ListTree,
  Loader2,
  Megaphone,
  MessageSquareText,
  Network,
  PackageOpen,
  PauseCircle,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UsersRound,
  Workflow,
  X,
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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useIsMobile } from "@/hooks/use-mobile"
import { subscribeAgentCompanyPreviewSlot } from "@/lib/agent-company-preview-slot"
import { subscribeAgentCompanySlot } from "@/lib/agent-company-slot"
import { buildAgentOfficeModel, type AgentOfficeWorker } from "@/lib/agent-office-model"
import {
  companySocialApi,
  type CompanySocialOperations,
  type CompanySocialPlatform,
  type CompanySocialPolicy,
  type CompanySocialPost,
} from "@/lib/company-social-api"
import {
  AGENT_COMPANY_DEPARTMENTS,
  agentCompanyDisplayName,
  buildAgentCompanySnapshot,
  codeRunActivityAt,
  codeRunIsActive,
  codeRunStatus,
  codeSessionIsActive,
  codeSessionStatus,
  departmentIdForRun,
  departmentIdForSession,
  type AgentCompanyRunLike,
  type AgentDepartmentDefinition,
} from "@/lib/code-agent-company"
import {
  buildProactiveKickoffPrompt,
  departmentBootstrapTitle,
  focusCeoChatColumn,
  hydrateProactiveCompany,
  PROACTIVE_CORE_DEPARTMENTS,
  requestProactiveSeedPrompt,
  setProactiveCompanyEnabled,
} from "@/lib/code-agent-company-proactive"
import type { CodeChatSession } from "@/lib/code-chat-sessions"
import type { CodeFile, CodeFiles } from "@/lib/code-workspace-utils"
import { useAuth } from "@/lib/auth-context-integrated"
import { codexIdForProject, listCodexProjects, upsertCodexProject } from "@/lib/codex-projects"
import {
  CODE_ACTIVE_CODEX_PROJECT_EVENT,
  CODE_NEW_CODE_CHAT_EVENT,
  getActiveCodexProject,
  setActiveCodexProject,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import {
  codexApi,
  type CodexAccess,
  type CodexProactiveState,
  type CodexRun,
} from "@/lib/codex/codex-api"
import {
  clearSessionCodexProject,
  clearWorkspaceCodexProject,
  linkedCodexProject,
  persistWorkspaceCodexProject,
  readWorkspaceCodexProject,
} from "@/lib/codex/codex-project-link"
import { projectsService, type Project } from "@/lib/projects-service"
import { cn } from "@/lib/utils"

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { AgentOfficeOverlay } from "./agent-office/agent-office-overlay"
import { AgentOfficeScene } from "./agent-office/agent-office-scene"

type CompanyView = "home" | "chat" | "dashboard" | "control" | "department" | "files" | "resources" | "task"
type CompanyPreviewView = Exclude<CompanyView, "home" | "chat" | "department">

type CompanyOption = {
  id: string
  projectId?: string
  name: string
  kind: "project" | "local-folder"
}

type CustomDepartment = AgentDepartmentDefinition & { custom: true }

const CUSTOM_DEPARTMENTS_KEY = "code-workspace:agent-company-departments:v1"

const STATUS_STYLES = {
  idle: "bg-zinc-300 dark:bg-zinc-600",
  active: "bg-sky-500",
  ready: "bg-emerald-500",
  attention: "bg-amber-500",
} as const

const DEPARTMENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "ceo-office": Radio,
  "agent-infrastructure": Cpu,
  "growth-engines": TrendingUp,
  localization: Languages,
  integrations: PlugZap,
  trust: ShieldCheck,
  "product-engineering": Boxes,
  "engineering-01": Code2,
  marketing: Megaphone,
  "engineering-02": Workflow,
}

const EMPTY_PROACTIVE_STATE: CodexProactiveState = {
  enabled: false,
  enabledAt: null,
  dayKey: null,
  runsToday: 0,
  deptIndex: 0,
  lastCycleAt: null,
  lastError: null,
}

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

function relativeActivityFromDate(value?: string | null): string {
  if (!value) return ""
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? relativeActivity(timestamp) : ""
}

function latestSessionLine(session: CodeChatSession): string {
  const lastTurn = [...session.turns].reverse().find((turn) => turn.content.trim())
  if (!lastTurn) return session.title
  const line = lastTurn.content.replace(/\s+/g, " ").trim()
  return line.length > 76 ? `${line.slice(0, 76)}…` : line
}

function runActivityAt(run: AgentCompanyRunLike): number {
  return codeRunActivityAt(run) || Date.now()
}

function runSummary(run: AgentCompanyRunLike): string {
  const prompt = String(run.prompt || "")
    .replace(/^\s*\[PROACTIVO\s*·\s*[^\]]+\]\s*/i, "")
    .trim()
  const line = (prompt || run.error || "Trabajo del agente").replace(/\s+/g, " ").trim()
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

function runTitle(run: AgentCompanyRunLike): string {
  const summary = runSummary(run)
  const separator = summary.indexOf(":")
  return (separator > 0 ? summary.slice(0, separator) : summary).slice(0, 64)
}

function DepartmentGlyph({ departmentId, className }: { departmentId: string; className?: string }) {
  const Icon = DEPARTMENT_ICONS[departmentId] || Network
  return <Icon className={className} />
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
  const isMobile = useIsMobile()
  const [dockSlot, setDockSlot] = React.useState<HTMLElement | null>(null)
  const [previewSlot, setPreviewSlot] = React.useState<HTMLElement | null>(null)
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
  const [previewView, setPreviewView] = React.useState<CompanyPreviewView | null>(null)
  const [selectedDepartmentId, setSelectedDepartmentId] = React.useState("ceo-office")
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null)
  const [officeOpen, setOfficeOpen] = React.useState(false)
  const [companyMenuOpen, setCompanyMenuOpen] = React.useState(false)
  const [projects, setProjects] = React.useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = React.useState(false)
  const [newCompanyOpen, setNewCompanyOpen] = React.useState(false)
  const [newCompanyName, setNewCompanyName] = React.useState("")
  const [creatingCompany, setCreatingCompany] = React.useState(false)
  const [newDepartmentOpen, setNewDepartmentOpen] = React.useState(false)
  const [newDepartmentName, setNewDepartmentName] = React.useState("")
  const [customDepartments, setCustomDepartments] = React.useState<CustomDepartment[]>([])
  const [proactiveOn, setProactiveOn] = React.useState(false)
  const [proactiveBusy, setProactiveBusy] = React.useState(false)
  const [proactiveState, setProactiveState] = React.useState<CodexProactiveState>(EMPTY_PROACTIVE_STATE)
  const [codexRuns, setCodexRuns] = React.useState<CodexRun[]>([])
  const [checkpointCount, setCheckpointCount] = React.useState(0)
  const [codexAccess, setCodexAccess] = React.useState<CodexAccess | null>(null)
  const companyRuntimePromisesRef = React.useRef<Map<string, Promise<string>>>(new Map())
  const proactiveMutationVersionRef = React.useRef(0)

  React.useEffect(() => {
    let alive = true
    let refreshing = false
    let refreshRequested = false
    const hydrated = hydrateProactiveCompany(activeFolder?.id)
    setProactiveOn(hydrated.enabled)

    const load = async () => {
      if (refreshing) {
        refreshRequested = true
        return
      }
      refreshing = true
      const mutationVersion = proactiveMutationVersionRef.current
      const codexProjectId = getActiveCodexProject()
      try {
        if (!codexProjectId) {
          const access = await codexApi.access().catch(() => null)
          if (!alive) return
          setCodexAccess(access)
          setCodexRuns([])
          setCheckpointCount(0)
          setProactiveState(EMPTY_PROACTIVE_STATE)
          return
        }

        const [accessResult, proactiveResult, runsResult, checkpointsResult] = await Promise.allSettled([
          codexApi.access(),
          codexApi.getProactive(codexProjectId),
          codexApi.listRuns(codexProjectId),
          codexApi.listCheckpoints(codexProjectId),
        ])
        if (!alive) return
        if (accessResult.status === "fulfilled") setCodexAccess(accessResult.value)
        if (runsResult.status === "fulfilled") setCodexRuns(runsResult.value)
        if (checkpointsResult.status === "fulfilled") setCheckpointCount(checkpointsResult.value.length)
        if (
          proactiveResult.status === "fulfilled" &&
          mutationVersion === proactiveMutationVersionRef.current
        ) {
          const nextState = proactiveResult.value.state || EMPTY_PROACTIVE_STATE
          const enabled = Boolean(nextState.enabled)
          setProactiveState(nextState)
          setProactiveOn(enabled)
          setProactiveCompanyEnabled(enabled, { workspaceId: activeFolder?.id || null })
        }
      } finally {
        refreshing = false
        if (refreshRequested && alive) {
          refreshRequested = false
          void load()
        }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load()
    }
    const onActiveCodexProject = () => void load()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, onActiveCodexProject)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener(CODE_ACTIVE_CODEX_PROJECT_EVENT, onActiveCodexProject)
    }
  }, [activeFolder?.id])

  React.useEffect(() => subscribeAgentCompanySlot(setDockSlot), [])
  React.useEffect(() => subscribeAgentCompanyPreviewSlot(setPreviewSlot), [])
  const dockedInAppsRail = !isMobile && Boolean(dockSlot)
  const chatLivesInWorkspaceColumn = dockedInAppsRail

  const snapshot = React.useMemo(
    () => buildAgentCompanySnapshot(codeChatSessions, files, codexRuns),
    [codeChatSessions, codexRuns, files],
  )
  const companyName = agentCompanyDisplayName(activeFolder?.name)
  const allDepartments = React.useMemo(
    () => [...AGENT_COMPANY_DEPARTMENTS, ...customDepartments],
    [customDepartments],
  )

  React.useEffect(() => {
    setCustomDepartments(readCustomDepartments(activeFolder?.id))
    setView("home")
    setPreviewView(null)
    setSelectedTaskId(null)
    setOfficeOpen(false)
  }, [activeFolder?.id])

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("companyView") === "resources" || params.has("social")) {
      if (isMobile) setView("resources")
      else if (dockedInAppsRail && previewSlot) setPreviewView("resources")
    }
  }, [dockedInAppsRail, isMobile, previewSlot])

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
      const runs = codexRuns.filter(
        (run) => departmentIdForRun(run, allDepartments) === department.id,
      )
      const activeRunCount = runs.filter(codeRunIsActive).length
      const activeSessionCount = sessions.filter(codeSessionIsActive).length
      const activeCount = runs.length > 0 ? activeRunCount : activeSessionCount
      const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
      const latestRun = [...runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))[0] || null
      return { department, sessions, runs, activeCount, latest, latestRun }
    })
  }, [allDepartments, codeChatSessions, codexRuns, snapshot.rootSessionId])

  const selectedDepartment = departmentRows.find((row) => row.department.id === selectedDepartmentId) || null
  const selectedTask = codeChatSessions.find((session) => session.id === selectedTaskId) || null
  const officeModel = React.useMemo(
    () =>
      buildAgentOfficeModel({
        departments: allDepartments,
        sessions: codeChatSessions,
        runs: codexRuns,
        rootSessionId: snapshot.rootSessionId,
      }),
    [allDepartments, codeChatSessions, codexRuns, snapshot.rootSessionId],
  )

  const openCompanySurface = React.useCallback((nextView: CompanyPreviewView) => {
    if (dockedInAppsRail && previewSlot) {
      setPreviewView(nextView)
      return
    }
    setView(nextView)
  }, [dockedInAppsRail, previewSlot])

  const ensureCompanyRuntime = React.useCallback(
    ({
      workspaceId = activeFolder?.id || null,
      name = companyName,
    }: {
      workspaceId?: string | null
      name?: string
    } = {}) => {
      if (!workspaceId) {
        return Promise.reject(new Error("Selecciona o crea una empresa antes de iniciar el runtime."))
      }

      const pending = companyRuntimePromisesRef.current.get(workspaceId)
      if (pending) return pending

      const task = (async () => {
        const access = codexAccess?.canRun ? codexAccess : await codexApi.access()
        setCodexAccess(access)
        if (!access.canRun) {
          throw Object.assign(
            new Error("Esta cuenta todavía no está autorizada para ejecutar agentes en producción."),
            { status: 403 },
          )
        }

        const linkedProjectId = linkedCodexProject({
          workspaceId,
          sessionId: workspaceId === activeFolder?.id ? activeCodeChatSessionId : null,
        })
        if (linkedProjectId) {
          try {
            const linkedProject = await codexApi.getProject(linkedProjectId)
            if (linkedProject.status === "ready") {
              persistWorkspaceCodexProject(workspaceId, linkedProject.id)
              setActiveCodexProject(linkedProject.id)
              return linkedProject.id
            }
          } catch {
            // The linked project was removed or belongs to another session.
          }
          if (workspaceId === activeFolder?.id) {
            clearSessionCodexProject(activeCodeChatSessionId)
          }
          clearWorkspaceCodexProject(workspaceId)
        }

        const project = await codexApi.createProject(
          `${name.slice(0, 64)} · Empresa`,
          [
            `Empresa autónoma: ${name}.`,
            "CEO Office coordina los departamentos para construir y mantener software real.",
            "Conserva archivos, ejecuta verificaciones y entrega evidencia antes de publicar.",
          ].join(" "),
        )
        if (project.status !== "ready") {
          throw new Error(project.error || "El runtime de la empresa no quedó listo.")
        }

        persistWorkspaceCodexProject(workspaceId, project.id)
        setActiveCodexProject(project.id)
        return project.id
      })().finally(() => {
        companyRuntimePromisesRef.current.delete(workspaceId)
      })

      companyRuntimePromisesRef.current.set(workspaceId, task)
      return task
    },
    [activeCodeChatSessionId, activeFolder?.id, codexAccess, companyName],
  )

  const openCeoOffice = React.useCallback(() => {
    let rootSessionId = codeChatSessions.find(
      (session) => session.title.trim().toLowerCase() === "ceo office",
    )?.id
    if (!rootSessionId) rootSessionId = createCodeChatSession({ title: "CEO Office" })
    setActiveCodeChatSession(rootSessionId)
    if (chatLivesInWorkspaceColumn) {
      setView("home")
      focusCeoChatColumn()
      return
    }
    setView("chat")
  }, [
    chatLivesInWorkspaceColumn,
    createCodeChatSession,
    codeChatSessions,
    setActiveCodeChatSession,
  ])

  const openDepartmentChat = React.useCallback((departmentId: string) => {
    if (departmentId === "ceo-office") {
      openCeoOffice()
      return
    }
    const department = allDepartments.find((entry) => entry.id === departmentId)
    if (!department) return
    const title = departmentBootstrapTitle(department)
    let sessionId = codeChatSessions.find(
      (session) => session.title.trim().toLowerCase() === title.toLowerCase(),
    )?.id
    if (!sessionId) sessionId = createCodeChatSession({ title })
    setSelectedDepartmentId(departmentId)
    setActiveCodeChatSession(sessionId)
    if (chatLivesInWorkspaceColumn) {
      setView("home")
      focusCeoChatColumn()
    } else {
      setView("chat")
    }
  }, [
    allDepartments,
    chatLivesInWorkspaceColumn,
    codeChatSessions,
    createCodeChatSession,
    openCeoOffice,
    setActiveCodeChatSession,
  ])

  const openOfficeWorker = React.useCallback((worker: AgentOfficeWorker) => {
    setOfficeOpen(false)
    if (worker.sessionId) {
      setActiveCodeChatSession(worker.sessionId)
      if (chatLivesInWorkspaceColumn) {
        setView("home")
        focusCeoChatColumn()
      } else {
        setView("chat")
      }
      return
    }
    setSelectedDepartmentId(worker.departmentId)
    setView("department")
  }, [chatLivesInWorkspaceColumn, setActiveCodeChatSession])

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
    let codexProjectId =
      readWorkspaceCodexProject(activeFolder?.id) ||
      getActiveCodexProject()

    const openCompanyLoop = () => {
      const rootSessionId = ensureDepartmentSessions()
      setActiveCodeChatSession(rootSessionId)
      if (chatLivesInWorkspaceColumn) {
        setView("home")
        focusCeoChatColumn()
      } else {
        setView("chat")
      }
      window.setTimeout(
        () => requestProactiveSeedPrompt(buildProactiveKickoffPrompt(companyName)),
        120,
      )
    }

    if (!codexProjectId && !next) {
      setProactiveOn(false)
      setProactiveCompanyEnabled(false, { workspaceId: activeFolder?.id || null })
      toast.info("Modo PROACTIVO pausado.")
      return
    }

    if (next && codexAccess?.canRun === false) {
      toast.error("La ejecución está protegida. Un administrador debe habilitar este workspace en un runtime aislado.")
      return
    }

    setProactiveBusy(true)
    proactiveMutationVersionRef.current += 1
    try {
      if (!codexProjectId) {
        codexProjectId = await ensureCompanyRuntime()
      }
      const r = await codexApi.setProactive(codexProjectId, next)
      const enabled = Boolean(r.state?.enabled)
      proactiveMutationVersionRef.current += 1
      setProactiveState(r.state || EMPTY_PROACTIVE_STATE)
      setProactiveOn(enabled)
      setProactiveCompanyEnabled(enabled, { workspaceId: activeFolder?.id || null })
      if (enabled) openCompanyLoop()
      toast.success(
        enabled
          ? "Modo PROACTIVO activado — la empresa de agentes opera de forma autónoma."
          : "Modo PROACTIVO desactivado.",
      )
    } catch (error) {
      const status = (error as { status?: number })?.status
      toast.error(
        status === 403
          ? "Esta cuenta no está autorizada para ejecutar agentes en producción."
          : "No se pudo preparar el runtime de la empresa. El panel conserva el último estado confirmado.",
      )
    } finally {
      setProactiveBusy(false)
    }
  }, [
    activeFolder?.id,
    codexAccess?.canRun,
    companyName,
    chatLivesInWorkspaceColumn,
    ensureDepartmentSessions,
    ensureCompanyRuntime,
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
      let runtimeReady = false
      try {
        await ensureCompanyRuntime({ workspaceId: project.id, name: project.name })
        runtimeReady = true
      } catch (error) {
        const message = error instanceof Error ? error.message : "El runtime no pudo prepararse."
        toast.warning(`La empresa se creó, pero su runtime está pendiente: ${message}`)
      }
      upsertCodexProject({ id: codexIdForProject(project.id), name: project.name, kind: "project" })
      await switchCodexWorkspace({
        id: codexIdForProject(project.id),
        name: project.name,
        kind: "project",
        projectId: project.id,
      })
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(CODE_NEW_CODE_CHAT_EVENT, {
            detail: {
              workspaceId: project.id,
              name: project.name,
              kind: "project",
              projectId: project.id,
              title: "CEO Office",
            },
          }),
        )
      }, 0)
      setNewCompanyName("")
      setNewCompanyOpen(false)
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
      if (runtimeReady) toast.success("Empresa creada con CEO Office y runtime operativo.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo crear la empresa.")
    } finally {
      setCreatingCompany(false)
    }
  }, [creatingCompany, ensureCompanyRuntime, newCompanyName, switchCodexWorkspace])

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
  const panel = (
    <div
      className={cn(
        "relative h-full min-h-0 overflow-hidden bg-background text-foreground",
        !dockedInAppsRail && "border-r border-border/50",
      )}
      data-agent-company-dock={dockedInAppsRail ? "apps" : "workspace"}
      data-proactive={proactiveOn ? "on" : "off"}
    >
      {!chatLivesInWorkspaceColumn ? (
        <div className={cn("absolute inset-0", view === "chat" ? "block" : "invisible pointer-events-none")}>
          <AICodeChatPanel
            embedded
            onBack={() => setView("home")}
            proactive={proactiveOn}
          />
        </div>
      ) : null}

      <div
        className={cn(
          "flex h-full min-h-0 flex-col",
          !chatLivesInWorkspaceColumn && view === "chat" && "invisible pointer-events-none",
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
                data-testid="agent-company-switcher"
              >
                <span className="truncate text-[17px] font-semibold">{companyName}</span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={8}
              className="isolate w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-lg border border-white/80 bg-white/90 p-0 shadow-[0_24px_70px_-34px_rgba(15,23,42,0.45)] ring-1 ring-black/[0.04] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/90 dark:ring-white/[0.06]"
              data-testid="agent-company-menu"
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
            officeModel={officeModel}
            officeOpen={officeOpen}
            snapshot={snapshot}
            departmentRows={departmentRows}
            onOpenOffice={() => setOfficeOpen(true)}
            activePreviewView={previewView}
            onOpenDashboard={() => openCompanySurface("dashboard")}
            onOpenControl={() => openCompanySurface("control")}
            onOpenFiles={() => openCompanySurface("files")}
            onOpenResources={() => openCompanySurface("resources")}
            onOpenDepartment={openDepartmentChat}
            onAddDepartment={() => setNewDepartmentOpen(true)}
            user={user}
            hideFooter={dockedInAppsRail}
            proactiveOn={proactiveOn}
            proactiveBusy={proactiveBusy}
            proactiveState={proactiveState}
            canRun={codexAccess?.canRun ?? null}
            onToggleProactive={() => void toggleProactive()}
          />
        ) : view === "dashboard" ? (
          <DashboardView
            surface={isMobile}
            companyName={companyName}
            snapshot={snapshot}
            sessions={codeChatSessions}
            runs={codexRuns}
            checkpointCount={checkpointCount}
            proactiveState={proactiveState}
            departmentCount={allDepartments.length}
            rootSessionId={snapshot.rootSessionId}
            onOpenTask={(sessionId) => {
              setSelectedTaskId(sessionId)
              setView("task")
            }}
          />
        ) : view === "control" ? (
          <ControlView
            surface={isMobile}
            companyName={companyName}
            rootSessionId={snapshot.rootSessionId}
            sessions={codeChatSessions}
            runs={codexRuns}
            checkpointCount={checkpointCount}
            proactiveState={proactiveState}
            departments={allDepartments}
            activeSessionId={activeCodeChatSessionId}
            onOpenCeo={openCeoOffice}
            onOpenTask={(sessionId) => {
              setSelectedTaskId(sessionId)
              setView("task")
            }}
          />
        ) : view === "files" ? (
          <FilesView
            surface={isMobile}
            companyName={companyName}
            files={files}
            sessions={codeChatSessions}
            departments={allDepartments}
          />
        ) : view === "resources" ? (
          <ResourcesView
            surface={isMobile}
            companyName={companyName}
            workspaceId={activeFolder?.id || null}
            onOpenCeo={openCeoOffice}
          />
        ) : view === "department" && selectedDepartment ? (
          <DepartmentView row={selectedDepartment} onOpenCeo={openCeoOffice} />
        ) : view === "task" && selectedTask ? (
          <TaskView surface={isMobile} session={selectedTask} onOpenCeo={openCeoOffice} />
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

      <AgentOfficeOverlay
        open={officeOpen}
        companyName={companyName}
        model={officeModel}
        onClose={() => setOfficeOpen(false)}
        onOpenWorker={openOfficeWorker}
      />
    </div>
  )

  const previewSurface = previewSlot && previewView ? createPortal(
    <CompanyPreviewSurface
      companyName={companyName}
      view={previewView}
      onClose={() => setPreviewView(null)}
    >
      {previewView === "dashboard" ? (
        <DashboardView
          surface
          companyName={companyName}
          snapshot={snapshot}
          sessions={codeChatSessions}
          runs={codexRuns}
          checkpointCount={checkpointCount}
          proactiveState={proactiveState}
          departmentCount={allDepartments.length}
          rootSessionId={snapshot.rootSessionId}
          onOpenTask={(sessionId) => {
            setSelectedTaskId(sessionId)
            setPreviewView("task")
          }}
        />
      ) : previewView === "control" ? (
        <ControlView
          surface
          companyName={companyName}
          rootSessionId={snapshot.rootSessionId}
          sessions={codeChatSessions}
          runs={codexRuns}
          checkpointCount={checkpointCount}
          proactiveState={proactiveState}
          departments={allDepartments}
          activeSessionId={activeCodeChatSessionId}
          onOpenCeo={() => {
            setPreviewView(null)
            openCeoOffice()
          }}
          onOpenTask={(sessionId) => {
            setSelectedTaskId(sessionId)
            setPreviewView("task")
          }}
        />
      ) : previewView === "files" ? (
        <FilesView
          surface
          companyName={companyName}
          files={files}
          sessions={codeChatSessions}
          departments={allDepartments}
        />
      ) : previewView === "resources" ? (
        <ResourcesView
          surface
          companyName={companyName}
          workspaceId={activeFolder?.id || null}
          onOpenCeo={() => {
            setPreviewView(null)
            openCeoOffice()
          }}
        />
      ) : previewView === "task" && selectedTask ? (
        <TaskView
          surface
          session={selectedTask}
          onOpenCeo={() => {
            setPreviewView(null)
            openCeoOffice()
          }}
        />
      ) : null}
    </CompanyPreviewSurface>,
    previewSlot,
  ) : null

  if (dockedInAppsRail && dockSlot) {
    return (
      <>
        {createPortal(panel, dockSlot)}
        {previewSurface}
      </>
    )
  }
  if (!isMobile) return null
  return panel
}

const COMPANY_VIEW_LABELS: Record<CompanyPreviewView, string> = {
  dashboard: "Panel",
  control: "Controlar",
  files: "Archivos",
  resources: "Recursos",
  task: "Detalle",
}

function CompanyPreviewSurface({
  companyName,
  view,
  onClose,
  children,
}: {
  companyName: string
  view: CompanyPreviewView
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <section
      className="absolute inset-0 flex min-h-0 flex-col bg-[#fbfbfa] text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50"
      data-testid="agent-company-preview-surface"
      data-company-view={view}
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200/75 bg-white/95 px-4 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/95">
        <span className="truncate text-[13px] font-semibold">{companyName}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="truncate text-[13px] text-zinc-600 dark:text-zinc-300">
          {COMPANY_VIEW_LABELS[view]}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto h-9 w-9 rounded-md"
          onClick={onClose}
          aria-label="Cerrar vista de empresa"
          title="Volver al preview de la app"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  )
}

function CompanyHome({
  companyName,
  officeModel,
  officeOpen,
  snapshot,
  departmentRows,
  activePreviewView,
  onOpenOffice,
  onOpenDashboard,
  onOpenControl,
  onOpenFiles,
  onOpenResources,
  onOpenDepartment,
  onAddDepartment,
  user,
  hideFooter = false,
  proactiveOn,
  proactiveBusy,
  proactiveState,
  canRun,
  onToggleProactive,
}: {
  companyName: string
  officeModel: ReturnType<typeof buildAgentOfficeModel>
  officeOpen: boolean
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  departmentRows: Array<{
    department: AgentDepartmentDefinition
    sessions: CodeChatSession[]
    runs: CodexRun[]
    activeCount: number
    latest: CodeChatSession | null
    latestRun: CodexRun | null
  }>
  activePreviewView: CompanyPreviewView | null
  onOpenOffice: () => void
  onOpenDashboard: () => void
  onOpenControl: () => void
  onOpenFiles: () => void
  onOpenResources: () => void
  onOpenDepartment: (departmentId: string) => void
  onAddDepartment: () => void
  user: ReturnType<typeof useAuth>["user"]
  hideFooter?: boolean
  proactiveOn: boolean
  proactiveBusy: boolean
  proactiveState: CodexProactiveState
  canRun: boolean | null
  onToggleProactive: () => void
}) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
        <button
          type="button"
          onClick={onOpenOffice}
          className="group relative block aspect-[16/9] w-full overflow-hidden rounded-lg border border-zinc-300/70 bg-[#dce5e9] text-left shadow-[0_12px_30px_-22px_rgba(15,23,42,0.7)] transition-shadow hover:shadow-[0_16px_34px_-20px_rgba(15,23,42,0.72)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Abrir oficina de agentes"
          data-testid="agent-company-live-preview"
        >
          <div className="pointer-events-none absolute inset-0">
            <AgentOfficeScene model={officeModel} variant="thumbnail" paused={officeOpen} />
          </div>
          <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-md border border-white/70 bg-white/[0.9] px-2.5 py-1 text-[11px] font-semibold text-zinc-800 shadow-sm backdrop-blur-xl">
            <span className={cn("h-2 w-2 rounded-full", officeModel.activeCount > 0 ? "bg-sky-400" : "bg-zinc-400")} />
            Oficina · {officeModel.activeCount} {officeModel.activeCount === 1 ? "activo" : "activos"}
          </span>
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-zinc-950/[0.78] px-3 py-2 text-white opacity-100 backdrop-blur-sm transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100">
            <span className="truncate text-[11px] font-medium">Entrar a la sede de {companyName}</span>
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>

        {proactiveOn || proactiveState.lastError ? (
          <div
            className="mt-2 flex min-h-9 items-center gap-2 border-y border-border/45 px-2 py-2 text-[11px]"
            role="status"
            aria-live="polite"
          >
            <Workflow className={cn("h-3.5 w-3.5 shrink-0", proactiveState.lastError ? "text-amber-500" : "text-emerald-500")} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {proactiveState.lastError
                ? `Ciclo en revisión: ${proactiveState.lastError}`
                : `Ciclo autónomo activo · ${proactiveState.runsToday} ejecuciones hoy`}
            </span>
            {proactiveState.lastCycleAt ? (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {relativeActivityFromDate(proactiveState.lastCycleAt)}
              </span>
            ) : null}
          </div>
        ) : null}

        <nav
          aria-label="Herramientas de la empresa"
          className={cn("space-y-0.5", hideFooter ? "mt-2" : "mt-3")}
        >
          <CompanyNavRow compact={hideFooter} active={activePreviewView === "dashboard"} icon={LayoutDashboard} label="Panel" onClick={onOpenDashboard} />
          <CompanyNavRow compact={hideFooter} active={activePreviewView === "control"} icon={ListTree} label="Controlar" count={snapshot.taskCount} onClick={onOpenControl} />
          <CompanyNavRow compact={hideFooter} active={activePreviewView === "files"} icon={FolderOpen} label="Archivos" count={snapshot.fileCount} onClick={onOpenFiles} />
          <CompanyNavRow compact={hideFooter} active={activePreviewView === "resources"} icon={BriefcaseBusiness} label="Recursos" count={snapshot.resourceCount} onClick={onOpenResources} />
        </nav>

        <div className={cn("flex items-center justify-between px-2", hideFooter ? "mt-3" : "mt-4")}>
          <h2 className="text-xs font-semibold text-muted-foreground">Departamentos</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "rounded-md text-muted-foreground hover:text-foreground",
              hideFooter ? "h-8 w-8" : "h-9 w-9",
            )}
            onClick={onAddDepartment}
            aria-label="Añadir departamento"
            title="Añadir departamento"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-1 space-y-0.5">
          {departmentRows.map(({ department, activeCount, latest, latestRun }) => {
            const status = latestRun
              ? codeRunStatus(latestRun)
              : latest
                ? codeSessionStatus(latest)
                : { label: "Disponible", tone: "idle" as const }
            return (
              <button
                key={department.id}
                type="button"
                className={cn(
                  "group flex min-h-[58px] w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  hideFooter && "min-h-[46px] gap-2 rounded-md px-2 py-1.5",
                  department.id === "ceo-office" && "bg-muted/50",
                )}
                onClick={() => onOpenDepartment(department.id)}
                data-testid={`agent-company-department-${department.id}`}
              >
                <span
                  className={cn(
                    "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/55 bg-muted/40 text-muted-foreground",
                    hideFooter && "h-8 w-8",
                  )}
                >
                  <DepartmentGlyph departmentId={department.id} className={hideFooter ? "h-3.5 w-3.5" : "h-4 w-4"} />
                  <span
                    className={cn(
                      "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-background",
                      hideFooter && "h-2 w-2",
                      STATUS_STYLES[status.tone],
                    )}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={cn("truncate text-[13px] font-semibold", hideFooter && "text-[11px]")}>
                      {department.name}
                    </span>
                    {activeCount > 0 ? (
                      <span className={cn(
                        "shrink-0 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
                        hideFooter && "text-[9px]",
                      )}>
                        {activeCount}
                      </span>
                    ) : null}
                  </span>
                  <span className={cn(
                    "mt-0.5 block truncate text-[11px] text-muted-foreground",
                    hideFooter && "text-[9px] leading-3",
                  )}>
                    {latestRun
                      ? runSummary(latestRun)
                      : latest?.turns.some((turn) => turn.content.trim())
                        ? latestSessionLine(latest)
                        : department.description}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/55 transition-transform group-hover:translate-x-0.5" />
              </button>
            )
          })}
        </div>
      </div>

      <footer
        className={cn(
          "flex h-14 shrink-0 items-center gap-3 border-t border-border/50 bg-background px-3",
          hideFooter && "justify-end",
        )}
      >
        {!hideFooter ? (
          <>
            <Avatar className="h-8 w-8 border border-border/60">
              <AvatarImage src={user?.avatar || undefined} alt="" />
              <AvatarFallback>{initials(user?.name, user?.email)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{user?.name || user?.email || "SiraGPT"}</span>
          </>
        ) : null}
        <button
          type="button"
          onClick={onToggleProactive}
          disabled={proactiveBusy}
          aria-pressed={proactiveOn}
          title={
            canRun === false && !proactiveOn
              ? "Ejecución protegida: requiere un runtime aislado o autorización administrativa."
              : proactiveOn
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
          {canRun === false && !proactiveOn ? (
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Radio
              className={cn(
                "h-3.5 w-3.5",
                snapshot.activeAgents > 0 ? "text-sky-500" : proactiveOn ? "text-emerald-500" : "text-muted-foreground",
              )}
            />
          )}
          {snapshot.activeAgents > 0
            ? "EN EJECUCIÓN"
            : proactiveOn
              ? "PROACTIVO · ON"
              : canRun === false
                ? "PROTEGIDO"
                : "PROACTIVO"}
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
  compact = false,
  active = false,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count?: number
  onClick: () => void
  compact?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact && "h-8 gap-2 rounded-md px-2 text-xs",
        active && "bg-muted/65 text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={cn(
        "h-[18px] w-[18px] text-muted-foreground group-hover:text-foreground",
        compact && "h-3.5 w-3.5",
      )} />
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

const SOCIAL_PROVIDER_MARKS: Record<CompanySocialPlatform, { mark: string; className: string }> = {
  facebook: { mark: "f", className: "bg-[#1877f2] text-white" },
  linkedin: { mark: "in", className: "bg-[#0a66c2] text-white" },
  x: { mark: "X", className: "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950" },
}

function ResourcesView({
  companyName,
  workspaceId,
  onOpenCeo,
  surface = false,
}: {
  companyName: string
  workspaceId: string | null
  onOpenCeo: () => void
  surface?: boolean
}) {
  const [operations, setOperations] = React.useState<CompanySocialOperations | null>(null)
  const [posts, setPosts] = React.useState<CompanySocialPost[]>([])
  const [draft, setDraft] = React.useState<CompanySocialPolicy | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [providerBusy, setProviderBusy] = React.useState<CompanySocialPlatform | null>(null)
  const [caption, setCaption] = React.useState("")
  const [selectedPlatforms, setSelectedPlatforms] = React.useState<CompanySocialPlatform[]>([])
  const [delivery, setDelivery] = React.useState<"now" | "scheduled">("now")
  const [scheduledAt, setScheduledAt] = React.useState("")
  const [postBusy, setPostBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [result, queuedPosts] = await Promise.all([
        companySocialApi.operations(),
        companySocialApi.listPosts().catch(() => []),
      ])
      setOperations(result)
      setPosts(queuedPosts)
      setDraft({ ...result.policy, workspaceId })
      setSelectedPlatforms((current) => {
        const connected = result.providers
          .filter((provider) => provider.connection?.connected && provider.supports.text)
          .map((provider) => provider.platform)
        const retained = current.filter((platform) => connected.includes(platform))
        return retained.length ? retained : connected
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudieron cargar los recursos.")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get("social")
    const platform = params.get("platform")
    if (status === "connected") toast.success(`${platform || "La cuenta"} quedó conectada.`)
    else if (status === "page_required") toast.error("Facebook no devolvió una página con permiso para publicar.")
    else if (status && status !== "connected") toast.error("No se pudo completar la conexión social.")
    if (status || params.has("companyView")) {
      params.delete("social")
      params.delete("platform")
      params.delete("companyView")
      const query = params.toString()
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`)
    }
  }, [])

  const patchDraft = React.useCallback((patch: Partial<CompanySocialPolicy>) => {
    setDraft((current) => current ? { ...current, ...patch } : current)
  }, [])

  const patchPlatform = React.useCallback((platform: CompanySocialPlatform, enabled: boolean) => {
    setDraft((current) => current
      ? { ...current, platforms: { ...current.platforms, [platform]: enabled } }
      : current)
  }, [])

  const save = React.useCallback(async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      const policy = await companySocialApi.updatePolicy({
        ...draft,
        workspaceId,
        confirmAutopublish: draft.enabled && (draft.mode === "auto" || draft.autopilot),
      })
      setDraft(policy)
      setOperations((current) => current ? { ...current, policy } : current)
      toast.success(policy.enabled ? "Operación social actualizada." : "Publicación autónoma pausada.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo guardar la operación.")
    } finally {
      setSaving(false)
    }
  }, [draft, saving, workspaceId])

  const pause = React.useCallback(async () => {
    if (!draft || saving) return
    setSaving(true)
    try {
      const policy = await companySocialApi.updatePolicy({
        ...draft,
        enabled: false,
        autopilot: false,
        workspaceId,
      })
      setDraft(policy)
      setOperations((current) => current ? { ...current, policy } : current)
      toast.success("Publicación autónoma detenida.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo detener la publicación.")
    } finally {
      setSaving(false)
    }
  }, [draft, saving, workspaceId])

  const connect = React.useCallback(async (platform: CompanySocialPlatform) => {
    setProviderBusy(platform)
    try {
      const result = await companySocialApi.connectUrl(platform)
      window.location.assign(result.url)
    } catch (error) {
      setProviderBusy(null)
      toast.error(error instanceof Error ? error.message : "No se pudo iniciar la conexión.")
    }
  }, [])

  const disconnect = React.useCallback(async (platform: CompanySocialPlatform) => {
    setProviderBusy(platform)
    try {
      await companySocialApi.disconnect(platform)
      toast.success("Cuenta desconectada.")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo desconectar la cuenta.")
    } finally {
      setProviderBusy(null)
    }
  }, [load])

  const toggleComposerPlatform = React.useCallback((platform: CompanySocialPlatform) => {
    setSelectedPlatforms((current) => current.includes(platform)
      ? current.filter((entry) => entry !== platform)
      : [...current, platform])
  }, [])

  const submitTextPost = React.useCallback(async () => {
    const text = caption.trim()
    if (!text || postBusy) return
    if (selectedPlatforms.length === 0) {
      toast.error("Conecta y selecciona al menos una red social.")
      return
    }
    if (delivery === "scheduled" && !scheduledAt) {
      toast.error("Selecciona la fecha y hora de publicación.")
      return
    }
    if (delivery === "now" && !draft?.enabled) {
      toast.error("Activa la publicación de la empresa antes de publicar ahora.")
      return
    }

    setPostBusy(true)
    try {
      const post = await companySocialApi.queueTextPost({
        caption: text,
        platforms: selectedPlatforms,
        scheduledAt: delivery === "scheduled" ? new Date(scheduledAt).toISOString() : undefined,
        workspaceId,
      })
      if (delivery === "now") {
        await companySocialApi.publishNow(post.id)
        toast.success("Publicación enviada a los canales seleccionados.")
      } else {
        toast.success("Publicación programada.")
      }
      setCaption("")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo preparar la publicación.")
    } finally {
      setPostBusy(false)
    }
  }, [caption, delivery, draft?.enabled, load, postBusy, scheduledAt, selectedPlatforms, workspaceId])

  if (loading && !operations) {
    return (
      <ViewBody>
        <div className="flex min-h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando recursos" />
        </div>
      </ViewBody>
    )
  }

  if (!operations || !draft) {
    return (
      <ViewBody>
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">Recursos no disponibles.</p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reintentar
          </Button>
        </div>
      </ViewBody>
    )
  }

  const connectedCount = operations.providers.filter((provider) => provider.connection?.connected).length
  const autonomous = draft.enabled && draft.mode === "auto"

  if (surface) {
    const connectedPlatforms = new Set(
      operations.providers
        .filter((provider) => provider.connection?.connected && provider.supports.text)
        .map((provider) => provider.platform),
    )
    return (
      <SurfacePage testId="company-resources-surface">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-[11px] font-semibold uppercase text-zinc-500">{companyName}</p>
            <h1 className="mt-2 text-[28px] font-semibold leading-tight">Activos de la empresa agente</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
              Conecta cuentas autorizadas y publica contenido de texto con control explícito del usuario.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-md bg-white dark:bg-zinc-900"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Actualizar estado
          </Button>
        </div>

        <div className="mt-7 grid overflow-hidden rounded-lg border border-zinc-200 bg-white sm:grid-cols-2 xl:grid-cols-4 dark:border-white/10 dark:bg-zinc-900">
          {[
            { label: "Canales conectados", value: connectedCount, detail: `${operations.providers.length} compatibles`, icon: Link2 },
            { label: "En cola", value: operations.metrics.queued, detail: "borradores y programadas", icon: Clock3 },
            { label: "Publicados hoy", value: operations.metrics.publishedToday, detail: "confirmados por proveedor", icon: Send },
            { label: "Modo de salida", value: draft.mode === "auto" ? "Auto" : "Revisión", detail: draft.enabled ? "publicación habilitada" : "publicación pausada", icon: ShieldCheck },
          ].map(({ label, value, detail, icon: Icon }, index) => (
            <div
              key={label}
              className={cn(
                "min-h-[124px] p-5",
                index > 0 && "border-t border-zinc-200 sm:border-l sm:border-t-0 dark:border-white/10",
                index === 2 && "sm:border-l-0 xl:border-l",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500">{label}</span>
                <Icon className="h-4 w-4 text-zinc-400" />
              </div>
              <div className="mt-4 text-2xl font-semibold tabular-nums">{value}</div>
              <p className="mt-1 text-[11px] text-zinc-500">{detail}</p>
            </div>
          ))}
        </div>

        <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,.85fr)]">
          <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">Nueva publicación de texto</h2>
                <p className="mt-1 text-xs text-zinc-500">El contenido solo sale a cuentas conectadas y seleccionadas.</p>
              </div>
              <MessageSquareText className="h-5 w-5 text-zinc-400" />
            </div>
            <Label htmlFor="company-social-caption" className="mt-5 block text-xs font-semibold">Contenido</Label>
            <Textarea
              id="company-social-caption"
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="Escribe el contenido que deseas publicar..."
              maxLength={5_000}
              className="mt-2 min-h-[170px] resize-y rounded-md border-zinc-200 text-sm leading-relaxed dark:border-white/10"
            />
            <div className="mt-2 text-right text-[10px] tabular-nums text-zinc-500">{caption.length}/5000</div>

            <div className="mt-5">
              <Label className="text-xs font-semibold">Canales</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {operations.providers.map((provider) => {
                  const connected = connectedPlatforms.has(provider.platform)
                  const selected = selectedPlatforms.includes(provider.platform)
                  const mark = SOCIAL_PROVIDER_MARKS[provider.platform]
                  return (
                    <button
                      key={`composer-${provider.platform}`}
                      type="button"
                      disabled={!connected}
                      onClick={() => toggleComposerPlatform(provider.platform)}
                      className={cn(
                        "inline-flex h-10 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
                        selected
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950"
                          : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-white/5",
                      )}
                      aria-pressed={selected}
                      title={connected ? `Publicar en ${provider.label}` : `${provider.label} no está conectado`}
                    >
                      <span className={cn("flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold", mark.className)}>
                        {mark.mark}
                      </span>
                      {provider.label}
                      {connected ? <Check className="h-3.5 w-3.5" /> : null}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-[auto_1fr]">
              <div className="flex h-10 items-center rounded-md border border-zinc-200 p-1 dark:border-white/10" role="group" aria-label="Momento de publicación">
                {([
                  ["now", "Ahora"],
                  ["scheduled", "Programar"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDelivery(value)}
                    className={cn(
                      "h-8 rounded px-3 text-xs font-medium",
                      delivery === value ? "bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-white" : "text-zinc-500",
                    )}
                    aria-pressed={delivery === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {delivery === "scheduled" ? (
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                  aria-label="Fecha y hora de publicación"
                  className="h-10 rounded-md border-zinc-200 dark:border-white/10"
                />
              ) : (
                <div className="flex h-10 items-center rounded-md bg-zinc-50 px-3 text-xs text-zinc-500 dark:bg-zinc-950">
                  Se enviará inmediatamente al confirmar.
                </div>
              )}
            </div>

            {!draft.enabled && delivery === "now" ? (
              <div className="mt-4 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/25 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                Activa la publicación en la configuración antes de enviar contenido ahora.
              </div>
            ) : null}

            <Button
              type="button"
              className="mt-5 h-11 w-full rounded-md"
              onClick={() => void submitTextPost()}
              disabled={!caption.trim() || selectedPlatforms.length === 0 || postBusy || (delivery === "scheduled" && !scheduledAt)}
            >
              {postBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : delivery === "now" ? <Send className="mr-2 h-4 w-4" /> : <CalendarClock className="mr-2 h-4 w-4" />}
              {postBusy ? "Procesando..." : delivery === "now" ? "Publicar ahora" : "Programar publicación"}
            </Button>
          </section>

          <section>
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Apps e integraciones</h2>
                <p className="mt-1 text-xs text-zinc-500">OAuth real y permisos confirmados por el proveedor.</p>
              </div>
              <span className="text-xs tabular-nums text-zinc-500">{connectedCount} conectadas</span>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900">
              {operations.providers.map((provider) => {
                const connection = provider.connection
                const mark = SOCIAL_PROVIDER_MARKS[provider.platform]
                const busy = providerBusy === provider.platform
                return (
                  <div key={provider.platform} className="flex min-h-[76px] items-center gap-3 border-b border-zinc-100 px-4 last:border-b-0 dark:border-white/5">
                    <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-bold", mark.className)}>
                      {mark.mark}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <strong className="truncate text-[13px]">{provider.label}</strong>
                        <span className={cn("h-2 w-2 rounded-full", connection?.connected ? "bg-emerald-500" : provider.configured ? "bg-amber-400" : "bg-zinc-300")} />
                      </span>
                      <span className="mt-1 block truncate text-[10px] text-zinc-500">
                        {connection?.connected
                          ? connection.accountName || "Cuenta conectada"
                          : provider.configured
                            ? "Disponible para conectar"
                            : "Credenciales del servidor pendientes"}
                      </span>
                    </span>
                    {connection?.connected ? (
                      <Button type="button" variant="ghost" size="sm" className="h-9 rounded-md text-xs" onClick={() => void disconnect(provider.platform)} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Desconectar"}
                      </Button>
                    ) : (
                      <Button type="button" variant="outline" size="sm" className="h-9 rounded-md text-xs" onClick={() => void connect(provider.platform)} disabled={!provider.configured || busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Conectar"}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold">Control de publicación</h3>
                  <p className="mt-1 text-[11px] text-zinc-500">Pausa global y aprobación de salida.</p>
                </div>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => patchDraft({ enabled })}
                  aria-label="Habilitar publicación social"
                />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-1 rounded-md bg-zinc-100 p-1 dark:bg-zinc-800">
                {([
                  ["review", "Con revisión"],
                  ["auto", "Automático"],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => patchDraft({ mode })}
                    className={cn(
                      "h-9 rounded text-xs font-medium",
                      draft.mode === mode ? "bg-white shadow-sm dark:bg-zinc-950" : "text-zinc-500",
                    )}
                    aria-pressed={draft.mode === mode}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button type="button" variant="outline" className="mt-4 w-full rounded-md" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Guardar configuración
              </Button>
            </div>
          </section>
        </div>

        <section className="mt-8">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Historial de publicaciones</h2>
              <p className="mt-1 text-xs text-zinc-500">Últimos estados devueltos por la cola y los proveedores.</p>
            </div>
            <span className="text-xs tabular-nums text-zinc-500">{posts.length} registros</span>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900">
            {posts.slice(0, 12).map((post) => (
              <div key={post.id} className="grid min-h-[72px] items-center gap-3 border-b border-zinc-100 px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto_auto] dark:border-white/5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{post.caption || post.prompt}</p>
                  <p className="mt-1 truncate text-[10px] text-zinc-500">
                    {post.platforms.map((platform) => operations.providers.find((provider) => provider.platform === platform)?.label || platform).join(" · ")}
                  </p>
                </div>
                <span className={cn(
                  "w-fit rounded-full px-2 py-1 text-[10px] font-semibold",
                  post.status === "published" && "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
                  ["scheduled", "publishing"].includes(post.status) && "bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300",
                  post.status === "failed" && "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300",
                  !["published", "scheduled", "publishing", "failed"].includes(post.status) && "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
                )}>
                  {post.status === "published" ? "Publicado" : post.status === "scheduled" ? "Programado" : post.status === "publishing" ? "Publicando" : post.status === "failed" ? "Falló" : post.status}
                </span>
                <span className="text-[10px] tabular-nums text-zinc-500">
                  {relativeActivity(Date.parse(post.publishedAt || post.scheduledAt || post.createdAt))}
                </span>
              </div>
            ))}
            {posts.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <MessageSquareText className="mx-auto h-5 w-5 text-zinc-400" />
                <p className="mt-2 text-sm font-medium">Sin publicaciones todavía</p>
                <p className="mt-1 text-xs text-zinc-500">Conecta un canal y prepara el primer contenido.</p>
              </div>
            ) : null}
          </div>
        </section>
      </SurfacePage>
    )
  }

  return (
    <ViewBody>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Canales de la empresa</h2>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {connectedCount} conectados · {operations.metrics.queued} pendientes · {operations.metrics.publishedToday} publicados hoy
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-md"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Actualizar canales"
          title="Actualizar"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="mt-4 divide-y divide-border/50 border-y border-border/50">
        {operations.providers.map((provider) => {
          const connection = provider.connection
          const mark = SOCIAL_PROVIDER_MARKS[provider.platform]
          const busy = providerBusy === provider.platform
          return (
            <div key={provider.platform} className="flex min-h-[72px] items-center gap-3 py-3">
              <span className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-bold",
                mark.className,
              )}>
                {mark.mark}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold">{provider.label}</span>
                  <span className={cn(
                    "h-2 w-2 rounded-full",
                    connection?.connected ? "bg-emerald-500" : provider.configured ? "bg-amber-400" : "bg-zinc-300",
                  )} />
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                  {connection?.connected
                    ? connection.accountName || "Cuenta conectada"
                    : provider.configured
                      ? "Listo para conectar"
                      : "Configuración del servidor pendiente"}
                </span>
              </span>
              {connection?.connected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-md px-2 text-[11px]"
                  onClick={() => void disconnect(provider.platform)}
                  disabled={busy}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Desconectar"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-md px-2 text-[11px]"
                  onClick={() => void connect(provider.platform)}
                  disabled={!provider.configured || busy}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="mr-1.5 h-3.5 w-3.5" />}
                  {busy ? null : "Conectar"}
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Operación autónoma</h3>
      </div>

      <div className="mt-3 flex items-center justify-between border-b border-border/45 py-3">
        <div>
          <Label htmlFor="social-operation-enabled" className="text-xs font-semibold">Publicación habilitada</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Pausa global de todos los canales</p>
        </div>
        <Switch
          id="social-operation-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => patchDraft({ enabled })}
        />
      </div>

      <div className="border-b border-border/45 py-3">
        <Label className="text-xs font-semibold">Control de salida</Label>
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-muted/55 p-1" role="group" aria-label="Control de publicación">
          {([
            ["review", "Revisión"],
            ["auto", "Automático"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => patchDraft({ mode })}
              className={cn(
                "h-8 rounded-md text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                draft.mode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={draft.mode === mode}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-border/45 py-3">
        <div>
          <Label htmlFor="social-autopilot-enabled" className="text-xs font-semibold">Contenido diario de CEO Office</Label>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Una pieza diaria según el objetivo activo</p>
        </div>
        <Switch
          id="social-autopilot-enabled"
          checked={draft.autopilot}
          onCheckedChange={(autopilot) => patchDraft({ autopilot })}
          disabled={draft.mode !== "auto"}
        />
      </div>

      <div className="space-y-2 border-b border-border/45 py-3">
        <Label htmlFor="social-company-objective" className="text-xs font-semibold">Objetivo de CEO Office</Label>
        <Textarea
          id="social-company-objective"
          value={draft.objective}
          onChange={(event) => patchDraft({ objective: event.target.value })}
          placeholder="Ej. Posicionar la marca con contenido educativo y captar oportunidades calificadas."
          className="min-h-[92px] resize-none rounded-md text-xs leading-relaxed"
          maxLength={2_000}
        />
      </div>

      <div className="border-b border-border/45 py-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="social-daily-limit" className="text-xs font-semibold">Límite diario</Label>
          <Input
            id="social-daily-limit"
            type="number"
            min={1}
            max={20}
            value={draft.dailyLimit}
            onChange={(event) => patchDraft({
              dailyLimit: Math.max(1, Math.min(20, Number(event.target.value) || 1)),
            })}
            className="h-8 w-20 rounded-md text-right text-xs tabular-nums"
          />
        </div>
      </div>

      <div className="mt-3 space-y-1">
        {operations.providers.map((provider) => (
          <label
            key={`policy-${provider.platform}`}
            className="flex h-9 items-center justify-between rounded-md px-2 text-xs hover:bg-muted/45"
          >
            <span className="flex items-center gap-2">
              <span className={cn("flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold", SOCIAL_PROVIDER_MARKS[provider.platform].className)}>
                {SOCIAL_PROVIDER_MARKS[provider.platform].mark}
              </span>
              {provider.label}
            </span>
            <Switch
              checked={draft.platforms[provider.platform]}
              onCheckedChange={(enabled) => patchPlatform(provider.platform, enabled)}
              aria-label={`Publicar en ${provider.label}`}
            />
          </label>
        ))}
      </div>

      {autonomous ? (
        <div className="mt-4 flex items-start gap-2 border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2.5 text-[10px] leading-relaxed text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
          <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          CEO Office publicará sin revisión previa, dentro del límite y solo en cuentas conectadas.
        </div>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button type="button" className="flex-1 rounded-md" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Guardar operación
        </Button>
        {draft.enabled ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0 rounded-md"
            onClick={() => void pause()}
            disabled={saving}
            aria-label="Detener publicación autónoma"
            title="Detener publicación"
          >
            <PauseCircle className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <Button type="button" variant="ghost" className="mt-2 w-full rounded-md text-xs" onClick={onOpenCeo}>
        <Sparkles className="mr-2 h-4 w-4" />
        Coordinar desde CEO Office
      </Button>
    </ViewBody>
  )
}

function OperatingLoop({
  runs,
  proactiveState,
  checkpointCount,
}: {
  runs: readonly CodexRun[]
  proactiveState: CodexProactiveState
  checkpointCount: number
}) {
  const latest = [...runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))[0] || null
  const latestStatus = String(latest?.status || "").toLowerCase()
  let activeStep = 0
  if (latestStatus === "queued") activeStep = 1
  else if (latestStatus === "running") activeStep = 2
  else if (latestStatus === "waiting_approval" || latestStatus === "error") activeStep = 3
  else if (latestStatus === "done" || latestStatus === "cancelled") activeStep = checkpointCount > 0 ? 4 : 3
  else if (!proactiveState.enabled && runs.length === 0) activeStep = 0

  const steps = ["Objetivo", "Plan", "Ejecutar", "Evidencia", "Memoria"]
  return (
    <div className="mt-5" data-testid="agent-company-operating-loop">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-muted-foreground">Circuito operativo</h3>
        <span className="truncate text-[10px] text-muted-foreground">
          {latest ? runTitle(latest) : proactiveState.enabled ? "Esperando la primera tarea" : "En pausa"}
        </span>
      </div>
      <ol className="mt-3 grid grid-cols-5 gap-1" aria-label="Estado del circuito operativo">
        {steps.map((label, index) => {
          const completed = index < activeStep
          const current = index === activeStep
          return (
            <li key={label} className="min-w-0 text-center">
              <span
                className={cn(
                  "mx-auto flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-semibold",
                  completed && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  current && "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                  !completed && !current && "border-border/60 text-muted-foreground",
                )}
                aria-current={current ? "step" : undefined}
              >
                {completed ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span className={cn("mt-1 block truncate text-[9px]", current ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {label}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function SurfacePage({
  children,
  testId,
}: {
  children: React.ReactNode
  testId: string
}) {
  return (
    <div className="h-full overflow-y-auto bg-[#fbfbfa] dark:bg-zinc-950" data-testid={testId}>
      <div className="mx-auto w-full max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
        {children}
      </div>
    </div>
  )
}

function companyObjective(sessions: readonly CodeChatSession[], rootSessionId: string | null): string {
  const root = sessions.find((session) => session.id === rootSessionId)
  const instruction = [...(root?.turns || [])]
    .reverse()
    .find((turn) => turn.role === "user" && turn.content.trim())
    ?.content
    .replace(/\s+/g, " ")
    .trim()
  return instruction || "Define el objetivo principal desde CEO Office para coordinar a todos los departamentos."
}

function CompanyDashboardSurface({
  companyName,
  snapshot,
  sessions,
  runs,
  checkpointCount,
  proactiveState,
  departmentCount,
  rootSessionId,
  onOpenTask,
}: {
  companyName: string
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  sessions: CodeChatSession[]
  runs: CodexRun[]
  checkpointCount: number
  proactiveState: CodexProactiveState
  departmentCount: number
  rootSessionId: string | null
  onOpenTask: (sessionId: string) => void
}) {
  const orderedRuns = [...runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))
  const completed = orderedRuns.filter((run) => String(run.status).toLowerCase() === "done").length
  const attention = orderedRuns.filter((run) => {
    const status = String(run.status).toLowerCase()
    return status === "error" || status === "waiting_approval"
  })
  const progress = orderedRuns.length ? Math.round((completed / orderedRuns.length) * 100) : 0
  const objective = companyObjective(sessions, rootSessionId)
  const metrics = [
    { label: "Agentes activos", value: snapshot.activeAgents, detail: `${departmentCount} departamentos`, icon: UsersRound },
    { label: "Ejecuciones", value: orderedRuns.length, detail: `${completed} completadas`, icon: Activity },
    { label: "Evidencias", value: checkpointCount, detail: "checkpoints verificables", icon: CheckCircle2 },
    { label: "Atención", value: attention.length, detail: attention.length ? "requieren revisión" : "sin bloqueos activos", icon: AlertTriangle },
  ]

  return (
    <SurfacePage testId="company-dashboard-surface">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-zinc-500">Panel de empresa</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight">{companyName}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            Estado operativo confirmado por los agentes, sus ejecuciones y la evidencia guardada.
          </p>
        </div>
        <span className={cn(
          "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold",
          proactiveState.enabled
            ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
            : "border-zinc-200 bg-white text-zinc-600 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300",
        )}>
          <span className={cn("h-2 w-2 rounded-full", proactiveState.enabled ? "bg-emerald-500" : "bg-zinc-400")} />
          {proactiveState.enabled ? "Operación activa" : "Operación en pausa"}
        </span>
      </div>

      <div className="mt-7 grid overflow-hidden rounded-lg border border-zinc-200 bg-white sm:grid-cols-2 xl:grid-cols-4 dark:border-white/10 dark:bg-zinc-900">
        {metrics.map(({ label, value, detail, icon: Icon }, index) => (
          <div
            key={label}
            className={cn(
              "min-h-[132px] p-5",
              index > 0 && "border-t border-zinc-200 sm:border-t-0 sm:border-l dark:border-white/10",
              index === 2 && "sm:border-l-0 xl:border-l",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-500">{label}</span>
              <Icon className="h-4 w-4 text-zinc-400" />
            </div>
            <div className="mt-5 text-3xl font-semibold tabular-nums">{value}</div>
            <p className="mt-1 text-[11px] text-zinc-500">{detail}</p>
          </div>
        ))}
      </div>

      <section className="mt-7 border-y border-zinc-200 py-6 dark:border-white/10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-4xl">
            <p className="text-[11px] font-semibold uppercase text-zinc-500">Objetivo compartido</p>
            <h2 className="mt-2 text-xl font-semibold leading-snug">{objective}</h2>
          </div>
          <div className="min-w-[190px]">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">Progreso confirmado</span>
              <strong className="tabular-nums">{progress}%</strong>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full rounded-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </section>

      <div className="mt-7 grid gap-7 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
        <section>
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Actividad reciente</h2>
              <p className="mt-1 text-xs text-zinc-500">Conversaciones y encargos guardados en este workspace.</p>
            </div>
            <span className="text-xs tabular-nums text-zinc-500">{sessions.length} registros</span>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900">
            {[...sessions]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 8)
              .map((session) => {
                const status = codeSessionStatus(session)
                return (
                  <button
                    key={session.id}
                    type="button"
                    className="flex min-h-[64px] w-full items-center gap-3 border-b border-zinc-100 px-4 text-left last:border-b-0 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:border-white/5 dark:hover:bg-white/5"
                    onClick={() => onOpenTask(session.id)}
                  >
                    <span className={cn("h-2.5 w-2.5 rounded-full", STATUS_STYLES[status.tone])} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {session.id === rootSessionId ? "CEO Office" : session.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{latestSessionLine(session)}</span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">{relativeActivity(session.updatedAt)}</span>
                  </button>
                )
              })}
            {sessions.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-zinc-500">Aún no hay actividad registrada.</div>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="text-base font-semibold">Estado operativo</h2>
          <p className="mt-1 text-xs text-zinc-500">Bloqueos y últimas señales del runtime.</p>
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900">
            {(attention.length ? attention : orderedRuns.slice(0, 5)).map((run) => {
              const status = codeRunStatus(run)
              return (
                <div key={run.id} className="border-b border-zinc-100 px-4 py-3.5 last:border-b-0 dark:border-white/5">
                  <div className="flex items-start gap-3">
                    <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", STATUS_STYLES[status.tone])} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold">{runTitle(run)}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">
                        {run.error || runSummary(run)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10px] text-zinc-500">{status.label}</span>
                  </div>
                </div>
              )
            })}
            {orderedRuns.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <CheckCircle2 className="mx-auto h-5 w-5 text-emerald-500" />
                <p className="mt-2 text-sm font-medium">Sin ejecuciones pendientes</p>
                <p className="mt-1 text-xs text-zinc-500">CEO Office iniciará el trabajo cuando reciba un objetivo.</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </SurfacePage>
  )
}

function CompanyControlSurface({
  companyName,
  rootSessionId,
  sessions,
  runs,
  checkpointCount,
  proactiveState,
  departments,
  activeSessionId,
  onOpenCeo,
  onOpenTask,
}: {
  companyName: string
  rootSessionId: string | null
  sessions: CodeChatSession[]
  runs: CodexRun[]
  checkpointCount: number
  proactiveState: CodexProactiveState
  departments: readonly AgentDepartmentDefinition[]
  activeSessionId: string | null
  onOpenCeo: () => void
  onOpenTask: (sessionId: string) => void
}) {
  const orderedRuns = [...runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))
  const objective = companyObjective(sessions, rootSessionId)
  const activeCount = orderedRuns.filter(codeRunIsActive).length
  const attentionCount = orderedRuns.filter((run) => ["error", "waiting_approval"].includes(String(run.status).toLowerCase())).length
  const completedCount = orderedRuns.filter((run) => String(run.status).toLowerCase() === "done").length
  const columns = [
    {
      id: "active",
      label: "En ejecución",
      rows: orderedRuns.filter((run) => codeRunIsActive(run)),
      tone: "bg-sky-500",
    },
    {
      id: "attention",
      label: "Requieren atención",
      rows: orderedRuns.filter((run) => ["error", "waiting_approval"].includes(String(run.status).toLowerCase())),
      tone: "bg-amber-500",
    },
    {
      id: "done",
      label: "Completadas",
      rows: orderedRuns.filter((run) => String(run.status).toLowerCase() === "done").slice(0, 12),
      tone: "bg-emerald-500",
    },
  ]

  return (
    <SurfacePage testId="company-control-surface">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="text-[11px] font-semibold uppercase text-zinc-500">{companyName}</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight">Control de operaciones</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            Objetivos, ejecuciones y responsables con trazabilidad de runtime.
          </p>
        </div>
        <Button type="button" className="h-10 rounded-md px-4" onClick={onOpenCeo}>
          <Sparkles className="mr-2 h-4 w-4" />
          Coordinar con CEO Office
        </Button>
      </div>

      <section className="mt-7 rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Radio className={cn("h-4 w-4", proactiveState.enabled ? "text-emerald-500" : "text-zinc-400")} />
              <h2 className="text-sm font-semibold">Modo proactivo</h2>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {proactiveState.enabled ? "Encendido" : "En pausa"}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">CEO Office divide el objetivo en resultados comprobables.</p>
          </div>
          <div className="flex flex-wrap gap-4 text-xs tabular-nums">
            <span><strong>{activeCount}</strong> en ejecución</span>
            <span><strong>{attentionCount}</strong> en atención</span>
            <span><strong>{completedCount}</strong> completadas</span>
            <span><strong>{checkpointCount}</strong> evidencias</span>
          </div>
        </div>
      </section>

      <section className="mt-5 border-y border-zinc-200 py-5 dark:border-white/10">
        <p className="text-[11px] font-semibold uppercase text-zinc-500">Objetivo activo</p>
        <h2 className="mt-2 max-w-5xl text-lg font-semibold leading-snug">{objective}</h2>
      </section>

      <div className="mt-7 grid gap-5 xl:grid-cols-3">
        {columns.map((column) => (
          <section key={column.id} className="min-w-0">
            <div className="flex items-center gap-2 px-1">
              <span className={cn("h-2.5 w-2.5 rounded-full", column.tone)} />
              <h2 className="text-sm font-semibold">{column.label}</h2>
              <span className="ml-auto text-xs tabular-nums text-zinc-500">{column.rows.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {column.rows.map((run) => {
                const departmentId = departmentIdForRun(run, departments)
                const department = departments.find((entry) => entry.id === departmentId)
                const status = codeRunStatus(run)
                return (
                  <article key={run.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
                    <div className="flex items-start gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-zinc-800">
                        <DepartmentGlyph departmentId={departmentId} className="h-3.5 w-3.5 text-zinc-500" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug">{runTitle(run)}</h3>
                        <p className="mt-1 truncate text-[10px] text-zinc-500">{department?.name || "Producto e Ingeniería"}</p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-3 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                      {run.error || runSummary(run)}
                    </p>
                    <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 text-[10px] text-zinc-500 dark:border-white/5">
                      <span>{status.label}</span>
                      <span>{relativeActivity(runActivityAt(run))}</span>
                    </div>
                  </article>
                )
              })}
              {column.rows.length === 0 ? (
                <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-xs text-zinc-500 dark:border-zinc-700">
                  Sin tareas en este estado.
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>

      <section className="mt-9">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Departamentos y memoria</h2>
            <p className="mt-1 text-xs text-zinc-500">Encargos persistentes vinculados al workspace.</p>
          </div>
          <span className="text-xs tabular-nums text-zinc-500">{sessions.length} conversaciones</span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((session) => {
            const isRoot = session.id === rootSessionId
            const status = codeSessionStatus(session)
            return (
              <button
                key={session.id}
                type="button"
                className={cn(
                  "flex min-h-[72px] items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 text-left hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-white/10 dark:bg-zinc-900 dark:hover:bg-white/5",
                  session.id === activeSessionId && "border-zinc-400 dark:border-zinc-500",
                )}
                onClick={isRoot ? onOpenCeo : () => onOpenTask(session.id)}
              >
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", STATUS_STYLES[status.tone])} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{isRoot ? "CEO Office" : session.title}</span>
                  <span className="mt-1 block truncate text-[10px] text-zinc-500">{latestSessionLine(session)}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
              </button>
            )
          })}
        </div>
      </section>
    </SurfacePage>
  )
}

function DashboardView({
  companyName,
  snapshot,
  sessions,
  runs,
  checkpointCount,
  proactiveState,
  departmentCount,
  rootSessionId,
  onOpenTask,
  surface = false,
}: {
  companyName: string
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  sessions: CodeChatSession[]
  runs: CodexRun[]
  checkpointCount: number
  proactiveState: CodexProactiveState
  departmentCount: number
  rootSessionId: string | null
  onOpenTask: (sessionId: string) => void
  surface?: boolean
}) {
  const metrics = [
    { label: "Agentes activos", value: snapshot.activeAgents, icon: Bot },
    { label: "Tareas", value: snapshot.taskCount, icon: ListTree },
    { label: "Archivos", value: snapshot.fileCount, icon: FileCode2 },
    { label: "Recursos", value: snapshot.resourceCount, icon: PackageOpen },
  ]
  if (surface) {
    return (
      <CompanyDashboardSurface
        companyName={companyName}
        snapshot={snapshot}
        sessions={sessions}
        runs={runs}
        checkpointCount={checkpointCount}
        proactiveState={proactiveState}
        departmentCount={departmentCount}
        rootSessionId={rootSessionId}
        onOpenTask={onOpenTask}
      />
    )
  }
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
      <OperatingLoop runs={runs} proactiveState={proactiveState} checkpointCount={checkpointCount} />
      <div className="mt-4 flex items-center justify-between border-y border-border/45 py-3 text-[11px] text-muted-foreground">
        <span>{checkpointCount} evidencias guardadas</span>
        <span>{proactiveState.runsToday} ciclos hoy</span>
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
  companyName,
  rootSessionId,
  sessions,
  runs,
  checkpointCount,
  proactiveState,
  departments,
  activeSessionId,
  onOpenCeo,
  onOpenTask,
  surface = false,
}: {
  companyName: string
  rootSessionId: string | null
  sessions: CodeChatSession[]
  runs: CodexRun[]
  checkpointCount: number
  proactiveState: CodexProactiveState
  departments: readonly AgentDepartmentDefinition[]
  activeSessionId: string | null
  onOpenCeo: () => void
  onOpenTask: (sessionId: string) => void
  surface?: boolean
}) {
  const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt)
  const orderedRuns = [...runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))
  const activeWorkers = orderedRuns.filter(codeRunIsActive).length
  if (surface) {
    return (
      <CompanyControlSurface
        companyName={companyName}
        rootSessionId={rootSessionId}
        sessions={sessions}
        runs={runs}
        checkpointCount={checkpointCount}
        proactiveState={proactiveState}
        departments={departments}
        activeSessionId={activeSessionId}
        onOpenCeo={onOpenCeo}
        onOpenTask={onOpenTask}
      />
    )
  }
  return (
    <ViewBody>
      <div className="flex items-center gap-2">
        <ListTree className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Control de operaciones</h2>
      </div>
      <OperatingLoop runs={runs} proactiveState={proactiveState} checkpointCount={checkpointCount} />

      <div className="mt-5 flex items-center justify-between border-b border-border/45 pb-2">
        <div>
          <h3 className="text-xs font-semibold">Workers</h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Ejecuciones del runtime por departamento</p>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">{activeWorkers} activos</span>
      </div>
      <div className="divide-y divide-border/45" data-testid="agent-company-worker-list">
        {orderedRuns.slice(0, 12).map((run) => {
          const status = codeRunStatus(run)
          const departmentId = departmentIdForRun(run, departments)
          const department = departments.find((entry) => entry.id === departmentId)
          return (
            <div key={run.id} className="flex items-start gap-3 py-3">
              <span className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/55 bg-background">
                <DepartmentGlyph departmentId={departmentId} className="h-3.5 w-3.5 text-muted-foreground" />
                <span
                  className={cn(
                    "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-background",
                    STATUS_STYLES[status.tone],
                  )}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold">{runTitle(run)}</span>
                <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                  {department?.name || "Producto e Ingeniería"} · {status.label}
                </span>
                {run.error ? (
                  <span className="mt-1 line-clamp-2 block text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                    {run.error}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {relativeActivity(runActivityAt(run))}
              </span>
            </div>
          )
        })}
        {orderedRuns.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Todavía no hay ejecuciones del runtime.
          </p>
        ) : null}
      </div>

      <div className="mt-5 border-b border-border/45 pb-2">
        <h3 className="text-xs font-semibold">Memoria y encargos</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          CEO Office conserva decisiones, contexto y resultados
        </p>
      </div>
      <div className="mt-2">
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

type CompanyArtifact = {
  id: string
  name: string
  path: string
  content: string
  updatedAt: number
  departmentId: string
  departmentName: string
  kind: "file" | "report"
  extension: string
}

function artifactDepartment(
  haystack: string,
  departments: readonly AgentDepartmentDefinition[],
): AgentDepartmentDefinition | null {
  const source = haystack.toLocaleLowerCase("es")
  return departments.find((department) => {
    const candidates = [
      department.id,
      department.name,
      ...department.keywords,
    ].map((value) => value.toLocaleLowerCase("es"))
    return candidates.some((candidate) => candidate.length > 2 && source.includes(candidate))
  }) || null
}

function artifactExtension(path: string): string {
  const match = path.toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || "txt"
}

function artifactIcon(extension: string, kind: CompanyArtifact["kind"]) {
  if (kind === "report") return FileText
  if (["csv", "xls", "xlsx"].includes(extension)) return FileSpreadsheet
  if (["md", "mdx", "txt", "doc", "docx", "pdf"].includes(extension)) return FileText
  if (["ts", "tsx", "js", "jsx", "json", "html", "css", "py"].includes(extension)) return FileCode2
  return File
}

function downloadArtifact(artifact: CompanyArtifact) {
  const blob = new Blob([artifact.content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = artifact.name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function FilesView({
  companyName,
  files,
  sessions,
  departments,
  surface = false,
}: {
  companyName: string
  files: CodeFiles
  sessions: CodeChatSession[]
  departments: readonly AgentDepartmentDefinition[]
  surface?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState<"all" | "reports" | "files">("all")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)

  const artifacts = React.useMemo<CompanyArtifact[]>(() => {
    const workspaceFiles = Object.values(files).map((file: CodeFile) => {
      const department = artifactDepartment(file.path, departments)
      return {
        id: `file:${file.path}`,
        name: file.path.split("/").pop() || file.path,
        path: file.path,
        content: file.content,
        updatedAt: file.updatedAt,
        departmentId: department?.id || "workspace",
        departmentName: department?.name || "Espacio de trabajo",
        kind: "file" as const,
        extension: artifactExtension(file.path),
      }
    })
    const reports = sessions.flatMap((session) => {
      const result = [...session.turns].reverse().find(
        (turn) => turn.role === "assistant" && !turn.streaming && turn.content.trim(),
      )
      if (!result) return []
      const department = artifactDepartment(session.title, departments)
      const safeTitle = session.title
        .replace(/[^\p{L}\p{N}\s._-]+/gu, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 70) || "reporte"
      return [{
        id: `report:${session.id}`,
        name: `${safeTitle}.md`,
        path: `Reportes/${department?.name || "CEO Office"}/${safeTitle}.md`,
        content: result.content,
        updatedAt: session.updatedAt,
        departmentId: department?.id || "ceo-office",
        departmentName: department?.name || "CEO Office",
        kind: "report" as const,
        extension: "md",
      }]
    })
    return [...reports, ...workspaceFiles].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [departments, files, sessions])

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es")
    return artifacts.filter((artifact) => {
      if (filter === "reports" && artifact.kind !== "report") return false
      if (filter === "files" && artifact.kind !== "file") return false
      if (!needle) return true
      return `${artifact.name} ${artifact.path} ${artifact.departmentName}`
        .toLocaleLowerCase("es")
        .includes(needle)
    })
  }, [artifacts, filter, query])

  const groups = React.useMemo(() => {
    const map = new Map<string, { id: string; name: string; artifacts: CompanyArtifact[] }>()
    for (const artifact of filtered) {
      const current = map.get(artifact.departmentId) || {
        id: artifact.departmentId,
        name: artifact.departmentName,
        artifacts: [],
      }
      current.artifacts.push(artifact)
      map.set(artifact.departmentId, current)
    }
    return [...map.values()].sort((a, b) => {
      if (a.id === "workspace") return -1
      if (b.id === "workspace") return 1
      return a.name.localeCompare(b.name, "es")
    })
  }, [filtered])
  const selected = artifacts.find((artifact) => artifact.id === selectedId) || null
  const reportCount = artifacts.filter((artifact) => artifact.kind === "report").length

  const body = (
    <SurfacePage testId="company-files-surface">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-[11px] font-semibold uppercase text-zinc-500">{companyName}</p>
          <h1 className="mt-2 text-[28px] font-semibold leading-tight">Archivos y reportes</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            Entregables reales del workspace y reportes persistentes de cada departamento.
          </p>
        </div>
        <div className="flex gap-5 text-right text-xs text-zinc-500">
          <span><strong className="block text-xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{artifacts.length}</strong>archivos</span>
          <span><strong className="block text-xl font-semibold tabular-nums text-zinc-950 dark:text-zinc-50">{reportCount}</strong>reportes</span>
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-3 border-y border-zinc-200 py-3 dark:border-white/10">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar archivos, reportes o departamentos"
            aria-label="Buscar archivos y reportes"
            className="h-10 rounded-md border-zinc-200 bg-white pl-10 dark:border-white/10 dark:bg-zinc-900"
          />
        </div>
        <div className="flex h-10 items-center rounded-md border border-zinc-200 bg-white p-1 dark:border-white/10 dark:bg-zinc-900" role="group" aria-label="Filtrar archivos">
          {([
            ["all", "Todos"],
            ["reports", "Reportes"],
            ["files", "Archivos"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "h-8 rounded px-3 text-xs font-medium",
                filter === value ? "bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-white" : "text-zinc-500 hover:text-zinc-950 dark:hover:text-white",
              )}
              aria-pressed={filter === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={cn("mt-6 grid gap-7", selected && "xl:grid-cols-[minmax(0,1fr)_380px]")}>
        <div className="min-w-0 space-y-8">
          {groups.map((group) => (
            <section key={group.id}>
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-sky-50 text-sky-600 dark:bg-sky-950/35 dark:text-sky-300">
                  <FolderOpen className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">{group.name}</h2>
                  <p className="text-[11px] text-zinc-500">{group.artifacts.length} elementos</p>
                </div>
              </div>
              <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-white/10 dark:bg-zinc-900">
                {group.artifacts.map((artifact) => {
                  const Icon = artifactIcon(artifact.extension, artifact.kind)
                  return (
                    <div
                      key={artifact.id}
                      className={cn(
                        "flex min-h-[68px] items-center gap-3 border-b border-zinc-100 px-4 last:border-b-0 dark:border-white/5",
                        selectedId === artifact.id && "bg-zinc-50 dark:bg-white/5",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedId(artifact.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-white/10 dark:bg-zinc-800">
                          <Icon className="h-4 w-4 text-zinc-500" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{artifact.name}</span>
                          <span className="mt-1 block truncate text-[10px] text-zinc-500">{artifact.path}</span>
                        </span>
                        <span className="hidden shrink-0 text-[10px] tabular-nums text-zinc-500 sm:block">
                          {relativeActivity(artifact.updatedAt)}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 rounded-md"
                        onClick={() => downloadArtifact(artifact)}
                        aria-label={`Descargar ${artifact.name}`}
                        title="Descargar"
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
          {groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 px-5 py-16 text-center dark:border-zinc-700">
              <FolderOpen className="mx-auto h-6 w-6 text-zinc-400" />
              <p className="mt-3 text-sm font-medium">No hay resultados</p>
              <p className="mt-1 text-xs text-zinc-500">Cambia el filtro o solicita un entregable desde CEO Office.</p>
            </div>
          ) : null}
        </div>

        {selected ? (
          <aside className="h-fit rounded-lg border border-zinc-200 bg-white p-5 xl:sticky xl:top-0 dark:border-white/10 dark:bg-zinc-900">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                {React.createElement(artifactIcon(selected.extension, selected.kind), { className: "h-5 w-5 text-zinc-500" })}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-sm font-semibold">{selected.name}</h2>
                <p className="mt-1 text-[10px] text-zinc-500">{selected.departmentName}</p>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedId(null)} aria-label="Cerrar detalle">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 border-y border-zinc-100 py-4 text-xs dark:border-white/5">
              <div><span className="block text-[10px] text-zinc-500">Tipo</span><strong className="mt-1 block uppercase">{selected.extension}</strong></div>
              <div><span className="block text-[10px] text-zinc-500">Actualizado</span><strong className="mt-1 block">{relativeActivity(selected.updatedAt)}</strong></div>
            </div>
            <pre className="mt-4 max-h-[340px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 font-mono text-[10px] leading-relaxed text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300">
              {selected.content.slice(0, 8_000)}
              {selected.content.length > 8_000 ? "\n\n… vista previa limitada" : ""}
            </pre>
            <Button type="button" className="mt-4 w-full rounded-md" onClick={() => downloadArtifact(selected)}>
              <Download className="mr-2 h-4 w-4" />
              Descargar archivo
            </Button>
          </aside>
        ) : null}
      </div>
    </SurfacePage>
  )

  if (surface) return body
  return body
}

function DepartmentView({
  row,
  onOpenCeo,
}: {
  row: {
    department: AgentDepartmentDefinition
    sessions: CodeChatSession[]
    runs: CodexRun[]
    activeCount: number
    latest: CodeChatSession | null
    latestRun: CodexRun | null
  }
  onOpenCeo: () => void
}) {
  const orderedRuns = [...row.runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))
  const taskCount = orderedRuns.length > 0 ? orderedRuns.length : row.sessions.length
  return (
    <ViewBody>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/35">
          <DepartmentGlyph departmentId={row.department.id} className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{row.department.name}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.department.description}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-5 border-y border-border/45 py-3 text-xs">
        <span><strong className="font-semibold tabular-nums">{row.activeCount}</strong> activos</span>
        <span><strong className="font-semibold tabular-nums">{taskCount}</strong> tareas</span>
      </div>
      <h3 className="mt-5 text-xs font-semibold text-muted-foreground">Trabajo asignado</h3>
      <div className="mt-2 divide-y divide-border/45">
        {orderedRuns.map((run) => {
          const status = codeRunStatus(run)
          return (
            <div key={run.id} className="flex items-start gap-3 py-3">
              <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", STATUS_STYLES[status.tone])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{runTitle(run)}</span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                  {run.error || runSummary(run)}
                </span>
                <span className="mt-1 block text-[10px] text-muted-foreground">{status.label}</span>
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {relativeActivity(runActivityAt(run))}
              </span>
            </div>
          )
        })}
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
        {orderedRuns.length === 0 && row.sessions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Sin tareas asignadas.</p>
        ) : null}
      </div>
      <Button type="button" className="mt-5 w-full" onClick={onOpenCeo}>
        Coordinar desde CEO Office
      </Button>
    </ViewBody>
  )
}

function TaskView({
  session,
  onOpenCeo,
  surface = false,
}: {
  session: CodeChatSession
  onOpenCeo: () => void
  surface?: boolean
}) {
  const status = codeSessionStatus(session)
  const lastUser = [...session.turns].reverse().find((turn) => turn.role === "user")
  const lastAssistant = [...session.turns].reverse().find((turn) => turn.role === "assistant")
  if (surface) {
    return (
      <SurfacePage testId="company-task-surface">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase text-zinc-500">Detalle del encargo</p>
            <h1 className="mt-2 max-w-4xl text-[28px] font-semibold leading-tight">{session.title}</h1>
            <span className="mt-3 inline-flex items-center gap-2 text-xs text-zinc-500">
              <span className={cn("h-2.5 w-2.5 rounded-full", STATUS_STYLES[status.tone])} />
              {status.label} · actualizado {relativeActivity(session.updatedAt)}
            </span>
          </div>
          <Button type="button" className="rounded-md" onClick={onOpenCeo}>
            <Sparkles className="mr-2 h-4 w-4" />
            Abrir en CEO Office
          </Button>
        </div>
        <div className="mt-8 grid gap-7 xl:grid-cols-2">
          <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold">Instrucción más reciente</h2>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-zinc-700 dark:text-zinc-200">
              {lastUser?.content || "Sin instrucciones registradas."}
            </p>
          </section>
          <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold">Resultado entregado</h2>
            <p className="mt-4 max-h-[560px] overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-zinc-700 dark:text-zinc-200">
              {lastAssistant?.content || "Pendiente."}
            </p>
          </section>
        </div>
      </SurfacePage>
    )
  }
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
