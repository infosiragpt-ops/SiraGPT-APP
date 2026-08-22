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
  Folder,
  FolderOpen,
  Gauge,
  Languages,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  List,
  ListTree,
  Loader2,
  Megaphone,
  MessageSquareText,
  MoreHorizontal,
  Network,
  PackageOpen,
  PauseCircle,
  Pencil,
  Pin,
  PinOff,
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
  Trash2,
  TrendingUp,
  UsersRound,
  Workflow,
  X,
  Monitor,
} from "lucide-react"
import { toast } from "sonner"

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useResolvedMobile } from "@/hooks/use-mobile"
import { subscribeAgentCompanyPreviewSlot } from "@/lib/agent-company-preview-slot"
import { subscribeAgentCompanySlot } from "@/lib/agent-company-slot"
import {
  codexIdentityIssue,
} from "@/lib/codex/codex-api"
import { buildAgentOfficeModel, type AgentOfficeWorker } from "@/lib/agent-office-model"
import {
  buildCompanyAgentFileArtifacts,
  type CompanyAgentFileArtifact,
} from "@/lib/company-agent-file-reports"
import {
  associatedCodexProjectIdForCompany,
  shouldAcceptCompanyAssociationResponse,
} from "@/lib/company-association-scope"
import { codexProjectIdFromWorkspaceId } from "@/lib/codex-workspace-identity"
import {
  companySocialApi,
  type CompanySocialOperations,
  type CompanySocialPlatform,
  type CompanySocialPolicy,
  type CompanySocialPost,
} from "@/lib/company-social-api"
import { assignedCompanySocialPlatforms } from "@/lib/company-resource-keys"
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
import {
  CODEX_UPDATED_EVENT,
  codexIdForProject,
  listCodexProjects,
  removeCodexProject,
  upsertCodexProject,
} from "@/lib/codex-projects"
import { coworkApi, type CoworkConnector } from "@/lib/cowork-api"
import {
  CODE_ACTIVE_CODEX_PROJECT_EVENT,
  CODE_OPEN_COMPANY_ASSOCIATION_EVENT,
  CODE_OPEN_CURRENT_DEPARTMENT_COMPUTER_EVENT,
  CODE_OPEN_DEPARTMENT_COMPUTER_EVENT,
  notifyCompanyAssociationChanged,
  CODE_NEW_CODE_CHAT_EVENT,
  getActiveCodexProject,
  setActiveCodexProject,
  setActiveDepartmentComputer,
  setActiveDepartmentSelection,
  useCodeWorkspace,
} from "@/lib/code-workspace-context"
import {
  codexApi,
  type CodexAccess,
  type CodexCompanyAssociationState,
  type CodexCompanyCapacity,
  type CodexCompanyContext,
  type CodexCompanyOperations,
  type CodexCompanyResourceState,
  type CodexDepartmentPool,
  type CodexExternalAction,
  type CodexEnterpriseCommandCenter,
  type CodexMissionEvidenceLedger,
  type CodexMissionEvidenceRecord,
  type CodexMissionReviewStatus,
  type CodexProgressMemory,
  type CodexObjectivePortfolio,
  type CodexProjectActivity,
  type CodexProactiveState,
  type CodexRun,
} from "@/lib/codex/codex-api"
import {
  linkedCodexProject,
  persistWorkspaceCodexProject,
  readWorkspaceCodexProject,
} from "@/lib/codex/codex-project-link"
import { projectsService, type Project } from "@/lib/projects-service"
import { cn } from "@/lib/utils"

import { AICodeChatPanel } from "./ai-code-chat-panel"
import { CompanyResourcesSurface } from "./company-resources-surface"
import {
  EnterpriseCommandCenter,
  type EnterpriseDepartment,
  type EnterpriseEventKind,
  type EnterpriseEventStatus,
  type EnterpriseLiveEvent,
  type EnterpriseReadiness,
  type EnterpriseRunState,
  type EnterpriseSwarmSummary,
} from "./enterprise-command-center"

type CompanyView = "home" | "chat" | "dashboard" | "control" | "department" | "files" | "resources" | "task"
type CompanyPreviewView = Exclude<CompanyView, "home" | "chat" | "department">

type CompanyOption = {
  id: string
  projectId?: string
  name: string
  kind: "project" | "local-folder"
  isPinned: boolean
}

type CustomDepartment = AgentDepartmentDefinition & { custom: true }

const CUSTOM_DEPARTMENTS_KEY = "code-workspace:agent-company-departments:v1"
const PINNED_DEPARTMENTS_KEY = "code-workspace:agent-company-pinned-departments:v1"
const HIDDEN_DEPARTMENTS_KEY = "code-workspace:agent-company-hidden-departments:v1"
const DEPARTMENT_OVERRIDES_KEY = "code-workspace:agent-company-department-overrides:v1"

/** Logical agent capacity (research shards + writers + QA). Runtime parallelism is separate. */
const MAX_LOGICAL_AGENTS = 10_000
const MIN_SWARM_LOGICAL_AGENTS = 256
/** Default research concurrency when activating CEO Office swarm. */
const DEFAULT_SWARM_MAX_CONCURRENCY = 128
/** Default concurrent code writers (server still clamps by isolation runCap). */
const DEFAULT_SWARM_MAX_WRITERS = 4

/** IDs managed by backend/src/services/codex/company-departments.js */
const SERVER_BUILTIN_DEPARTMENT_IDS = new Set([
  "ceo-office",
  "agent-infrastructure",
  "product-engineering",
  "engineering-01",
  "engineering-02",
  "market-intelligence",
  "sales",
  "customer-success",
  "growth-engines",
  "marketing",
  "website-distribution",
  "integrations",
  "localization",
  "trust",
])

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
  "market-intelligence": Search,
  sales: BriefcaseBusiness,
  "customer-success": MessageSquareText,
  "website-distribution": ExternalLink,
}

const EMPTY_PROACTIVE_STATE: CodexProactiveState = {
  enabled: false,
  enabledAt: null,
  dayKey: null,
  runsToday: 0,
  deptIndex: 0,
  lastCycleAt: null,
  lastError: null,
  costTodayUsd: 0,
  dailyBudgetUsd: 0,
  budgetBlocked: false,
  lastDepartment: null,
  missionIndex: 0,
  lastMissionId: null,
}

function normalizeProactiveState(
  value: Partial<CodexProactiveState> | null | undefined,
): CodexProactiveState {
  const state = { ...EMPTY_PROACTIVE_STATE, ...(value || {}) }
  return {
    ...state,
    runsToday: Number(state.runsToday) || 0,
    deptIndex: Number(state.deptIndex) || 0,
    costTodayUsd: Number(state.costTodayUsd) || 0,
    dailyBudgetUsd: Number(state.dailyBudgetUsd) || 0,
    missionIndex: Number(state.missionIndex) || 0,
  }
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
        mission: typeof row.mission === "string" ? row.mission.slice(0, 800) : undefined,
        kind: ["coordination", "engineering", "research", "external"].includes(row.kind) ? row.kind : "research",
        desiredAgents: Math.max(1, Math.min(MAX_LOGICAL_AGENTS, Number(row.desiredAgents) || 4)),
        enabled: row.enabled !== false,
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

function pinnedDepartmentStorageKey(workspaceId: string | null | undefined): string {
  return `${PINNED_DEPARTMENTS_KEY}:${workspaceId || "__default__"}`
}

function hiddenDepartmentStorageKey(workspaceId: string | null | undefined): string {
  return `${HIDDEN_DEPARTMENTS_KEY}:${workspaceId || "__default__"}`
}

function departmentOverrideStorageKey(workspaceId: string | null | undefined): string {
  return `${DEPARTMENT_OVERRIDES_KEY}:${workspaceId || "__default__"}`
}

function readStringIdList(key: string): string[] {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]")
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.map((value) => String(value || "").trim()).filter(Boolean))]
  } catch {
    return []
  }
}

function writeStringIdList(key: string, values: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...new Set(values.filter(Boolean))]))
  } catch {
    /* storage disabled */
  }
}

function readPinnedDepartments(workspaceId: string | null | undefined): string[] {
  return readStringIdList(pinnedDepartmentStorageKey(workspaceId))
}

function writePinnedDepartments(workspaceId: string | null | undefined, values: string[]) {
  writeStringIdList(pinnedDepartmentStorageKey(workspaceId), values)
}

function readHiddenDepartments(workspaceId: string | null | undefined): string[] {
  return readStringIdList(hiddenDepartmentStorageKey(workspaceId)).filter((id) => id !== "ceo-office")
}

function writeHiddenDepartments(workspaceId: string | null | undefined, values: string[]) {
  writeStringIdList(
    hiddenDepartmentStorageKey(workspaceId),
    values.filter((id) => id !== "ceo-office"),
  )
}

type DepartmentOverride = {
  name?: string
  description?: string
  mission?: string
  desiredAgents?: number
}

function readDepartmentOverrides(
  workspaceId: string | null | undefined,
): Record<string, DepartmentOverride> {
  if (typeof window === "undefined") return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(departmentOverrideStorageKey(workspaceId)) || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, DepartmentOverride> = {}
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || !raw || typeof raw !== "object" || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      const patch: DepartmentOverride = {}
      if (typeof row.name === "string" && row.name.trim()) patch.name = row.name.trim().slice(0, 70)
      if (typeof row.description === "string") patch.description = row.description.trim().slice(0, 140)
      if (typeof row.mission === "string") patch.mission = row.mission.trim().slice(0, 800)
      if (row.desiredAgents != null) {
        const agents = Number(row.desiredAgents)
        if (Number.isFinite(agents)) patch.desiredAgents = Math.max(1, Math.min(MAX_LOGICAL_AGENTS, Math.round(agents)))
      }
      if (Object.keys(patch).length > 0) out[id] = patch
    }
    return out
  } catch {
    return {}
  }
}

function writeDepartmentOverrides(
  workspaceId: string | null | undefined,
  value: Record<string, DepartmentOverride>,
) {
  try {
    window.localStorage.setItem(departmentOverrideStorageKey(workspaceId), JSON.stringify(value))
  } catch {
    /* storage disabled */
  }
}

function applyDepartmentOverride(
  department: AgentDepartmentDefinition,
  override?: DepartmentOverride,
): AgentDepartmentDefinition {
  if (!override) return department
  return {
    ...department,
    name: override.name?.trim() || department.name,
    description: override.description?.trim() || department.description,
    mission: override.mission?.trim() || department.mission,
    desiredAgents: override.desiredAgents ?? department.desiredAgents,
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

function enterpriseRunState(
  runs: readonly CodexRun[],
  proactiveState: CodexProactiveState,
): EnterpriseRunState {
  if (runs.some((run) => String(run.status).toLowerCase() === "running" || String(run.status).toLowerCase() === "queued")) {
    return "running"
  }
  if (runs.some((run) => String(run.status).toLowerCase() === "error")) return "failed"
  if (!proactiveState.enabled && runs.some((run) => String(run.status).toLowerCase() === "waiting_approval")) {
    return "paused"
  }
  if (runs.some((run) => String(run.status).toLowerCase() === "done")) return "completed"
  return proactiveState.enabled ? "running" : "idle"
}

function enterpriseReadiness(
  context: CodexCompanyContext | null,
  runs: readonly CodexRun[],
  proactiveState: CodexProactiveState,
): EnterpriseReadiness {
  const areas = context?.readiness.areas || []
  const hasBlocked = areas.some((area) => area.status === "blocked")
  return {
    status: hasBlocked ? "blocked" : context?.readiness.score === 100 ? "ready" : "attention",
    score: context?.readiness.score || 0,
    runState: enterpriseRunState(runs, proactiveState),
    checks: areas.map((area) => ({
      id: area.id,
      label: area.label,
      status: area.status === "ready" ? "ready" : area.status === "blocked" ? "blocked" : "attention",
      detail: area.status === "ready" ? area.evidence : area.action,
    })),
    lastCheckedAt: new Date().toISOString(),
  }
}

function enterpriseSwarmSummary(runs: readonly CodexRun[]): EnterpriseSwarmSummary {
  const statuses = runs.map((run) => String(run.status).toLowerCase())
  const active = statuses.filter((status) => status === "running").length
  return {
    logicalAgents: runs.length,
    active,
    queued: statuses.filter((status) => status === "queued" || status === "waiting_approval").length,
    completed: statuses.filter((status) => status === "done").length,
    failed: statuses.filter((status) => status === "error").length,
    maxParallel: Math.max(8, active),
  }
}

function enterpriseDepartments(
  departments: readonly AgentDepartmentDefinition[],
  runs: readonly CodexRun[],
): EnterpriseDepartment[] {
  return departments.map((department) => {
    const assigned = runs
      .filter((run) => departmentIdForRun(run, departments) === department.id)
      .sort((a, b) => runActivityAt(b) - runActivityAt(a))
    const active = assigned.filter((run) => codeRunIsActive(run))
    const completed = assigned.filter((run) => String(run.status).toLowerCase() === "done")
    const blocked = assigned.some((run) => ["error", "waiting_approval"].includes(String(run.status).toLowerCase()))
    const progress = assigned.length ? Math.round((completed.length / assigned.length) * 100) : 0
    return {
      id: department.id,
      name: department.name,
      objective: department.description,
      status: active.length > 0
        ? "active"
        : blocked
          ? "blocked"
          : assigned.length > 0 && completed.length === assigned.length
            ? "completed"
            : "queued",
      logicalAgents: assigned.length,
      activeAgents: active.length,
      queuedTasks: assigned.filter((run) => String(run.status).toLowerCase() === "queued").length,
      completedTasks: completed.length,
      progress,
      currentWork: assigned[0] ? runSummary(assigned[0]) : undefined,
      owner: department.id === "ceo-office" ? "CEO Office" : department.name,
      lastUpdatedAt: assigned[0]?.createdAt ? String(assigned[0].createdAt) : undefined,
    }
  })
}

function enterpriseEventKind(event: CodexProjectActivity): EnterpriseEventKind {
  if (event.type.startsWith("plan_")) return "planning"
  if (event.type === "reasoning_start" || event.type === "reasoning_end") return "research"
  if (event.type === "checkpoint_created" || event.type === "run_summary") return "delivery"
  if (event.type === "budget_status" || event.type.includes("permission")) return "warning"
  if (event.type === "action_start" || event.type === "action_end") {
    return /código|archivo|code/i.test(`${event.title} ${event.detail}`) ? "coding" : "verification"
  }
  if (event.tone === "error") return "error"
  return "delegation"
}

function enterpriseEventStatus(event: CodexProjectActivity): EnterpriseEventStatus {
  if (event.tone === "error" || event.tone === "attention") return "blocked"
  if (event.tone === "active") return "running"
  return "completed"
}

function enterpriseLiveEvents(activity: readonly CodexProjectActivity[]): EnterpriseLiveEvent[] {
  return activity.map((event) => ({
    id: event.id,
    timestamp: event.createdAt,
    title: event.title,
    kind: enterpriseEventKind(event),
    status: enterpriseEventStatus(event),
    detail: event.detail,
    departmentName: event.department,
  }))
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

function replaceCompanyWorkspaceUrl(option: CompanyOption | null) {
  const url = new URL(window.location.href)
  url.searchParams.delete("folder")
  url.searchParams.delete("local")
  if (option?.projectId) url.searchParams.set("folder", option.projectId)
  else if (option?.kind === "local-folder") url.searchParams.set("local", option.id)
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
}

// Thumbnail diferido: la escena 3D (three.js + ciudad) es el chunk más pesado
// del /code. El thumbnail se monta tras el primer idle y con requestIdleCallback
// para no bloquear la primera pintura ni el TTI; el fallback conserva el testid
// (agent-office-thumbnail) para que el UI lock y los e2e de la oficina sigan
// viendo el contenedor, y el canvas llega cuando el usuario ya completó la
// interacción inicial con el panel.
const OfficeThumbnailScene = React.lazy(() =>
  import("./agent-office/agent-office-scene").then((mod) => ({
    default: mod.AgentOfficeScene,
  })),
)

// El overlay de la megaoficina (dialog full con la escena 3D de 196 workers)
// se carga solo cuando el usuario lo abre; fuera del camino crítico del /code.
const OfficeOverlay = React.lazy(() =>
  import("./agent-office/agent-office-overlay").then((mod) => ({
    default: mod.AgentOfficeOverlay,
  })),
)

function LazyAgentOfficeThumbnail({ officeModel, paused = false }: {
  officeModel: ReturnType<typeof buildAgentOfficeModel>
  paused?: boolean
}) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    let cancelled = false
    const mount = () => {
      if (cancelled) return
      setMounted(true)
    }
    // Tras el primer frame (next-tick), no idle: el split de bundle ya saca
    // three.js del camino crítico, y montar pronto mantiene el thumbnail listo
    // para el UI lock y los e2e de la oficina (data-office-ready) sin esperar
    // un idle incierto. La carga del chunk lazy ocurre en paralelo a la
    // primera pintura del panel.
    const raf = window.requestAnimationFrame(mount)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(raf)
    }
  }, [])

  // Sin testid en el wrapper: agent-office-scene ya expone data-testid
  // "agent-office-thumbnail" cuando variant=thumbnail, y es esa la que lleva
  // data-office-ready. Un testid duplicado en el wrapper rompería
  // getByTestId (devuelve el primero en orden de DOM, sin el atributo).
  return (
    <div className="absolute inset-0">
      {mounted ? (
        <React.Suspense fallback={<div data-testid="agent-office-thumbnail-fallback" className="absolute inset-0" />}>
          <OfficeThumbnailScene model={officeModel} variant="thumbnail" paused={paused} />
        </React.Suspense>
      ) : null}
    </div>
  )
}

export function AgentCompanyPanel() {
  const { user } = useAuth()
  const isMobile = useResolvedMobile()
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
    forgetWorkspace,
  } = useCodeWorkspace()

  const [view, setView] = React.useState<CompanyView>("home")
  const [previewView, setPreviewView] = React.useState<CompanyPreviewView | null>(null)
  const [selectedDepartmentId, setSelectedDepartmentId] = React.useState("ceo-office")
  const [computerStatus, setComputerStatus] = React.useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null)
  const [officeOpen, setOfficeOpen] = React.useState(false)
  const [companyMenuOpen, setCompanyMenuOpen] = React.useState(false)
  const [projects, setProjects] = React.useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = React.useState(false)
  const [companyRegistry, setCompanyRegistry] = React.useState<ReturnType<typeof listCodexProjects>>([])
  const [newCompanyOpen, setNewCompanyOpen] = React.useState(false)
  const [newCompanyName, setNewCompanyName] = React.useState("")
  const [creatingCompany, setCreatingCompany] = React.useState(false)
  const [editingCompany, setEditingCompany] = React.useState<CompanyOption | null>(null)
  const [editingCompanyName, setEditingCompanyName] = React.useState("")
  const [deletingCompany, setDeletingCompany] = React.useState<CompanyOption | null>(null)
  const [companyMutation, setCompanyMutation] = React.useState<string | null>(null)
  const [newDepartmentOpen, setNewDepartmentOpen] = React.useState(false)
  const [newDepartmentName, setNewDepartmentName] = React.useState("")
  const [newDepartmentAgents, setNewDepartmentAgents] = React.useState(32)
  const [creatingDepartment, setCreatingDepartment] = React.useState(false)
  const [customDepartments, setCustomDepartments] = React.useState<CustomDepartment[]>([])
  const [pinnedDepartmentIds, setPinnedDepartmentIds] = React.useState<string[]>([])
  const [hiddenDepartmentIds, setHiddenDepartmentIds] = React.useState<string[]>([])
  const [departmentOverrides, setDepartmentOverrides] = React.useState<Record<string, DepartmentOverride>>({})
  const [editDepartmentOpen, setEditDepartmentOpen] = React.useState(false)
  const [editingDepartmentId, setEditingDepartmentId] = React.useState<string | null>(null)
  const [editDepartmentName, setEditDepartmentName] = React.useState("")
  const [editDepartmentDescription, setEditDepartmentDescription] = React.useState("")
  const [editDepartmentMission, setEditDepartmentMission] = React.useState("")
  const [editDepartmentAgents, setEditDepartmentAgents] = React.useState(8)
  const [savingDepartment, setSavingDepartment] = React.useState(false)
  const [deleteDepartmentTarget, setDeleteDepartmentTarget] = React.useState<AgentDepartmentDefinition | null>(null)
  const [deletingDepartment, setDeletingDepartment] = React.useState(false)
  const [companyCapacity, setCompanyCapacity] = React.useState<CodexCompanyCapacity | null>(null)
  const [departmentPools, setDepartmentPools] = React.useState<CodexDepartmentPool[]>([])
  const [progressMemory, setProgressMemory] = React.useState<CodexProgressMemory | null>(null)
  const [missionEvidence, setMissionEvidence] = React.useState<CodexMissionEvidenceLedger | null>(null)
  const [companyOperations, setCompanyOperations] = React.useState<CodexCompanyOperations | null>(null)
  const [proactiveOn, setProactiveOn] = React.useState(false)
  const [proactiveBusy, setProactiveBusy] = React.useState(false)
  const [proactiveState, setProactiveState] = React.useState<CodexProactiveState>(EMPTY_PROACTIVE_STATE)
  const [companyContext, setCompanyContext] = React.useState<CodexCompanyContext | null>(null)
  const [commandCenter, setCommandCenter] = React.useState<CodexEnterpriseCommandCenter | null>(null)
  const [associationState, setAssociationState] = React.useState<CodexCompanyAssociationState | null>(null)
  const [associationError, setAssociationError] = React.useState<{ code: string; message: string } | null>(null)
  const [associationLoading, setAssociationLoading] = React.useState(false)
  const [associationWizardOpen, setAssociationWizardOpen] = React.useState(false)
  const [associationBusy, setAssociationBusy] = React.useState(false)
  const [associationCandidateId, setAssociationCandidateId] = React.useState("")
  const [associationConnectorIds, setAssociationConnectorIds] = React.useState<string[]>([])
  const [codexRuns, setCodexRuns] = React.useState<CodexRun[]>([])
  const [projectActivity, setProjectActivity] = React.useState<CodexProjectActivity[]>([])
  const [checkpointCount, setCheckpointCount] = React.useState(0)
  const [codexAccess, setCodexAccess] = React.useState<CodexAccess | null>(null)
  const companyRuntimePromisesRef = React.useRef<Map<string, Promise<string>>>(new Map())
  const proactiveMutationVersionRef = React.useRef(0)
  const companyProjectId = React.useMemo(() => {
    const value = String(activeFolder?.id || "").trim()
    return codexProjectIdFromWorkspaceId(value, { assumeProject: true })
  }, [activeFolder?.id])
  const associationLoadGenerationRef = React.useRef(0)
  const associationRequestCompanyRef = React.useRef<string | null>(null)
  const companyProjectIdRef = React.useRef<string | null>(companyProjectId)
  companyProjectIdRef.current = companyProjectId
  const associatedCodexProjectId = associatedCodexProjectIdForCompany(
    associationState,
    companyProjectId,
  )

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
          setProjectActivity([])
          setCheckpointCount(0)
          setProactiveState(EMPTY_PROACTIVE_STATE)
          setCompanyContext(null)
          setCompanyCapacity(null)
          setDepartmentPools([])
          setProgressMemory(null)
          setMissionEvidence(null)
          setCompanyOperations(null)
          setCommandCenter(null)
          return
        }

        const [
          accessResult,
          proactiveResult,
          runsResult,
          checkpointsResult,
          activityResult,
          commandCenterResult,
          missionEvidenceResult,
          operationsResult,
        ] = await Promise.allSettled([
          codexApi.access(),
          codexApi.getProactive(codexProjectId),
          codexApi.listRuns(codexProjectId),
          codexApi.listCheckpoints(codexProjectId),
          codexApi.listProjectActivity(codexProjectId, 80),
          codexApi.getCommandCenter(codexProjectId),
          codexApi.getMissionEvidence(codexProjectId),
          codexApi.getCompanyOperations(codexProjectId),
        ])
        if (!alive) return
        if (accessResult.status === "fulfilled") setCodexAccess(accessResult.value)
        if (runsResult.status === "fulfilled") {
          setCodexRuns(Array.isArray(runsResult.value) ? runsResult.value : [])
        }
        if (checkpointsResult.status === "fulfilled") {
          const checkpoints = Array.isArray(checkpointsResult.value) ? checkpointsResult.value : []
          setCheckpointCount(checkpoints.length)
        }
        if (activityResult.status === "fulfilled") {
          setProjectActivity(Array.isArray(activityResult.value) ? activityResult.value : [])
        }
        if (commandCenterResult.status === "fulfilled") {
          setCommandCenter(commandCenterResult.value.commandCenter)
          setCompanyContext(commandCenterResult.value.company)
        }
        if (missionEvidenceResult.status === "fulfilled") {
          setMissionEvidence(missionEvidenceResult.value || null)
        }
        if (operationsResult.status === "fulfilled") {
          setCompanyOperations(operationsResult.value || null)
        }
        if (
          proactiveResult.status === "fulfilled" &&
          mutationVersion === proactiveMutationVersionRef.current
        ) {
          const nextState = normalizeProactiveState(proactiveResult.value.state)
          const enabled = Boolean(nextState.enabled)
          setProactiveState(nextState)
          setCompanyContext(proactiveResult.value.company || null)
          setCompanyCapacity(proactiveResult.value.capacity || null)
          setDepartmentPools(Array.isArray(proactiveResult.value.departmentPools) ? proactiveResult.value.departmentPools : [])
          setProgressMemory(proactiveResult.value.memory || null)
          const serverDepartments = Array.isArray(proactiveResult.value.departments)
            ? proactiveResult.value.departments
            : []
          const custom = serverDepartments
            .filter((department) => department.custom)
            .map((department) => ({ ...department, custom: true as const }))
          setCustomDepartments(custom)
          writeCustomDepartments(activeFolder?.id, custom)
          // Merge built-in capacity/mission from the server so logical agents and
          // office seats match backend fleet sizing (not the FE 1-agent fallback).
          const builtInIds = new Set(AGENT_COMPANY_DEPARTMENTS.map((row) => row.id))
          const serverOverrides: Record<string, DepartmentOverride> = {}
          for (const department of serverDepartments) {
            if (!department || department.custom || !builtInIds.has(department.id)) continue
            const base = AGENT_COMPANY_DEPARTMENTS.find((row) => row.id === department.id)
            if (!base) continue
            const patch: DepartmentOverride = {}
            if (department.desiredAgents != null && department.desiredAgents !== base.desiredAgents) {
              patch.desiredAgents = Math.max(1, Math.min(MAX_LOGICAL_AGENTS, Number(department.desiredAgents) || 1))
            }
            if (department.name && department.name !== base.name) patch.name = department.name
            if (department.mission && department.mission !== base.mission) patch.mission = department.mission
            if (department.description && department.description !== base.description) {
              patch.description = department.description
            }
            if (Object.keys(patch).length) serverOverrides[department.id] = patch
          }
          if (Object.keys(serverOverrides).length) {
            setDepartmentOverrides((current) => {
              const next = { ...current }
              for (const [id, patch] of Object.entries(serverOverrides)) {
                next[id] = { ...next[id], ...patch }
              }
              writeDepartmentOverrides(activeFolder?.id, next)
              return next
            })
          }
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
    const timer = window.setInterval(() => void load(), 5_000)
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

  const refreshCompanyAssociation = React.useCallback(async () => {
    const requestedCompanyId = companyProjectId
    const requestedWorkspaceId = activeFolder?.id || null
    const generation = ++associationLoadGenerationRef.current
    const companyChanged = associationRequestCompanyRef.current !== requestedCompanyId
    associationRequestCompanyRef.current = requestedCompanyId
    if (companyChanged) {
      setAssociationState(null)
      setAssociationError(null)
      setAssociationCandidateId("")
      setAssociationConnectorIds([])
    }
    if (!requestedCompanyId) {
      setAssociationState(null)
      setAssociationError(null)
      setAssociationLoading(false)
      setActiveCodexProject(null)
      return null
    }
    setAssociationLoading(true)
    try {
      const state = await codexApi.getCompanyAssociation(requestedCompanyId)
      if (!shouldAcceptCompanyAssociationResponse({
        requestedCompanyId,
        currentCompanyId: companyProjectIdRef.current,
        requestGeneration: generation,
        currentGeneration: associationLoadGenerationRef.current,
        state,
      })) return null
      setAssociationState(state)
      setAssociationError(null)
      if (state.association) {
        const codexProjectId = state.association.codexProject.id
        setAssociationCandidateId(codexProjectId)
        setAssociationConnectorIds(state.association.connectors.map((connector) => connector.id))
        persistWorkspaceCodexProject(requestedWorkspaceId, codexProjectId)
        setActiveCodexProject(codexProjectId)
      } else {
        const legacyHint = readWorkspaceCodexProject(requestedWorkspaceId)
        const confirmedCandidate = state.candidates.find((candidate) => candidate.id === legacyHint)
        setAssociationCandidateId(confirmedCandidate?.id || state.candidates[0]?.id || "")
        setAssociationConnectorIds([])
        setActiveCodexProject(null)
      }
      return state
    } catch (error) {
      if (
        generation !== associationLoadGenerationRef.current
        || companyProjectIdRef.current !== requestedCompanyId
      ) return null
      setAssociationError(codexIdentityIssue(error))
      setAssociationState(null)
      return null
    } finally {
      if (
        generation === associationLoadGenerationRef.current
        && companyProjectIdRef.current === requestedCompanyId
      ) setAssociationLoading(false)
    }
  }, [activeFolder?.id, companyProjectId])

  React.useEffect(() => {
    void refreshCompanyAssociation()
  }, [refreshCompanyAssociation])

  React.useEffect(() => {
    const openAssociation = () => {
      if (!companyProjectId) return
      setAssociationWizardOpen(true)
      void refreshCompanyAssociation()
    }
    window.addEventListener(CODE_OPEN_COMPANY_ASSOCIATION_EVENT, openAssociation)
    return () => window.removeEventListener(CODE_OPEN_COMPANY_ASSOCIATION_EVENT, openAssociation)
  }, [companyProjectId, refreshCompanyAssociation])

  const confirmCompanyAssociation = React.useCallback(async () => {
    if (!companyProjectId || !associationCandidateId || associationBusy) return
    setAssociationBusy(true)
    try {
      await codexApi.associateCompany(
        companyProjectId,
        associationCandidateId,
        associationConnectorIds,
        "manual",
      )
      await refreshCompanyAssociation()
      notifyCompanyAssociationChanged()
      setAssociationWizardOpen(false)
      toast.success("Entorno y conectores asociados de forma persistente.")
    } catch (error) {
      const status = (error as { status?: number })?.status
      toast.error(
        status === 409
          ? "Ese entorno ya está asociado a otra empresa."
          : "No se pudo guardar la asociación empresarial.",
      )
    } finally {
      setAssociationBusy(false)
    }
  }, [
    associationBusy,
    associationCandidateId,
    associationConnectorIds,
    companyProjectId,
    refreshCompanyAssociation,
  ])

  React.useEffect(() => subscribeAgentCompanySlot(setDockSlot), [])
  React.useEffect(() => subscribeAgentCompanyPreviewSlot(setPreviewSlot), [])
  const dockedInAppsRail = isMobile === false && Boolean(dockSlot)
  const chatLivesInWorkspaceColumn = isMobile === false

  const snapshot = React.useMemo(
    () => buildAgentCompanySnapshot(codeChatSessions, files, codexRuns),
    [codeChatSessions, codexRuns, files],
  )
  const companyName = agentCompanyDisplayName(activeFolder?.name)
  const activeCodexProjectId = getActiveCodexProject()
  const allDepartments = React.useMemo(() => {
    const hidden = new Set(hiddenDepartmentIds)
    const base = [...AGENT_COMPANY_DEPARTMENTS, ...customDepartments]
      .filter((department, index, rows) => rows.findIndex((row) => row.id === department.id) === index)
      .filter((department) => department.id === "ceo-office" || !hidden.has(department.id))
      .map((department) => applyDepartmentOverride(department, departmentOverrides[department.id]))

    const pinnedRank = new Map(pinnedDepartmentIds.map((id, index) => [id, index]))
    return [...base].sort((a, b) => {
      const aPinned = pinnedRank.has(a.id)
      const bPinned = pinnedRank.has(b.id)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      if (aPinned && bPinned) return (pinnedRank.get(a.id) || 0) - (pinnedRank.get(b.id) || 0)
      if (a.id === "ceo-office") return -1
      if (b.id === "ceo-office") return 1
      return a.name.localeCompare(b.name, "es")
    })
  }, [customDepartments, departmentOverrides, hiddenDepartmentIds, pinnedDepartmentIds])

  React.useEffect(() => {
    setCustomDepartments(readCustomDepartments(activeFolder?.id))
    setPinnedDepartmentIds(readPinnedDepartments(activeFolder?.id))
    setHiddenDepartmentIds(readHiddenDepartments(activeFolder?.id))
    setDepartmentOverrides(readDepartmentOverrides(activeFolder?.id))
    setView("home")
    setPreviewView(null)
    setSelectedTaskId(null)
    setOfficeOpen(false)
    setEditDepartmentOpen(false)
    setEditingDepartmentId(null)
    setDeleteDepartmentTarget(null)
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

  React.useEffect(() => {
    const refreshRegistry = () => setCompanyRegistry(listCodexProjects())
    refreshRegistry()
    window.addEventListener(CODEX_UPDATED_EVENT, refreshRegistry)
    return () => window.removeEventListener(CODEX_UPDATED_EVENT, refreshRegistry)
  }, [])

  const companyOptions = React.useMemo<CompanyOption[]>(() => {
    const registry = companyRegistry
    const cloud: CompanyOption[] = projects.map((project) => ({
      id: project.id,
      projectId: project.id,
      name: project.name,
      kind: "project",
      isPinned: project.isStarred,
    }))
    const local: CompanyOption[] = registry
      .filter((entry) => entry.kind === "local-folder")
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: "local-folder",
        isPinned: entry.isPinned === true,
      }))
    const current: CompanyOption | null = activeFolder
      ? (() => {
          const kind = activeFolder.id.startsWith("local:") ? "local-folder" : "project"
          const projectId = kind === "project"
            ? codexProjectIdFromWorkspaceId(activeFolder.id, { assumeProject: true }) || undefined
            : undefined
          const registryId = projectId ? codexIdForProject(projectId) : activeFolder.id
          return {
            id: projectId || activeFolder.id,
            projectId,
            name: activeFolder.name,
            kind,
            isPinned: projectId
              ? projects.find((project) => project.id === projectId)?.isStarred
                ?? registry.find((entry) => entry.id === registryId)?.isPinned
                ?? false
              : registry.find((entry) => entry.id === registryId)?.isPinned === true,
          }
        })()
      : null
    const merged = current ? [current, ...cloud, ...local] : [...cloud, ...local]
    return merged
      .filter((entry, index) => merged.findIndex((candidate) => candidate.id === entry.id) === index)
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => Number(right.entry.isPinned) - Number(left.entry.isPinned) || left.index - right.index)
      .map(({ entry }) => entry)
  }, [activeFolder, companyRegistry, projects])

  const departmentRows = React.useMemo(() => {
    const departmentByPoolId = new Map(
      departmentPools.map((pool) => [pool.id, pool.departmentId] as const),
    )
    const runById = new Map(codexRuns.map((run) => [run.id, run] as const))
    return allDepartments.map((department) => {
      const sessions = codeChatSessions.filter(
        (session) => {
          const linkedRunId = [...session.turns].reverse().find((turn) => turn.codexRunId)?.codexRunId
          const linkedRun = linkedRunId ? runById.get(linkedRunId) || null : null
          const durableDepartmentId = linkedRun?.departmentPoolId
            ? departmentByPoolId.get(linkedRun.departmentPoolId) || null
            : null
          return (durableDepartmentId || departmentIdForSession(session, snapshot.rootSessionId, allDepartments)) === department.id
        },
      )
      const runs = codexRuns.filter(
        (run) => {
          const durableDepartmentId = run.departmentPoolId
            ? departmentByPoolId.get(run.departmentPoolId) || null
            : null
          return (durableDepartmentId || departmentIdForRun(run, allDepartments)) === department.id
        },
      )
      const activeRunCount = runs.filter(codeRunIsActive).length
      const activeSessionCount = sessions.filter(codeSessionIsActive).length
      const activeCount = runs.length > 0 ? activeRunCount : activeSessionCount
      const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
      const latestRun = [...runs].sort((a, b) => runActivityAt(b) - runActivityAt(a))[0] || null
      return { department, sessions, runs, activeCount, latest, latestRun }
    })
  }, [allDepartments, codeChatSessions, codexRuns, departmentPools, snapshot.rootSessionId])

  const selectedDepartment = departmentRows.find((row) => row.department.id === selectedDepartmentId) || null
  const selectedTask = codeChatSessions.find((session) => session.id === selectedTaskId) || null
  const officeModel = React.useMemo(
    () =>
      buildAgentOfficeModel({
        departments: allDepartments,
        sessions: codeChatSessions,
        runs: codexRuns,
        rootSessionId: snapshot.rootSessionId,
        departmentPools,
        capacity: companyCapacity,
        proactive: proactiveState,
        commandCenter,
        missionEvidence,
        operations: companyOperations,
        progressMemory,
      }),
    [
      allDepartments,
      codeChatSessions,
      codexRuns,
      snapshot.rootSessionId,
      departmentPools,
      companyCapacity,
      proactiveState,
      commandCenter,
      missionEvidence,
      companyOperations,
      progressMemory,
    ],
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

        const durableCompanyId = codexProjectIdFromWorkspaceId(workspaceId, { assumeProject: true }) || workspaceId
        if (!codexProjectIdFromWorkspaceId(workspaceId, { assumeProject: true })) {
          throw new Error("Los workspaces locales no pueden administrar una empresa persistente.")
        }
        const durableState = workspaceId === activeFolder?.id && associationState
          ? associationState
          : await codexApi.getCompanyAssociation(durableCompanyId)
        if (durableState.association) {
          const linkedProject = await codexApi.getProject(durableState.association.codexProject.id)
          if (linkedProject.status === "ready") {
            persistWorkspaceCodexProject(workspaceId, linkedProject.id)
            setActiveCodexProject(linkedProject.id)
            return linkedProject.id
          }
        }
        if (durableState.candidates.length) {
          if (workspaceId === activeFolder?.id) {
            setAssociationState(durableState)
            const legacyHint = linkedCodexProject({
              workspaceId,
              sessionId: activeCodeChatSessionId,
            })
            const candidate = durableState.candidates.find((row) => row.id === legacyHint)
            setAssociationCandidateId(candidate?.id || durableState.candidates[0].id)
            setAssociationWizardOpen(true)
          }
          throw Object.assign(
            new Error("Confirma qué entorno pertenece a esta empresa antes de ejecutar agentes."),
            { status: 409, code: "company_association_required" },
          )
        }

        const project = await codexApi.createProject(
          `${name.slice(0, 64)} · Empresa`,
          [
            `Empresa autónoma: ${name}.`,
            "CEO Office coordina los departamentos para construir y mantener software real.",
            "Conserva archivos, ejecuta verificaciones y entrega evidencia antes de publicar.",
          ].join(" "),
          durableState.company.organizationId,
        )
        if (project.status !== "ready") {
          throw new Error(project.error || "El runtime de la empresa no quedó listo.")
        }

        await codexApi.associateCompany(
          durableCompanyId,
          project.id,
          [],
          "created_for_company",
        )
        notifyCompanyAssociationChanged()
        if (workspaceId === activeFolder?.id) await refreshCompanyAssociation()
        persistWorkspaceCodexProject(workspaceId, project.id)
        setActiveCodexProject(project.id)
        return project.id
      })().finally(() => {
        companyRuntimePromisesRef.current.delete(workspaceId)
      })

      companyRuntimePromisesRef.current.set(workspaceId, task)
      return task
    },
    [
      activeCodeChatSessionId,
      activeFolder?.id,
      associationState,
      codexAccess,
      companyName,
      refreshCompanyAssociation,
    ],
  )

  const openCeoOffice = React.useCallback(() => {
    const computerRunId = "dept-ceo-office"
    setSelectedDepartmentId("ceo-office")
    setActiveDepartmentComputer(computerRunId)
    const projectId = associatedCodexProjectId || companyProjectId || getActiveCodexProject()
    if (projectId) setActiveCodexProject(projectId)
    setActiveDepartmentSelection({ id: "ceo-office", name: "CEO Office", projectId: projectId || null })
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CODE_OPEN_DEPARTMENT_COMPUTER_EVENT, {
          detail: { runId: computerRunId, departmentId: "ceo-office", projectId },
        }),
      )
    }
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
    associatedCodexProjectId,
    companyProjectId,

    chatLivesInWorkspaceColumn,
    createCodeChatSession,
    codeChatSessions,
    setActiveCodeChatSession,
  ])


  const openDepartmentComputer = React.useCallback((departmentId: string) => {
    const department = allDepartments.find((entry) => entry.id === departmentId)
    if (!department) return
    setSelectedDepartmentId(departmentId)
    const computerRunId = (department as { computerRunId?: string }).computerRunId || `dept-${departmentId}`
    setActiveDepartmentComputer(computerRunId)
    setComputerStatus({ loading: false, error: null })
    const projectId = associatedCodexProjectId
      || (activeFolder?.id ? codexProjectIdFromWorkspaceId(activeFolder.id, { assumeProject: true }) : null)
      || companyProjectId
      || getActiveCodexProject()
    if (projectId) setActiveCodexProject(projectId)
    setActiveDepartmentSelection({
      id: department.id,
      name: department.name,
      projectId: projectId || null,
    })
    if (!projectId) {
      void ensureCompanyRuntime({ silent: true }).then((id) => {
        if (!id) return
        setActiveCodexProject(id)
        setActiveDepartmentSelection({
          id: department.id,
          name: department.name,
          projectId: id,
        })
      }).catch(() => {})
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CODE_OPEN_DEPARTMENT_COMPUTER_EVENT, {
          detail: { runId: computerRunId, departmentId, projectId },
        }),
      )
    }
  }, [
    activeFolder?.id,
    allDepartments,
    associatedCodexProjectId,
    companyProjectId,
    ensureCompanyRuntime,
  ])

  React.useEffect(() => {
    const projectId = associatedCodexProjectId || companyProjectId || getActiveCodexProject()
    const dept = selectedDepartment?.department
      ? {
          id: selectedDepartment.department.id,
          name: selectedDepartment.department.name,
          projectId: projectId || null,
        }
      : { id: "ceo-office", name: "CEO Office", projectId: projectId || null }
    setActiveDepartmentSelection(dept)
    if (projectId) setActiveCodexProject(projectId)
  }, [associatedCodexProjectId, companyProjectId, selectedDepartment])

  React.useEffect(() => {
    return () => {
      setActiveDepartmentSelection(null)
      setActiveDepartmentComputer(null)
    }
  }, [])

  React.useEffect(() => {
    const onRequestCurrent = () => {
      const id = selectedDepartmentId || "ceo-office"
      openDepartmentComputer(id)
    }
    window.addEventListener(CODE_OPEN_CURRENT_DEPARTMENT_COMPUTER_EVENT, onRequestCurrent as EventListener)
    return () => window.removeEventListener(CODE_OPEN_CURRENT_DEPARTMENT_COMPUTER_EVENT, onRequestCurrent as EventListener)
  }, [openDepartmentComputer, selectedDepartmentId])

  const openDepartmentChat = React.useCallback((departmentId: string) => {
    // Keep the CEO Office / department desktop dock alive alongside chat.
    openDepartmentComputer(departmentId)
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
    openDepartmentComputer,
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
    // Full fleet: every enabled department (built-in + custom) gets a chat seat
    // so PROACTIVO can assign work without a missing-session race.
    const fleet = allDepartments.length > 0 ? allDepartments : PROACTIVE_CORE_DEPARTMENTS
    for (const department of fleet) {
      if (department.id === "ceo-office" || department.enabled === false) continue
      const title = departmentBootstrapTitle(department)
      if (existingTitles.has(title.toLowerCase())) continue
      createCodeChatSession({ title })
      existingTitles.add(title.toLowerCase())
    }
    return rootSessionId
  }, [allDepartments, codeChatSessions, createCodeChatSession])

  // Keep department chats warm whenever PROACTIVO is on (toggle or server hydrate).
  React.useEffect(() => {
    if (!proactiveOn) return
    ensureDepartmentSessions()
  }, [proactiveOn, ensureDepartmentSessions])

  const toggleProactive = React.useCallback(async () => {
    const next = !proactiveOn
    let codexProjectId = associatedCodexProjectId

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
      setProactiveState(normalizeProactiveState(r.state))
      setCompanyCapacity(r.capacity || null)
      if (Array.isArray(r.departments)) {
        const custom = r.departments
          .filter((department) => department.custom)
          .map((department) => ({ ...department, custom: true as const }))
        setCustomDepartments(custom)
        writeCustomDepartments(activeFolder?.id, custom)
      }
      setProactiveOn(enabled)
      setProactiveCompanyEnabled(enabled, { workspaceId: activeFolder?.id || null })
      if (enabled) openCompanyLoop()
      toast.success(
        enabled
          ? "Modo PROACTIVO activado — todos los departamentos operan en flota continua hasta que lo pauses."
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
    associatedCodexProjectId,
    codexAccess?.canRun,
    companyName,
    chatLivesInWorkspaceColumn,
    ensureDepartmentSessions,
    ensureCompanyRuntime,
    proactiveOn,
    setActiveCodeChatSession,
  ])

  const refreshCommandCenter = React.useCallback(async (projectId: string) => {
    const state = await codexApi.getCommandCenter(projectId)
    setCommandCenter(state.commandCenter)
    setCompanyContext(state.company)
    return state.commandCenter
  }, [])

  const startEnterpriseExecution = React.useCallback(async () => {
    setProactiveBusy(true)
    try {
      const projectId =
        associatedCodexProjectId || await ensureCompanyRuntime()
      ensureDepartmentSessions()

      if (commandCenter?.swarm?.status === "paused") {
        await codexApi.resumeSwarm(projectId, commandCenter.swarm.id)
        await refreshCommandCenter(projectId)
        toast.success("Ejecución empresarial reanudada desde el último estado persistido.")
        return
      }

      const rootObjective = companyObjective(codeChatSessions, snapshot.rootSessionId)
      const businessContext = [
        companyContext?.profile?.mission ? `Misión: ${companyContext.profile.mission}` : "",
        companyContext?.profile?.vision ? `Visión: ${companyContext.profile.vision}` : "",
      ].filter(Boolean).join(" ")
      // Prefer explicit department capacity. If seats are still the small default
      // skeleton, activate the full 10k logical fleet so "activar agentes"
      // actually scales past the old 64/1000 caps.
      const capacityFromDepts = allDepartments.reduce(
        (sum, department) => sum + Math.max(1, Number(department.desiredAgents) || 1),
        0,
      )
      const looksLikeDefaultSkeleton = capacityFromDepts <= Math.max(32, allDepartments.length * 8)
      const logicalAgents = Math.min(
        MAX_LOGICAL_AGENTS,
        Math.max(
          MIN_SWARM_LOGICAL_AGENTS,
          looksLikeDefaultSkeleton ? MAX_LOGICAL_AGENTS : capacityFromDepts,
        ),
      )
      const maxConcurrency = DEFAULT_SWARM_MAX_CONCURRENCY
      const maxConcurrentWriters = DEFAULT_SWARM_MAX_WRITERS
      const result = await codexApi.startSwarm(projectId, {
        objective: `${rootObjective} ${businessContext}`.trim(),
        logicalAgents,
        maxConcurrency,
        maxConcurrentWriters,
      })
      setCommandCenter(result.commandCenter)
      setProactiveOn(false)
      setProactiveCompanyEnabled(false, { workspaceId: activeFolder?.id || null })
      const liveParallel =
        result.commandCenter?.swarm?.maxConcurrency
        || result.swarm?.maxConcurrency
        || maxConcurrency
      toast.success(
        `${logicalAgents.toLocaleString("es")} agentes lógicos · hasta ${liveParallel} en paralelo · hasta ${maxConcurrentWriters} writers de código (el servidor puede bajar writers si no hay aislamiento).`,
      )
    } catch (error) {
      const status = (error as { status?: number })?.status
      toast.error(
        status === 409
          ? "Ya existe una ejecución activa. Detén o termina esa tarea antes de iniciar otra."
          : "No se pudo iniciar el centro de mando empresarial.",
      )
    } finally {
      setProactiveBusy(false)
    }
  }, [
    activeFolder?.id,
    allDepartments,
    associatedCodexProjectId,
    codeChatSessions,
    commandCenter?.swarm?.id,
    commandCenter?.swarm?.status,
    companyContext?.profile?.mission,
    companyContext?.profile?.vision,
    ensureCompanyRuntime,
    ensureDepartmentSessions,
    refreshCommandCenter,
    snapshot.rootSessionId,
  ])

  const pauseEnterpriseExecution = React.useCallback(async () => {
    const projectId = associatedCodexProjectId
    const swarmId = commandCenter?.swarm?.id
    if (!projectId || !swarmId) {
      toast.info("No hay un enjambre activo para pausar.")
      return
    }
    setProactiveBusy(true)
    try {
      await codexApi.pauseSwarm(projectId, swarmId)
      await refreshCommandCenter(projectId)
      toast.success("Ejecución pausada. No se asignarán tareas nuevas hasta reanudar.")
    } catch {
      toast.error("No se pudo pausar la ejecución empresarial.")
    } finally {
      setProactiveBusy(false)
    }
  }, [associatedCodexProjectId, commandCenter?.swarm?.id, refreshCommandCenter])

  const cancelCompanyExecution = React.useCallback(async () => {
    const codexProjectId = associatedCodexProjectId
    const activeRun = [...codexRuns]
      .filter((run) => codeRunIsActive(run))
      .sort((a, b) => runActivityAt(b) - runActivityAt(a))[0]
    if (!codexProjectId && !activeRun) {
      toast.info("No hay una ejecución activa.")
      return
    }

    setProactiveBusy(true)
    proactiveMutationVersionRef.current += 1
    try {
      if (codexProjectId && commandCenter?.swarm?.id) {
        await codexApi.cancelSwarm(
          codexProjectId,
          commandCenter.swarm.id,
          "cancelled_by_user",
        )
        await refreshCommandCenter(codexProjectId)
      }
      if (codexProjectId && proactiveOn) {
        const result = await codexApi.setProactive(codexProjectId, false)
        setProactiveState(normalizeProactiveState(result.state))
        setProactiveOn(false)
        setProactiveCompanyEnabled(false, { workspaceId: activeFolder?.id || null })
      }
      if (activeRun) {
        const cancelled = await codexApi.cancelRun(activeRun.id)
        setCodexRuns((current) => current.map((run) => run.id === cancelled.id ? cancelled : run))
      }
      toast.success("Ejecución cancelada y operación proactiva pausada.")
    } catch {
      toast.error("No se pudo cancelar toda la ejecución. Revisa el estado operativo antes de reintentar.")
    } finally {
      setProactiveBusy(false)
    }
  }, [
    activeFolder?.id,
    associatedCodexProjectId,
    codexRuns,
    commandCenter?.swarm?.id,
    proactiveOn,
    refreshCommandCenter,
  ])

  const selectCompany = React.useCallback(
    async (option: CompanyOption) => {
      setCompanyMenuOpen(false)
      replaceCompanyWorkspaceUrl(option)
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

  const toggleCompanyPin = React.useCallback(async (option: CompanyOption) => {
    if (companyMutation) return
    const nextPinned = !option.isPinned
    setCompanyMutation(`pin:${option.id}`)
    setCompanyMenuOpen(false)

    if (option.projectId) {
      setProjects((current) =>
        current.map((project) =>
          project.id === option.projectId ? { ...project, isStarred: nextPinned } : project,
        ),
      )
    }

    try {
      if (option.projectId) {
        const updated = await projectsService.update(option.projectId, { isStarred: nextPinned })
        setProjects((current) =>
          current.map((project) => project.id === updated.id ? { ...project, ...updated } : project),
        )
        const registryId = codexIdForProject(option.projectId)
        const registryEntry = listCodexProjects().find((entry) => entry.id === registryId)
        upsertCodexProject({
          ...registryEntry,
          id: registryId,
          name: updated.name,
          kind: "project",
          isPinned: updated.isStarred,
        })
      } else {
        const registryEntry = listCodexProjects().find((entry) => entry.id === option.id)
        upsertCodexProject({
          ...registryEntry,
          id: option.id,
          name: option.name,
          kind: "local-folder",
          isPinned: nextPinned,
        })
      }
      window.dispatchEvent(new Event(CODEX_UPDATED_EVENT))
      toast.success(nextPinned ? "Empresa fijada." : "Empresa desfijada.")
    } catch (error) {
      if (option.projectId) {
        setProjects((current) =>
          current.map((project) =>
            project.id === option.projectId ? { ...project, isStarred: !nextPinned } : project,
          ),
        )
      }
      toast.error(error instanceof Error ? error.message : "No se pudo actualizar la empresa.")
    } finally {
      setCompanyMutation(null)
    }
  }, [companyMutation])

  const openCompanyEditor = React.useCallback((option: CompanyOption) => {
    setCompanyMenuOpen(false)
    window.setTimeout(() => {
      setEditingCompany(option)
      setEditingCompanyName(option.name)
    }, 0)
  }, [])

  const openCompanyDeletion = React.useCallback((option: CompanyOption) => {
    setCompanyMenuOpen(false)
    window.setTimeout(() => setDeletingCompany(option), 0)
  }, [])

  const saveCompanyName = React.useCallback(async () => {
    const option = editingCompany
    const name = editingCompanyName.trim()
    if (!option || !name || companyMutation) return
    if (name === option.name) {
      setEditingCompany(null)
      return
    }

    setCompanyMutation(`rename:${option.id}`)
    try {
      let nextName = name
      if (option.projectId) {
        const updated = await projectsService.update(option.projectId, { name })
        nextName = updated.name
        setProjects((current) =>
          current.map((project) => project.id === updated.id ? { ...project, ...updated } : project),
        )
        const registryId = codexIdForProject(option.projectId)
        const registryEntry = listCodexProjects().find((entry) => entry.id === registryId)
        upsertCodexProject({
          ...registryEntry,
          id: registryId,
          name: nextName,
          kind: "project",
          isPinned: updated.isStarred,
        })
      } else {
        const registryEntry = listCodexProjects().find((entry) => entry.id === option.id)
        upsertCodexProject({
          ...registryEntry,
          id: option.id,
          name: nextName,
          kind: "local-folder",
          isPinned: option.isPinned,
        })
      }

      const isCurrent = option.projectId
        ? (codexProjectIdFromWorkspaceId(activeFolder?.id, { assumeProject: true }) || "") === option.projectId
        : activeFolder?.id === option.id
      if (isCurrent) {
        await switchCodexWorkspace({
          id: option.projectId ? codexIdForProject(option.projectId) : option.id,
          name: nextName,
          kind: option.kind,
          projectId: option.projectId,
        })
      }
      window.dispatchEvent(new Event(CODEX_UPDATED_EVENT))
      setEditingCompany(null)
      toast.success("Nombre de la empresa actualizado.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo editar la empresa.")
    } finally {
      setCompanyMutation(null)
    }
  }, [
    activeFolder?.id,
    companyMutation,
    editingCompany,
    editingCompanyName,
    switchCodexWorkspace,
  ])

  const deleteSelectedCompany = React.useCallback(async () => {
    const option = deletingCompany
    if (!option || companyMutation) return
    setCompanyMutation(`delete:${option.id}`)

    try {
      if (option.projectId) {
        await projectsService.remove(option.projectId)
        setProjects((current) => current.filter((project) => project.id !== option.projectId))
      }

      const registryId = option.projectId ? codexIdForProject(option.projectId) : option.id
      removeCodexProject(registryId)

      const workspaceId = option.projectId || option.id
      const isCurrent = (codexProjectIdFromWorkspaceId(activeFolder?.id, { assumeProject: true }) || activeFolder?.id)
        === (codexProjectIdFromWorkspaceId(workspaceId, { assumeProject: true }) || workspaceId)
      const fallback = companyOptions.find((candidate) => candidate.id !== option.id)
      if (isCurrent) replaceCompanyWorkspaceUrl(fallback || null)
      forgetWorkspace(workspaceId)
      if (isCurrent && fallback) {
        await switchCodexWorkspace({
          id: fallback.projectId ? codexIdForProject(fallback.projectId) : fallback.id,
          name: fallback.name,
          kind: fallback.kind,
          projectId: fallback.projectId,
        })
      }

      window.dispatchEvent(new Event(CODEX_UPDATED_EVENT))
      setDeletingCompany(null)
      setCompanyMenuOpen(false)
      toast.success(
        option.projectId
          ? "Empresa movida a Papelera. Puedes restaurarla durante 30 días."
          : "Empresa local quitada. No se eliminó ningún archivo del disco.",
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo eliminar la empresa.")
    } finally {
      setCompanyMutation(null)
    }
  }, [
    activeFolder?.id,
    companyMutation,
    companyOptions,
    deletingCompany,
    forgetWorkspace,
    switchCodexWorkspace,
  ])

  const createDepartment = React.useCallback(async () => {
    const name = newDepartmentName.trim()
    if (!name || creatingDepartment) return
    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || Date.now()}`
    if (allDepartments.some((department) => department.id === id || department.name.toLowerCase() === name.toLowerCase())) {
      toast.error("Ese departamento ya existe.")
      return
    }
    setCreatingDepartment(true)
    try {
      const codexProjectId =
        associatedCodexProjectId || await ensureCompanyRuntime()
      const result = await codexApi.upsertDepartment(codexProjectId, {
        id,
        name,
        mission: `Cumple la misión de ${name} y propone trabajo incremental alineado con CEO Office.`,
        description: "Departamento personalizado.",
        keywords: name.toLocaleLowerCase("es").split(/\s+/).filter(Boolean),
        kind: "research",
        desiredAgents: newDepartmentAgents,
        custom: true,
        enabled: true,
      })
      const next = result.departments
        .filter((department) => department.custom)
        .map((department) => ({ ...department, custom: true as const }))
      setCustomDepartments(next)
      setCompanyCapacity(result.capacity)
      writeCustomDepartments(activeFolder?.id, next)
      setNewDepartmentName("")
      setNewDepartmentAgents(32)
      setNewDepartmentOpen(false)
      setSelectedDepartmentId(id)
      toast.success("Departamento operativo añadido.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo persistir el departamento.")
    } finally {
      setCreatingDepartment(false)
    }
  }, [
    activeFolder?.id,
    allDepartments,
    associatedCodexProjectId,
    creatingDepartment,
    ensureCompanyRuntime,
    newDepartmentAgents,
    newDepartmentName,
  ])

  const applyDepartmentPayload = React.useCallback((departments: Array<AgentDepartmentDefinition & { custom?: boolean }>) => {
    const custom = departments
      .filter((department) => department.custom)
      .map((department) => ({ ...department, custom: true as const }))
    setCustomDepartments(custom)
    writeCustomDepartments(activeFolder?.id, custom)

    const nextOverrides: Record<string, DepartmentOverride> = { ...departmentOverrides }
    const builtInIds = new Set(AGENT_COMPANY_DEPARTMENTS.map((department) => department.id))
    for (const department of departments) {
      if (!builtInIds.has(department.id)) continue
      const base = AGENT_COMPANY_DEPARTMENTS.find((row) => row.id === department.id)
      if (!base) continue
      const patch: DepartmentOverride = {}
      if (department.name && department.name !== base.name) patch.name = department.name
      if (department.description && department.description !== base.description) {
        patch.description = department.description
      }
      if (department.mission && department.mission !== base.mission) patch.mission = department.mission
      if (
        department.desiredAgents != null &&
        department.desiredAgents !== (base.desiredAgents ?? undefined)
      ) {
        patch.desiredAgents = department.desiredAgents
      }
      if (Object.keys(patch).length > 0) nextOverrides[department.id] = patch
      else delete nextOverrides[department.id]
    }
    setDepartmentOverrides(nextOverrides)
    writeDepartmentOverrides(activeFolder?.id, nextOverrides)

    const presentIds = new Set(departments.map((department) => department.id))
    const nextHidden = AGENT_COMPANY_DEPARTMENTS
      .map((department) => department.id)
      .filter((id) => id !== "ceo-office" && !presentIds.has(id))
    // Keep any local-only hidden ids that are not part of the server catalog.
    const mergedHidden = [
      ...nextHidden,
      ...hiddenDepartmentIds.filter((id) => !builtInIds.has(id) && !presentIds.has(id)),
    ]
    setHiddenDepartmentIds(mergedHidden)
    writeHiddenDepartments(activeFolder?.id, mergedHidden)
  }, [activeFolder?.id, departmentOverrides, hiddenDepartmentIds])

  const toggleDepartmentPin = React.useCallback((departmentId: string) => {
    setPinnedDepartmentIds((current) => {
      const exists = current.includes(departmentId)
      const next = exists
        ? current.filter((id) => id !== departmentId)
        : [departmentId, ...current.filter((id) => id !== departmentId)]
      writePinnedDepartments(activeFolder?.id, next)
      toast.success(exists ? "Departamento desfijado." : "Departamento fijado.")
      return next
    })
  }, [activeFolder?.id])

  const openEditDepartment = React.useCallback((department: AgentDepartmentDefinition) => {
    setEditingDepartmentId(department.id)
    setEditDepartmentName(department.name)
    setEditDepartmentDescription(department.description || "")
    setEditDepartmentMission(department.mission || department.description || "")
    setEditDepartmentAgents(Math.max(1, Math.min(MAX_LOGICAL_AGENTS, Number(department.desiredAgents) || 8)))
    setEditDepartmentOpen(true)
  }, [])

  const saveEditedDepartment = React.useCallback(async () => {
    const departmentId = editingDepartmentId
    const name = editDepartmentName.trim()
    if (!departmentId || !name || savingDepartment) return
    const current = allDepartments.find((department) => department.id === departmentId)
    if (!current) return
    if (
      allDepartments.some(
        (department) =>
          department.id !== departmentId &&
          department.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      toast.error("Ya existe un departamento con ese nombre.")
      return
    }

    const description = editDepartmentDescription.trim() || current.description || "Departamento operativo."
    const mission = editDepartmentMission.trim() || description
    const desiredAgents = Math.max(1, Math.min(MAX_LOGICAL_AGENTS, editDepartmentAgents || 1))
    const isCustom = Boolean(current.custom) || departmentId.startsWith("custom-")
    const serverManaged = isCustom || SERVER_BUILTIN_DEPARTMENT_IDS.has(departmentId)

    setSavingDepartment(true)
    try {
      const codexProjectId = associatedCodexProjectId || getActiveCodexProject()
      if (codexProjectId && serverManaged) {
        const result = await codexApi.upsertDepartment(codexProjectId, {
          id: departmentId,
          name,
          description,
          mission,
          desiredAgents,
          keywords: current.keywords ? [...current.keywords] : name.toLocaleLowerCase("es").split(/\s+/).filter(Boolean),
          kind: current.kind || "research",
          custom: isCustom,
          enabled: true,
        })
        setCompanyCapacity(result.capacity)
        applyDepartmentPayload(result.departments)
      } else if (isCustom) {
        const next = customDepartments.map((department) =>
          department.id === departmentId
            ? {
                ...department,
                name,
                description,
                mission,
                desiredAgents,
                keywords: name.toLocaleLowerCase("es").split(/\s+/).filter(Boolean),
              }
            : department,
        )
        setCustomDepartments(next)
        writeCustomDepartments(activeFolder?.id, next)
      } else {
        const nextOverrides = {
          ...departmentOverrides,
          [departmentId]: {
            name,
            description,
            mission,
            desiredAgents,
          },
        }
        setDepartmentOverrides(nextOverrides)
        writeDepartmentOverrides(activeFolder?.id, nextOverrides)
      }

      setEditDepartmentOpen(false)
      setEditingDepartmentId(null)
      toast.success("Departamento actualizado.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo editar el departamento.")
    } finally {
      setSavingDepartment(false)
    }
  }, [
    activeFolder?.id,
    allDepartments,
    applyDepartmentPayload,
    associatedCodexProjectId,
    customDepartments,
    departmentOverrides,
    editDepartmentAgents,
    editDepartmentDescription,
    editDepartmentMission,
    editDepartmentName,
    editingDepartmentId,
    savingDepartment,
  ])

  const confirmDeleteDepartment = React.useCallback(async () => {
    const target = deleteDepartmentTarget
    if (!target || deletingDepartment) return
    if (target.id === "ceo-office") {
      toast.error("CEO Office no se puede eliminar.")
      setDeleteDepartmentTarget(null)
      return
    }

    setDeletingDepartment(true)
    try {
      const codexProjectId = associatedCodexProjectId || getActiveCodexProject()
      const isCustom = Boolean(target.custom) || target.id.startsWith("custom-")
      const serverManaged = isCustom || SERVER_BUILTIN_DEPARTMENT_IDS.has(target.id)

      if (codexProjectId && serverManaged) {
        const result = await codexApi.deleteDepartment(codexProjectId, target.id)
        setCompanyCapacity(result.capacity)
        applyDepartmentPayload(result.departments)
      } else if (isCustom) {
        const next = customDepartments.filter((department) => department.id !== target.id)
        setCustomDepartments(next)
        writeCustomDepartments(activeFolder?.id, next)
      } else {
        const nextHidden = [...new Set([...hiddenDepartmentIds, target.id])]
        setHiddenDepartmentIds(nextHidden)
        writeHiddenDepartments(activeFolder?.id, nextHidden)
      }

      setPinnedDepartmentIds((current) => {
        const next = current.filter((id) => id !== target.id)
        writePinnedDepartments(activeFolder?.id, next)
        return next
      })
      if (selectedDepartmentId === target.id) setSelectedDepartmentId("ceo-office")
      setDeleteDepartmentTarget(null)
      toast.success("Departamento eliminado.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo eliminar el departamento.")
    } finally {
      setDeletingDepartment(false)
    }
  }, [
    activeFolder?.id,
    applyDepartmentPayload,
    associatedCodexProjectId,
    customDepartments,
    deleteDepartmentTarget,
    deletingDepartment,
    hiddenDepartmentIds,
    selectedDepartmentId,
  ])

  const currentProjectId = codexProjectIdFromWorkspaceId(activeFolder?.id, { assumeProject: true }) || null
  const associationOptions = associationState?.association
    ? [associationState.association.codexProject]
    : associationState?.candidates || []
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
                      currentProjectId && companyWorkspaceCandidates(option).some(
                        (candidate) => (codexProjectIdFromWorkspaceId(candidate, { assumeProject: true }) || candidate) === currentProjectId,
                      ),
                    )
                    return (
                      <div
                        key={`${option.kind}:${option.id}`}
                        data-testid={`agent-company-row-${option.id}`}
                        className={cn(
                          "flex w-full items-center rounded-lg border transition-colors",
                          isCurrent
                            ? "border-sky-200 bg-sky-50/80 dark:border-sky-900/70 dark:bg-sky-950/25"
                            : "border-border/55 bg-background/65 hover:bg-muted/45",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => void selectCompany(option)}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-l-lg px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          aria-label={`Abrir empresa ${agentCompanyDisplayName(option.name)}`}
                        >
                          <span className="flex h-9 w-1 shrink-0 rounded-full bg-sky-300" />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-sm font-semibold">{agentCompanyDisplayName(option.name)}</span>
                              {option.isPinned ? (
                                <Pin
                                  className="h-3.5 w-3.5 shrink-0 fill-sky-100 text-sky-600"
                                  aria-label="Empresa fijada"
                                  data-testid={`agent-company-pinned-${option.id}`}
                                />
                              ) : null}
                            </span>
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

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Configurar ${agentCompanyDisplayName(option.name)}`}
                              data-testid={`agent-company-actions-${option.id}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" sideOffset={6} className="w-52 rounded-lg p-1.5">
                            <DropdownMenuItem
                              className="gap-2 rounded-md"
                              disabled={Boolean(companyMutation)}
                              onSelect={() => void toggleCompanyPin(option)}
                            >
                              {option.isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                              {option.isPinned ? "Desfijar empresa" : "Fijar empresa"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 rounded-md"
                              disabled={Boolean(companyMutation)}
                              onSelect={() => openCompanyEditor(option)}
                            >
                              <Pencil className="h-4 w-4" />
                              Editar nombre
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="gap-2 rounded-md text-destructive focus:bg-destructive/10 focus:text-destructive"
                              disabled={Boolean(companyMutation)}
                              onSelect={() => openCompanyDeletion(option)}
                            >
                              <Trash2 className="h-4 w-4" />
                              Eliminar empresa
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
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
              className={cn(
                "relative h-10 w-10 shrink-0 rounded-full",
                associationState?.association
                  ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300",
              )}
              onClick={() => setAssociationWizardOpen(true)}
              disabled={!companyProjectId || associationLoading}
              aria-label={associationState?.association ? "Administrar entorno asociado" : "Asociar entorno de empresa"}
              title={associationState?.association ? "Entorno persistente asociado" : "Asociar entorno de empresa"}
              data-testid="company-association-open"
            >
              {associationLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              <span className={cn(
                "absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-background",
                associationState?.association ? "bg-emerald-500" : "bg-amber-500",
              )} />
            </Button>
          ) : null}

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

        {associationError ? (
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
            role="alert"
            data-testid="company-association-error"
          >
            <span>
              {associationError.code}: {associationError.message}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 border-current bg-transparent text-xs"
              onClick={() => void refreshCompanyAssociation()}
            >
              Reintentar
            </Button>
          </div>
        ) : null}

        {view === "home" ? (
          <CompanyHome
            companyName={companyName}
            officeModel={officeModel}
            officeOpen={officeOpen}
            snapshot={snapshot}
            departmentRows={departmentRows}
            logicalAgentCapacity={
              companyCapacity?.logicalAgents ??
              allDepartments.reduce(
                (sum, department) => sum + Math.max(1, department.desiredAgents || 1),
                0,
              )
            }
            onOpenOffice={() => setOfficeOpen(true)}
            activePreviewView={previewView}
            onOpenDashboard={() => openCompanySurface("dashboard")}
            onOpenControl={() => openCompanySurface("control")}
            onOpenFiles={() => openCompanySurface("files")}
            onOpenResources={() => openCompanySurface("resources")}
            onOpenDepartment={openDepartmentChat}
            onAddDepartment={() => setNewDepartmentOpen(true)}
            pinnedDepartmentIds={pinnedDepartmentIds}
            onToggleDepartmentPin={toggleDepartmentPin}
            onEditDepartment={openEditDepartment}
            onDeleteDepartment={(department) => setDeleteDepartmentTarget(department)}
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
            surface={isMobile === true}
            companyName={companyName}
            snapshot={snapshot}
            sessions={codeChatSessions}
            runs={codexRuns}
            checkpointCount={checkpointCount}
            proactiveState={proactiveState}
            companyContext={companyContext}
            commandCenter={commandCenter}
            activity={projectActivity}
            departments={allDepartments}
            departmentCount={allDepartments.length}
            rootSessionId={snapshot.rootSessionId}
            onStart={() => void startEnterpriseExecution()}
            onPause={() => void pauseEnterpriseExecution()}
            onCancel={() => void cancelCompanyExecution()}
            onOpenDepartment={openDepartmentChat}
            onOpenCeo={openCeoOffice}
            onOpenTask={(sessionId) => {
              setSelectedTaskId(sessionId)
              setView("task")
            }}
          />
        ) : view === "control" ? (
          <ControlView
            surface={isMobile === true}
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
            surface={isMobile === true}
            companyName={companyName}
            codexProjectId={activeCodexProjectId}
            files={files}
            sessions={codeChatSessions}
            runs={codexRuns}
            workers={officeModel.workers}
            missionEvidence={missionEvidence}
            rootSessionId={snapshot.rootSessionId}
            departments={allDepartments}
          />
        ) : view === "resources" ? (
          <ResourcesView
            surface={isMobile === true}
            companyName={companyName}
            workspaceId={activeFolder?.id || null}
            companyProjectId={companyProjectId}
            codexProjectId={associatedCodexProjectId}
            ownerId={user?.id || null}
            departments={allDepartments}
            availableConnectorAccountIds={
              associationState?.association?.connectors.map((connector) => connector.id) || []
            }
            onRefreshCompanyAssociation={refreshCompanyAssociation}
            onOpenCeo={openCeoOffice}
          />
        ) : view === "department" && selectedDepartment ? (
          <DepartmentView row={selectedDepartment} onOpenCeo={openCeoOffice} />
        ) : view === "task" && selectedTask ? (
          <TaskView surface={isMobile === true} session={selectedTask} onOpenCeo={openCeoOffice} />
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

      <Dialog
        open={Boolean(editingCompany)}
        onOpenChange={(open) => {
          if (!open && !companyMutation) setEditingCompany(null)
        }}
      >
        <DialogContent className="sm:max-w-[420px]" data-testid="agent-company-edit-dialog">
          <DialogHeader>
            <DialogTitle>Editar empresa</DialogTitle>
            <DialogDescription>
              Cambia el nombre visible de esta empresa y de su workspace asociado.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="agent-company-edit-name">Nombre de la empresa</Label>
            <Input
              id="agent-company-edit-name"
              value={editingCompanyName}
              onChange={(event) => setEditingCompanyName(event.target.value)}
              maxLength={120}
              autoComplete="organization"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void saveCompanyName()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingCompany(null)}
              disabled={Boolean(companyMutation)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void saveCompanyName()}
              disabled={!editingCompanyName.trim() || Boolean(companyMutation)}
            >
              {companyMutation?.startsWith("rename:") ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Guardar cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deletingCompany)}
        onOpenChange={(open) => {
          if (!open && !companyMutation) setDeletingCompany(null)
        }}
      >
        <AlertDialogContent className="sm:max-w-[460px]" data-testid="agent-company-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar empresa</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingCompany?.projectId
                ? `"${agentCompanyDisplayName(deletingCompany.name)}" se moverá a Papelera. Podrás restaurarla durante 30 días y sus datos no se borrarán de inmediato.`
                : `"${agentCompanyDisplayName(deletingCompany?.name)}" se quitará de este navegador. Los archivos de tu disco no se eliminarán.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(companyMutation)}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(companyMutation)}
              onClick={() => void deleteSelectedCompany()}
            >
              {companyMutation?.startsWith("delete:") ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Eliminar empresa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={associationWizardOpen} onOpenChange={setAssociationWizardOpen}>
        <DialogContent className="sm:max-w-[560px]" data-testid="company-association-wizard">
          <DialogHeader>
            <DialogTitle>Asociar entorno de empresa</DialogTitle>
            <DialogDescription>
              Confirma qué proyecto de código y qué conexiones pertenecen a {companyName}. No se aplican asociaciones automáticas.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[58vh] space-y-6 overflow-y-auto py-2">
            <section>
              <div className="flex items-center justify-between gap-3">
                <Label>Proyecto de código</Label>
                <span className="text-[11px] text-muted-foreground">
                  {associationState?.association ? "Persistente" : "Requiere confirmación"}
                </span>
              </div>
              <div className="mt-2 space-y-2">
                {associationOptions.length ? associationOptions.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left",
                      associationCandidateId === candidate.id
                        ? "border-foreground bg-muted/50"
                        : "border-border hover:bg-muted/35",
                    )}
                    onClick={() => setAssociationCandidateId(candidate.id)}
                  >
                    <span className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                      associationCandidateId === candidate.id ? "border-foreground" : "border-muted-foreground/50",
                    )}>
                      {associationCandidateId === candidate.id ? <span className="h-2 w-2 rounded-full bg-foreground" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{candidate.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {candidate.status || "Sin estado"} · {candidate.organizationId ? "Organización" : "Personal"}
                      </span>
                    </span>
                  </button>
                )) : (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No hay proyectos de código huérfanos. Al iniciar la operación se creará uno nuevo y quedará asociado explícitamente.
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between gap-3">
                <Label>Conectores autorizados para esta empresa</Label>
                <span className="text-[11px] text-muted-foreground">{associationConnectorIds.length} seleccionados</span>
              </div>
              <div className="mt-2 divide-y rounded-md border">
                {associationState?.connectors.length ? associationState.connectors.map((connector) => {
                  const checked = associationConnectorIds.includes(connector.id)
                  return (
                    <label key={connector.id} className="flex cursor-pointer items-center gap-3 px-3 py-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border accent-foreground"
                        checked={checked}
                        onChange={() => {
                          setAssociationConnectorIds((current) => checked
                            ? current.filter((id) => id !== connector.id)
                            : [...current, connector.id])
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{connector.accountLabel || connector.provider}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {connector.provider} · {connector.scopes?.length || 0} permisos confirmados
                        </span>
                      </span>
                      <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Conectado</span>
                    </label>
                  )
                }) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    No hay conectores conectados disponibles para esta empresa.
                  </p>
                )}
              </div>
            </section>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAssociationWizardOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void confirmCompanyAssociation()}
              disabled={!associationCandidateId || associationBusy}
            >
              {associationBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              Guardar asociación
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
                  void createDepartment()
                }
              }}
            />
            <Label htmlFor="agent-department-capacity">Capacidad de agentes</Label>
            <Input
              id="agent-department-capacity"
              type="number"
              min={1}
              max={MAX_LOGICAL_AGENTS}
              step={1}
              value={newDepartmentAgents}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10)
                setNewDepartmentAgents(
                  Number.isFinite(value) ? Math.max(1, Math.min(MAX_LOGICAL_AGENTS, value)) : 1,
                )
              }}
            />
            <p className="text-xs text-muted-foreground">
              Capacidad lógica en cola (hasta {MAX_LOGICAL_AGENTS.toLocaleString("es")}); las escrituras al workspace se aíslan por worktree.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNewDepartmentOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void createDepartment()}
              disabled={!newDepartmentName.trim() || creatingDepartment}
            >
              {creatingDepartment ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Añadir departamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editDepartmentOpen}
        onOpenChange={(open) => {
          setEditDepartmentOpen(open)
          if (!open) setEditingDepartmentId(null)
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Editar departamento</DialogTitle>
            <DialogDescription>
              Actualiza el nombre, la misión y la capacidad lógica de esta unidad.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-department-name">Nombre</Label>
              <Input
                id="edit-department-name"
                value={editDepartmentName}
                onChange={(event) => setEditDepartmentName(event.target.value)}
                placeholder="Nombre del departamento"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-department-description">Descripción corta</Label>
              <Input
                id="edit-department-description"
                value={editDepartmentDescription}
                onChange={(event) => setEditDepartmentDescription(event.target.value)}
                placeholder="Resumen visible en la lista"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-department-mission">Misión</Label>
              <Textarea
                id="edit-department-mission"
                value={editDepartmentMission}
                onChange={(event) => setEditDepartmentMission(event.target.value)}
                placeholder="Qué debe lograr este departamento"
                className="min-h-[96px] resize-y"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-department-capacity">Capacidad de agentes</Label>
              <Input
                id="edit-department-capacity"
                type="number"
                min={1}
                max={MAX_LOGICAL_AGENTS}
                step={1}
                value={editDepartmentAgents}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10)
                  setEditDepartmentAgents(
                    Number.isFinite(value) ? Math.max(1, Math.min(MAX_LOGICAL_AGENTS, value)) : 1,
                  )
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditDepartmentOpen(false)
                setEditingDepartmentId(null)
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => void saveEditedDepartment()}
              disabled={!editDepartmentName.trim() || savingDepartment}
            >
              {savingDepartment ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Guardar cambios
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteDepartmentTarget)}
        onOpenChange={(open) => {
          if (!open && !deletingDepartment) setDeleteDepartmentTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminar departamento</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDepartmentTarget
                ? `Se eliminará “${deleteDepartmentTarget.name}” de esta empresa. CEO Office no se puede borrar; el resto de unidades se ocultan o quitan de forma permanente.`
                : "Esta acción no se puede deshacer."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingDepartment}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingDepartment}
              className="bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600"
              onClick={(event) => {
                event.preventDefault()
                void confirmDeleteDepartment()
              }}
            >
              {deletingDepartment ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <React.Suspense fallback={null}>
        <OfficeOverlay
          open={officeOpen}
          companyName={companyName}
          model={officeModel}
          onClose={() => setOfficeOpen(false)}
          onOpenWorker={openOfficeWorker}
          onOpenDepartment={(departmentId) => {
            setOfficeOpen(false)
            openDepartmentChat(departmentId)
          }}
          onOpenDashboard={() => {
            setOfficeOpen(false)
            openCompanySurface("dashboard")
          }}
          onOpenControl={() => {
            setOfficeOpen(false)
            openCompanySurface("control")
          }}
          onOpenFiles={() => {
            setOfficeOpen(false)
            openCompanySurface("files")
          }}
          onOpenResources={() => {
            setOfficeOpen(false)
            openCompanySurface("resources")
          }}
        />
      </React.Suspense>
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
          companyContext={companyContext}
          commandCenter={commandCenter}
          activity={projectActivity}
          departments={allDepartments}
          departmentCount={allDepartments.length}
          rootSessionId={snapshot.rootSessionId}
          onStart={() => void startEnterpriseExecution()}
          onPause={() => void pauseEnterpriseExecution()}
          onCancel={() => void cancelCompanyExecution()}
          onOpenDepartment={(departmentId) => {
            setPreviewView(null)
            openDepartmentChat(departmentId)
          }}
          onOpenCeo={() => {
            setPreviewView(null)
            openCeoOffice()
          }}
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
          codexProjectId={activeCodexProjectId}
          files={files}
          sessions={codeChatSessions}
          runs={codexRuns}
          workers={officeModel.workers}
          missionEvidence={missionEvidence}
          rootSessionId={snapshot.rootSessionId}
          departments={allDepartments}
        />
      ) : previewView === "resources" ? (
        <ResourcesView
          surface
          companyName={companyName}
          workspaceId={activeFolder?.id || null}
          companyProjectId={companyProjectId}
          codexProjectId={associatedCodexProjectId}
          ownerId={user?.id || null}
          departments={allDepartments}
          availableConnectorAccountIds={
            associationState?.association?.connectors.map((connector) => connector.id) || []
          }
          onRefreshCompanyAssociation={refreshCompanyAssociation}
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
  logicalAgentCapacity,
  activePreviewView,
  onOpenOffice,
  onOpenDashboard,
  onOpenControl,
  onOpenFiles,
  onOpenResources,
  onOpenDepartment,
  onAddDepartment,
  pinnedDepartmentIds,
  onToggleDepartmentPin,
  onEditDepartment,
  onDeleteDepartment,
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
  logicalAgentCapacity: number
  activePreviewView: CompanyPreviewView | null
  onOpenOffice: () => void
  onOpenDashboard: () => void
  onOpenControl: () => void
  onOpenFiles: () => void
  onOpenResources: () => void
  onOpenDepartment: (departmentId: string) => void
  onAddDepartment: () => void
  pinnedDepartmentIds: string[]
  onToggleDepartmentPin: (departmentId: string) => void
  onEditDepartment: (department: AgentDepartmentDefinition) => void
  onDeleteDepartment: (department: AgentDepartmentDefinition) => void
  user: ReturnType<typeof useAuth>["user"]
  hideFooter?: boolean
  proactiveOn: boolean
  proactiveBusy: boolean
  proactiveState: CodexProactiveState
  canRun: boolean | null
  onToggleProactive: () => void
}) {
  const pinnedSet = React.useMemo(() => new Set(pinnedDepartmentIds), [pinnedDepartmentIds])
  const [openDepartmentMenuId, setOpenDepartmentMenuId] = React.useState<string | null>(null)
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
        <button
          type="button"
          onClick={onOpenOffice}
          className="group relative block aspect-[16/9] w-full overflow-hidden rounded-xl border border-sky-400/20 bg-[#05070d] text-left shadow-[0_18px_38px_-22px_rgba(2,132,199,0.58)] transition duration-200 hover:-translate-y-0.5 hover:border-sky-400/40 hover:shadow-[0_24px_48px_-24px_rgba(2,132,199,0.72)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          aria-label="Abrir oficina de agentes"
          data-testid="agent-company-live-preview"
        >
          <div className="pointer-events-none absolute inset-0">
            <LazyAgentOfficeThumbnail officeModel={officeModel} paused={officeOpen} />
          </div>
          <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-[#09111f]/90 px-2.5 py-1.5 text-[11px] font-semibold text-slate-100 shadow-lg backdrop-blur-xl">
            <span className={cn("h-2 w-2 rounded-full", officeModel.activeCount > 0 ? "bg-sky-400" : "bg-slate-500")} />
            Oficina · {officeModel.truth.occupiedDesks}/{officeModel.departments.reduce((total, department) => total + Math.max(1, department.pool.size), 0)} puestos
            {officeModel.truth.latestBlockers.length > 0
              ? ` · ${officeModel.truth.latestBlockers.length} bloqueos`
              : officeModel.truth.pendingApprovals > 0
                ? ` · ${officeModel.truth.pendingApprovals} aprob.`
                : ""}
          </span>
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-white/10 bg-[#05070d]/80 px-3 py-2 text-white backdrop-blur-md">
            <span className="truncate text-[11px] font-medium">Abrir megaoficina de {companyName}</span>
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
                : proactiveState.budgetBlocked
                  ? `Presupuesto diario alcanzado · $${proactiveState.costTodayUsd.toFixed(2)}`
                  : `Ciclo autónomo activo · ${proactiveState.runsToday} ejecuciones · $${proactiveState.costTodayUsd.toFixed(2)}`}
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
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-muted-foreground">Departamentos</h2>
            <p className="truncate text-[10px] text-muted-foreground/75">
              {logicalAgentCapacity.toLocaleString("es-PE")} agentes lógicos disponibles
            </p>
          </div>
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
            const isPinned = pinnedSet.has(department.id)
            const canDelete = department.id !== "ceo-office"
            const menuOpen = openDepartmentMenuId === department.id
            return (
              <div
                key={department.id}
                className={cn(
                  "group/dept relative flex min-h-[58px] w-full items-center gap-1.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/55 focus-within:bg-muted/45",
                  hideFooter && "min-h-[46px] gap-1 rounded-md px-1.5 py-1.5",
                  department.id === "ceo-office" && "bg-muted/50",
                  isPinned && "bg-sky-50/70 ring-1 ring-sky-500/10 dark:bg-sky-950/20",
                  menuOpen && "bg-muted/55",
                )}
                data-testid={`agent-company-department-${department.id}`}
              >
                <button
                  type="button"
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 rounded-md px-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    hideFooter && "gap-2",
                  )}
                  onClick={() => onOpenDepartment(department.id)}
                  aria-label={`Abrir ${department.name}`}
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
                    <span className="flex items-center gap-1.5">
                      <span className={cn("truncate text-[13px] font-semibold", hideFooter && "text-[11px]")}>
                        {department.name}
                      </span>
                      {isPinned ? (
                        <Pin
                          className={cn(
                            "h-3 w-3 shrink-0 fill-sky-500/20 text-sky-600 dark:text-sky-300",
                            hideFooter && "h-2.5 w-2.5",
                          )}
                          aria-label="Fijado"
                        />
                      ) : null}
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
                </button>

                <DropdownMenu
                  open={menuOpen}
                  onOpenChange={(open) => setOpenDepartmentMenuId(open ? department.id : null)}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-background/90 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        hideFooter && "h-7 w-7",
                        menuOpen
                          ? "bg-background/90 text-foreground opacity-100"
                          : "opacity-100 sm:opacity-0 sm:group-hover/dept:opacity-100 sm:group-focus-within/dept:opacity-100",
                      )}
                      aria-label={`Opciones de ${department.name}`}
                      data-testid={`agent-company-department-menu-${department.id}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal className={cn("h-4 w-4", hideFooter && "h-3.5 w-3.5")} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    className="w-48 rounded-lg p-1.5"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <DropdownMenuItem
                      className="gap-2 rounded-md"
                      data-testid={`agent-company-department-pin-${department.id}`}
                      onSelect={() => onToggleDepartmentPin(department.id)}
                    >
                      {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                      {isPinned ? "Desfijar" : "Fijar"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="gap-2 rounded-md"
                      data-testid={`agent-company-department-edit-${department.id}`}
                      onSelect={() => onEditDepartment(department)}
                    >
                      <Pencil className="h-4 w-4" />
                      Editar
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="gap-2 rounded-md text-destructive focus:bg-destructive/10 focus:text-destructive"
                      disabled={!canDelete}
                      data-testid={`agent-company-department-delete-${department.id}`}
                      onSelect={() => {
                        if (canDelete) onDeleteDepartment(department)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Eliminar
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <ChevronRight
                  className={cn(
                    "hidden h-4 w-4 shrink-0 text-muted-foreground/45 transition-opacity sm:block",
                    menuOpen || isPinned
                      ? "sm:hidden"
                      : "sm:group-hover/dept:hidden sm:group-focus-within/dept:hidden",
                  )}
                />
              </div>
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
              ? "Modo PROACTIVO ACTIVO — flota multi-departamento continua. Clic para pausar."
              : "Activar PROACTIVO — todos los departamentos trabajan sin detenerse"
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
  companyProjectId,
  codexProjectId,
  ownerId,
  departments = AGENT_COMPANY_DEPARTMENTS,
  availableConnectorAccountIds = [],
  onRefreshCompanyAssociation,
  onOpenCeo,
  surface = false,
}: {
  companyName: string
  workspaceId: string | null
  companyProjectId?: string | null
  codexProjectId?: string | null
  ownerId?: string | null
  departments?: readonly AgentDepartmentDefinition[]
  availableConnectorAccountIds?: readonly string[]
  onRefreshCompanyAssociation?: () => Promise<CodexCompanyAssociationState | null>
  onOpenCeo: () => void
  surface?: boolean
}) {
  const [operations, setOperations] = React.useState<CompanySocialOperations | null>(null)
  const [businessConnectors, setBusinessConnectors] = React.useState<CoworkConnector[]>([])
  const [connectorsLoadError, setConnectorsLoadError] = React.useState<string | null>(null)
  const [posts, setPosts] = React.useState<CompanySocialPost[]>([])
  const [draft, setDraft] = React.useState<CompanySocialPolicy | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [providerBusy, setProviderBusy] = React.useState<CompanySocialPlatform | null>(null)
  const [connectorBusy, setConnectorBusy] = React.useState<string | null>(null)
  const [caption, setCaption] = React.useState("")
  const [selectedPlatforms, setSelectedPlatforms] = React.useState<CompanySocialPlatform[]>([])
  const [delivery, setDelivery] = React.useState<"now" | "scheduled">("now")
  const [scheduledAt, setScheduledAt] = React.useState("")
  const [postBusy, setPostBusy] = React.useState(false)
  const [companyOps, setCompanyOps] = React.useState<CodexCompanyOperations | null>(null)
  const [companyOpsContext, setCompanyOpsContext] = React.useState<CodexCompanyContext | null>(null)
  const [companyOpsBusy, setCompanyOpsBusy] = React.useState<string | null>(null)
  const [companyResourceState, setCompanyResourceState] = React.useState<CodexCompanyResourceState | null>(null)
  const socialLoadGenerationRef = React.useRef(0)
  const socialScopeRef = React.useRef<string | null>(null)
  const companyProjectScopeRef = React.useRef<string | null>(companyProjectId || null)
  companyProjectScopeRef.current = companyProjectId || null
  const socialScopeId = codexProjectId || workspaceId
  socialScopeRef.current = socialScopeId
  const marketingAllowedPlatforms = React.useMemo(
    () => assignedCompanySocialPlatforms(
      companyResourceState?.assignments || {},
      operations?.providers || [],
      "marketing",
    ),
    [companyResourceState?.assignments, operations?.providers],
  )
  const marketingPublishingPlatforms = React.useMemo(
    () => marketingAllowedPlatforms.filter((platform) => {
      const provider = operations?.providers.find((entry) => entry.platform === platform)
      return Boolean(
        provider?.connection?.connected
        && provider.supports.text
        && draft?.platforms[platform],
      )
    }),
    [draft?.platforms, marketingAllowedPlatforms, operations?.providers],
  )

  React.useEffect(() => {
    setCompanyResourceState(null)
  }, [codexProjectId, workspaceId])

  React.useEffect(() => {
    setSelectedPlatforms((current) => {
      const retained = current.filter((platform) => marketingPublishingPlatforms.includes(platform))
      return retained.length > 0 ? retained : marketingPublishingPlatforms
    })
  }, [marketingPublishingPlatforms])

  const load = React.useCallback(async () => {
    const generation = ++socialLoadGenerationRef.current
    const resourceScopeId = codexProjectId || workspaceId
    setLoading(true)
    setOperations(null)
    setDraft(null)
    setPosts([])
    setCompanyOps(null)
    setCompanyOpsContext(null)
    setCompanyOpsBusy(null)
    setConnectorsLoadError(null)
    setSaving(false)
    setPostBusy(false)

    const shouldMigrateLocalScope = Boolean(
      codexProjectId
      && workspaceId
      && codexProjectId !== workspaceId,
    )
    const [
      socialResult,
      postsResult,
      opsResult,
      contextResult,
      connectorResult,
      localSocialResult,
      localPostsResult,
    ] = await Promise.allSettled([
      companySocialApi.operations(resourceScopeId),
      companySocialApi.listPosts(resourceScopeId),
      codexProjectId
        ? codexApi.getCompanyOperations(codexProjectId)
        : Promise.resolve(null),
      codexProjectId
        ? codexApi.getCompanyProfile(codexProjectId)
        : Promise.resolve(null),
      coworkApi.listConnectors(),
      shouldMigrateLocalScope
        ? companySocialApi.operations(workspaceId)
        : Promise.resolve(null),
      shouldMigrateLocalScope
        ? companySocialApi.listPosts(workspaceId)
        : Promise.resolve([]),
    ])

    if (
      generation !== socialLoadGenerationRef.current
      || socialScopeRef.current !== resourceScopeId
    ) return

    if (socialResult.status === "fulfilled") {
      let result = socialResult.value
      const localResult = localSocialResult.status === "fulfilled"
        ? localSocialResult.value
        : null
      if (
        shouldMigrateLocalScope
        && localResult
        && Boolean(localResult.policy.updatedAt)
      ) {
        let migratedPolicy: CompanySocialPolicy | null = null
        let pausedLocalPolicy = false
        try {
          if (!result.policy.updatedAt) {
            migratedPolicy = await companySocialApi.updatePolicy({
              ...localResult.policy,
              workspaceId: resourceScopeId,
              confirmAutopublish: localResult.policy.enabled
                && (localResult.policy.mode === "auto" || localResult.policy.autopilot),
            })
            result = { ...result, policy: migratedPolicy }
          }
          if (localResult.policy.enabled || localResult.policy.autopilot) {
            await companySocialApi.updatePolicy({
              ...localResult.policy,
              enabled: false,
              autopilot: false,
              workspaceId,
            })
            pausedLocalPolicy = true
          }
          if (
            generation !== socialLoadGenerationRef.current
            || socialScopeRef.current !== resourceScopeId
          ) return
          if (migratedPolicy || pausedLocalPolicy) {
            toast.success(migratedPolicy
              ? "La configuración social local se migró al entorno persistente y el scope anterior quedó pausado."
              : "El scope social local anterior quedó pausado; se conservó la política persistente existente.")
          }
        } catch (error) {
          if (migratedPolicy) {
            await companySocialApi.updatePolicy({
              ...migratedPolicy,
              enabled: false,
              autopilot: false,
              workspaceId: resourceScopeId,
            }).catch(() => undefined)
          }
          if (
            generation === socialLoadGenerationRef.current
            && socialScopeRef.current === resourceScopeId
          ) {
            toast.error(error instanceof Error
              ? `No se migró la configuración social: ${error.message}`
              : "No se migró la configuración social. Los controles permanecen bloqueados.")
            setLoading(false)
          }
          return
        }
      }
      setOperations(result)
      setDraft({ ...result.policy, workspaceId: resourceScopeId })
      setSelectedPlatforms((current) => {
        const connected = result.providers
          .filter((provider) => provider.connection?.connected && provider.supports.text)
          .map((provider) => provider.platform)
        const retained = current.filter((platform) => connected.includes(platform))
        return retained.length ? retained : connected
      })
    } else {
      toast.error("No se pudieron cargar las conexiones sociales.")
    }
    if (postsResult.status === "fulfilled") {
      const localPosts = localPostsResult.status === "fulfilled"
        ? localPostsResult.value
        : []
      const postsById = new Map(
        [...postsResult.value, ...localPosts].map((post) => [post.id, post]),
      )
      setPosts([...postsById.values()])
    }
    if (opsResult.status === "fulfilled") setCompanyOps(opsResult.value)
    else toast.error("No se pudieron cargar las operaciones de empresa.")
    if (contextResult.status === "fulfilled") setCompanyOpsContext(contextResult.value)
    if (connectorResult.status === "fulfilled") {
      setBusinessConnectors(connectorResult.value.connectors || [])
      setConnectorsLoadError(null)
    } else {
      setBusinessConnectors([])
      setConnectorsLoadError("No se pudo cargar el catálogo de integraciones.")
    }
    setLoading(false)
  }, [codexProjectId, workspaceId])

  const refreshCompanyOps = React.useCallback(async () => {
    if (!codexProjectId) return
    const operationScope = codexProjectId || workspaceId
    const generation = socialLoadGenerationRef.current
    const [snapshot, context] = await Promise.all([
      codexApi.getCompanyOperations(codexProjectId),
      codexApi.getCompanyProfile(codexProjectId),
    ])
    if (
      socialScopeRef.current !== operationScope
      || socialLoadGenerationRef.current !== generation
    ) return
    setCompanyOps(snapshot)
    setCompanyOpsContext(context)
  }, [codexProjectId, workspaceId])

  const runCompanyOperation = React.useCallback(async (
    key: string,
    operation: (projectId: string) => Promise<unknown>,
    success: string,
  ) => {
    if (!codexProjectId || companyOpsBusy) return
    const operationScope = codexProjectId || workspaceId
    const generation = socialLoadGenerationRef.current
    if (socialScopeRef.current !== operationScope) return
    setCompanyOpsBusy(key)
    try {
      await operation(codexProjectId)
      await refreshCompanyOps()
      if (
        socialScopeRef.current !== operationScope
        || socialLoadGenerationRef.current !== generation
      ) return
      toast.success(success)
    } catch (error) {
      if (
        socialScopeRef.current === operationScope
        && socialLoadGenerationRef.current === generation
      ) {
        const code = (error as { body?: { error?: string } })?.body?.error
        if (code === "approval_stale" || code === "approval_expired" || code === "approval_invalid") {
          toast.error("La aprobación quedó obsoleta. Revisa la acción actualizada antes de enviarla.")
          void refreshCompanyOps()
        } else {
          toast.error(error instanceof Error ? error.message : "La operación no pudo completarse.")
        }
      }
    } finally {
      if (
        socialScopeRef.current === operationScope
        && socialLoadGenerationRef.current === generation
      ) setCompanyOpsBusy(null)
    }
  }, [codexProjectId, companyOpsBusy, refreshCompanyOps, workspaceId])

  const triageSocialChannels = React.useCallback(async (projectId: string) => {
    const result = await codexApi.triageCompanySocial(projectId)
    if (result.action === "social_not_connected") {
      throw new Error("Conecta Facebook, LinkedIn o X desde Canales de la empresa.")
    }
    if (result.action === "social_providers_unavailable") {
      const reconnect = result.errors?.some((error) => error.code === "SOCIAL_SCOPE_REQUIRED")
      throw new Error(reconnect
        ? "Reconecta la cuenta social para autorizar lectura y respuesta de conversaciones."
        : result.errors?.[0]?.message || "No se pudo consultar la red social.")
    }
    return result
  }, [])

  const updateCompanyPolicy = React.useCallback(async (
    field: "emailReplies" | "socialReplies" | "leadOutreach",
    mode: "review" | "auto" | "off",
  ) => {
    if (!codexProjectId || companyOpsBusy) return
    const policyScope = codexProjectId || workspaceId
    const generation = socialLoadGenerationRef.current
    if (socialScopeRef.current !== policyScope) return
    if (
      mode === "auto"
      && !window.confirm("El modo automático puede enviar acciones externas sin revisión individual. ¿Deseas activarlo?")
    ) {
      return
    }
    setCompanyOpsBusy(`policy:${field}`)
    try {
      const context = await codexApi.updateCompanyProfile(codexProjectId, {
        autonomy: { [field]: mode },
      }, { confirmAuto: mode === "auto" })
      if (
        socialScopeRef.current !== policyScope
        || socialLoadGenerationRef.current !== generation
      ) return
      setCompanyOpsContext(context)
      toast.success("Política operativa actualizada.")
    } catch (error) {
      if (
        socialScopeRef.current === policyScope
        && socialLoadGenerationRef.current === generation
      ) toast.error(error instanceof Error ? error.message : "No se pudo actualizar la política.")
    } finally {
      if (
        socialScopeRef.current === policyScope
        && socialLoadGenerationRef.current === generation
      ) setCompanyOpsBusy(null)
    }
  }, [codexProjectId, companyOpsBusy, workspaceId])

  const resolveCompanyAction = React.useCallback(async (
    action: CodexExternalAction,
    decision: "approve" | "reject",
  ) => {
    await runCompanyOperation(
      `action:${action.id}`,
      (projectId) => {
        if (decision === "reject") return codexApi.rejectCompanyAction(projectId, action.id)
        const approval = action.payload._approval
        if (!approval?.actionHash || approval.version !== 1) {
          throw new Error("La acción no tiene una aprobación vigente. Actualiza la vista antes de enviar.")
        }
        return codexApi.approveCompanyAction(projectId, action.id, {
          actionHash: approval.actionHash,
          actionVersion: approval.version,
        })
      },
      decision === "approve" ? "Acción aprobada y ejecutada." : "Acción rechazada.",
    )
  }, [runCompanyOperation])

  React.useEffect(() => {
    void load()
    return () => {
      socialLoadGenerationRef.current += 1
    }
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
    const draftScope = draft.workspaceId || null
    if (!draftScope || draftScope !== socialScopeRef.current) {
      toast.error("La empresa cambió mientras editabas. Actualiza antes de guardar.")
      void load()
      return
    }
    const generation = socialLoadGenerationRef.current
    setSaving(true)
    try {
      const policy = await companySocialApi.updatePolicy({
        ...draft,
        workspaceId: draftScope,
        confirmAutopublish: draft.enabled && (draft.mode === "auto" || draft.autopilot),
      })
      if (
        socialScopeRef.current !== draftScope
        || socialLoadGenerationRef.current !== generation
      ) return
      setDraft(policy)
      setOperations((current) => current ? { ...current, policy } : current)
      toast.success(policy.enabled ? "Operación social actualizada." : "Publicación autónoma pausada.")
    } catch (error) {
      if (
        socialScopeRef.current === draftScope
        && socialLoadGenerationRef.current === generation
      ) toast.error(error instanceof Error ? error.message : "No se pudo guardar la operación.")
    } finally {
      if (
        socialScopeRef.current === draftScope
        && socialLoadGenerationRef.current === generation
      ) setSaving(false)
    }
  }, [draft, load, saving])

  const pause = React.useCallback(async () => {
    if (!draft || saving) return
    const draftScope = draft.workspaceId || null
    if (!draftScope || draftScope !== socialScopeRef.current) {
      toast.error("La empresa cambió mientras editabas. Actualiza antes de continuar.")
      void load()
      return
    }
    const generation = socialLoadGenerationRef.current
    setSaving(true)
    try {
      const policy = await companySocialApi.updatePolicy({
        ...draft,
        enabled: false,
        autopilot: false,
        workspaceId: draftScope,
      })
      if (
        socialScopeRef.current !== draftScope
        || socialLoadGenerationRef.current !== generation
      ) return
      setDraft(policy)
      setOperations((current) => current ? { ...current, policy } : current)
      toast.success("Publicación autónoma detenida.")
    } catch (error) {
      if (
        socialScopeRef.current === draftScope
        && socialLoadGenerationRef.current === generation
      ) toast.error(error instanceof Error ? error.message : "No se pudo detener la publicación.")
    } finally {
      if (
        socialScopeRef.current === draftScope
        && socialLoadGenerationRef.current === generation
      ) setSaving(false)
    }
  }, [draft, load, saving])

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
    if (!window.confirm("Esta acción desconectará la cuenta para todas tus empresas. ¿Deseas continuar?")) {
      return
    }
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

  const connectBusinessConnector = React.useCallback(async (connector: CoworkConnector) => {
    setConnectorBusy(connector.id)
    try {
      await coworkApi.beginConnectorConnection(connector.connectUrl)
      window.setTimeout(() => void load(), 1_500)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo iniciar la conexión.")
    } finally {
      setConnectorBusy(null)
    }
  }, [load])

  const disconnectBusinessConnector = React.useCallback(async (connector: CoworkConnector) => {
    if (!window.confirm(`Esta acción desconectará ${connector.name} para todas tus empresas. ¿Deseas continuar?`)) {
      return
    }
    setConnectorBusy(connector.id)
    try {
      await coworkApi.disconnectConnector(connector.id)
      await load()
      toast.success(`${connector.name} fue desconectado.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo desconectar la integración.")
    } finally {
      setConnectorBusy(null)
    }
  }, [load])

  const assignBusinessConnectorToCompany = React.useCallback(async (connector: CoworkConnector) => {
    const accountId = connector.account?.id
    const operationCompanyId = companyProjectId
    if (!accountId || !operationCompanyId) {
      throw new Error("Asocia primero el entorno persistente de esta empresa.")
    }
    const ensureCurrentCompany = () => {
      if (companyProjectScopeRef.current !== operationCompanyId) {
        throw new Error("La empresa cambió durante la operación. Actualiza Recursos antes de continuar.")
      }
    }
    const syncAssociation = async () => {
      ensureCurrentCompany()
      const refreshed = await onRefreshCompanyAssociation?.()
      ensureCurrentCompany()
      if (onRefreshCompanyAssociation && refreshed?.company.id !== operationCompanyId) {
        throw new Error("No se pudo confirmar la asociación actualizada. Reintenta desde Recursos.")
      }
    }

    try {
      const before = await codexApi.getCompanyAssociation(operationCompanyId)
      ensureCurrentCompany()
      if (!before.association) {
        throw new Error("Asocia primero el entorno persistente de esta empresa.")
      }
      const wasAvailable = before.association.connectors.some((entry) => entry.id === accountId)
      if (wasAvailable) {
        await syncAssociation()
        return false
      }
      try {
        const result = await codexApi.addCompanyConnector(operationCompanyId, accountId)
        await syncAssociation()
        return result.changed
      } catch (error) {
        ensureCurrentCompany()
        const status = Number((error as { status?: number } | null)?.status || 0)
        if (status > 0 && status < 500) throw error
        const reconciled = await codexApi.getCompanyAssociation(operationCompanyId)
        ensureCurrentCompany()
        const isAvailable = Boolean(
          reconciled.association?.connectors.some((entry) => entry.id === accountId),
        )
        if (isAvailable) {
          await syncAssociation()
          return true
        }
        throw error
      }
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "No se pudo dejar la cuenta disponible para esta empresa.",
      )
    }
  }, [companyProjectId, onRefreshCompanyAssociation])

  const toggleComposerPlatform = React.useCallback((platform: CompanySocialPlatform) => {
    setSelectedPlatforms((current) => current.includes(platform)
      ? current.filter((entry) => entry !== platform)
      : [...current, platform])
  }, [])

  const submitTextPost = React.useCallback(async () => {
    const text = caption.trim()
    if (!text || postBusy) return
    const draftScope = draft?.workspaceId || null
    if (!draftScope || draftScope !== socialScopeRef.current) {
      toast.error("La empresa cambió mientras preparabas la publicación. Actualiza antes de enviarla.")
      void load()
      return
    }
    const generation = socialLoadGenerationRef.current
    const publishPlatforms = selectedPlatforms.filter((platform) => (
      marketingPublishingPlatforms.includes(platform)
    ))
    if (publishPlatforms.length === 0) {
      toast.error("Asigna a Marketing al menos una red social conectada.")
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
        platforms: publishPlatforms,
        scheduledAt: delivery === "scheduled" ? new Date(scheduledAt).toISOString() : undefined,
        workspaceId: draftScope,
      })
      if (
        socialScopeRef.current !== draftScope
        || socialLoadGenerationRef.current !== generation
      ) return
      if (delivery === "now") {
        const { result } = await companySocialApi.publishNow(post.id)
        if (
          result.action !== "published"
          || Number(result.published || 0) < 1
          || Number(result.failed || 0) > 0
        ) {
          throw new Error(
            result.action === "skipped_daily_limit"
              ? "Se alcanzó el límite diario de esta empresa."
              : "El proveedor no confirmó la publicación. Revisa el historial antes de reintentar.",
          )
        }
        toast.success("Publicación enviada a los canales seleccionados.")
      } else {
        toast.success("Publicación programada.")
      }
      setCaption("")
      await load()
    } catch (error) {
      if (
        socialScopeRef.current === draftScope
        && socialLoadGenerationRef.current === generation
      ) toast.error(error instanceof Error ? error.message : "No se pudo preparar la publicación.")
    } finally {
      if (
        socialScopeRef.current === draftScope
        && socialLoadGenerationRef.current === generation
      ) setPostBusy(false)
    }
  }, [caption, delivery, draft, load, marketingPublishingPlatforms, postBusy, scheduledAt, selectedPlatforms])

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

  const connectedSocialCount = operations.providers.filter((provider) => provider.connection?.connected).length
  const connectedBusinessCount = businessConnectors.filter((connector) => connector.account?.status === "connected").length
  const connectedCount = connectedSocialCount + connectedBusinessCount
  const autonomous = draft.enabled && draft.mode === "auto"

  if (surface) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fbfbfc] dark:bg-background">
        <CompanyResourcesSurface
          companyName={companyName}
          workspaceId={workspaceId}
          codexProjectId={codexProjectId || null}
          ownerId={ownerId}
          departments={departments}
          availableConnectorAccountIds={availableConnectorAccountIds}
          operations={operations}
          businessConnectors={businessConnectors}
          connectorsLoadError={connectorsLoadError}
          loading={loading}
          providerBusy={providerBusy}
          connectorBusy={connectorBusy}
          onRefresh={() => void load()}
          onConnectSocial={(platform) => void connect(platform)}
          onConnectConnector={(connector) => void connectBusinessConnector(connector)}
          onAssignConnectorToCompany={assignBusinessConnectorToCompany}
          onResourceStateChange={setCompanyResourceState}
        />
        {companyOps ? (
          <div className="mx-auto w-full max-w-[1100px] px-4 pb-10 sm:px-6 lg:px-8">
            <CompanyOperationsPanel
              operations={companyOps}
              context={companyOpsContext}
              busy={companyOpsBusy}
              onResearch={() => runCompanyOperation(
                "research",
                (projectId) => codexApi.researchCompanyLeads(projectId),
                "Investigación comercial actualizada.",
              )}
              onTriage={() => runCompanyOperation(
                "inbox",
                (projectId) => codexApi.triageCompanyInbox(projectId),
                "Bandeja revisada y acciones preparadas.",
              )}
              onSocialTriage={() => runCompanyOperation(
                "social",
                triageSocialChannels,
                "Conversaciones sociales revisadas.",
              )}
              onResolve={resolveCompanyAction}
              onPolicy={updateCompanyPolicy}
              onUpdateLead={(leadId, patch) => runCompanyOperation(
                `lead:${leadId}`,
                (projectId) => codexApi.updateCompanyLead(projectId, leadId, patch),
                patch.status === "do_not_contact" ? "Lead marcado como no contactar." : "Contacto actualizado.",
              )}
              onOutreach={(leadId) => runCompanyOperation(
                `outreach:${leadId}`,
                (projectId) => codexApi.prepareLeadOutreach(projectId, leadId),
                "Correo comercial preparado según la política.",
              )}
            />
          </div>
        ) : null}
        <MarketingPublishingPanel
          operations={operations}
          posts={posts}
          draft={draft}
          caption={caption}
          onCaptionChange={setCaption}
          selectedPlatforms={selectedPlatforms}
          allowedPlatforms={marketingAllowedPlatforms}
          onTogglePlatform={toggleComposerPlatform}
          delivery={delivery}
          onDeliveryChange={setDelivery}
          scheduledAt={scheduledAt}
          onScheduledAtChange={setScheduledAt}
          postBusy={postBusy}
          onSubmit={() => void submitTextPost()}
          saving={saving}
          onPatchPolicy={patchDraft}
          onPatchPlatform={patchPlatform}
          onSavePolicy={() => void save()}
        />
      </div>
    )
  }

  return (
    <ViewBody>
      {companyOps ? (
        <CompanyOperationsPanel
          compact
          operations={companyOps}
          context={companyOpsContext}
          busy={companyOpsBusy}
          onResearch={() => runCompanyOperation(
            "research",
            (projectId) => codexApi.researchCompanyLeads(projectId),
            "Investigación comercial actualizada.",
          )}
          onTriage={() => runCompanyOperation(
            "inbox",
            (projectId) => codexApi.triageCompanyInbox(projectId),
            "Bandeja revisada y acciones preparadas.",
          )}
          onSocialTriage={() => runCompanyOperation(
            "social",
            triageSocialChannels,
            "Conversaciones sociales revisadas.",
          )}
          onResolve={resolveCompanyAction}
          onPolicy={updateCompanyPolicy}
          onUpdateLead={(leadId, patch) => runCompanyOperation(
            `lead:${leadId}`,
            (projectId) => codexApi.updateCompanyLead(projectId, leadId, patch),
            patch.status === "do_not_contact" ? "Lead marcado como no contactar." : "Contacto actualizado.",
          )}
          onOutreach={(leadId) => runCompanyOperation(
            `outreach:${leadId}`,
            (projectId) => codexApi.prepareLeadOutreach(projectId, leadId),
            "Correo comercial preparado según la política.",
          )}
        />
      ) : null}

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

function MarketingPublishingPanel({
  operations,
  posts,
  draft,
  caption,
  onCaptionChange,
  selectedPlatforms,
  allowedPlatforms,
  onTogglePlatform,
  delivery,
  onDeliveryChange,
  scheduledAt,
  onScheduledAtChange,
  postBusy,
  onSubmit,
  saving,
  onPatchPolicy,
  onPatchPlatform,
  onSavePolicy,
}: {
  operations: CompanySocialOperations
  posts: CompanySocialPost[]
  draft: CompanySocialPolicy
  caption: string
  onCaptionChange: (value: string) => void
  selectedPlatforms: CompanySocialPlatform[]
  allowedPlatforms: CompanySocialPlatform[]
  onTogglePlatform: (platform: CompanySocialPlatform) => void
  delivery: "now" | "scheduled"
  onDeliveryChange: (value: "now" | "scheduled") => void
  scheduledAt: string
  onScheduledAtChange: (value: string) => void
  postBusy: boolean
  onSubmit: () => void
  saving: boolean
  onPatchPolicy: (patch: Partial<CompanySocialPolicy>) => void
  onPatchPlatform: (platform: CompanySocialPlatform, enabled: boolean) => void
  onSavePolicy: () => void
}) {
  const connectedPlatforms = React.useMemo(
    () => new Set(
      operations.providers
        .filter((provider) => (
          provider.connection?.connected
          && provider.supports.text
          && allowedPlatforms.includes(provider.platform)
          && draft.platforms[provider.platform]
        ))
        .map((provider) => provider.platform),
    ),
    [allowedPlatforms, draft.platforms, operations.providers],
  )

  return (
    <section
      className="mx-auto w-full max-w-[1100px] px-4 pb-12 sm:px-6 lg:px-8"
      aria-label="Operación de Marketing"
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">Departamento de Marketing</p>
          <h2 className="mt-1 text-lg font-semibold">Publicación y control de salida</h2>
          <p className="mt-1 text-xs text-zinc-500">
            La política, la cola y el historial pertenecen únicamente a esta empresa.
          </p>
        </div>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-[11px] font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
          {operations.metrics.queued} pendientes · {operations.metrics.publishedToday} publicadas hoy
        </span>
      </div>

      <div className="grid overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-[0_12px_40px_-30px_rgba(15,23,42,0.35)] dark:border-white/10 dark:bg-zinc-950 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)]">
        <div className="p-5 xl:border-r xl:border-zinc-100 dark:xl:border-white/5">
          <Label htmlFor="company-marketing-caption" className="text-xs font-semibold">Contenido</Label>
          <Textarea
            id="company-marketing-caption"
            value={caption}
            onChange={(event) => onCaptionChange(event.target.value)}
            placeholder="Escribe el contenido que Marketing publicará..."
            maxLength={5_000}
            className="mt-2 min-h-[140px] resize-y rounded-xl border-zinc-200 text-sm leading-relaxed dark:border-white/10"
          />
          <div className="mt-2 text-right text-[10px] tabular-nums text-zinc-400">{caption.length}/5000</div>

          <div className="mt-4">
            <Label className="text-xs font-semibold">Canales conectados</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {operations.providers.map((provider) => {
                const connected = connectedPlatforms.has(provider.platform)
                const selected = selectedPlatforms.includes(provider.platform)
                const mark = SOCIAL_PROVIDER_MARKS[provider.platform]
                return (
                  <button
                    key={`marketing-${provider.platform}`}
                    type="button"
                    disabled={!connected}
                    onClick={() => onTogglePlatform(provider.platform)}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      selected
                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-950"
                        : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300",
                    )}
                    aria-pressed={selected}
                  >
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold", mark.className)}>
                      {mark.mark}
                    </span>
                    {provider.label}
                    {selected ? <Check className="h-3.5 w-3.5" /> : null}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]">
            <div className="flex h-10 items-center rounded-full border border-zinc-200 p-1 dark:border-white/10">
              {([
                ["now", "Ahora"],
                ["scheduled", "Programar"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onDeliveryChange(value)}
                  className={cn(
                    "h-8 rounded-full px-3 text-xs font-medium",
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
                onChange={(event) => onScheduledAtChange(event.target.value)}
                className="h-10 rounded-full border-zinc-200 dark:border-white/10"
                aria-label="Fecha y hora de publicación"
              />
            ) : (
              <div className="flex h-10 items-center rounded-full bg-zinc-50 px-4 text-xs text-zinc-500 dark:bg-zinc-900">
                Se enviará al confirmar.
              </div>
            )}
          </div>

          <Button
            type="button"
            className="mt-4 h-10 w-full rounded-full"
            onClick={onSubmit}
            disabled={
              !caption.trim()
              || selectedPlatforms.length === 0
              || postBusy
              || (delivery === "scheduled" && !scheduledAt)
            }
          >
            {postBusy
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : delivery === "now"
                ? <Send className="mr-2 h-4 w-4" />
                : <CalendarClock className="mr-2 h-4 w-4" />}
            {postBusy ? "Procesando..." : delivery === "now" ? "Publicar ahora" : "Programar publicación"}
          </Button>
        </div>

        <div className="border-t border-zinc-100 p-5 dark:border-white/5 xl:border-t-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Política de Marketing</h3>
              <p className="mt-1 text-[11px] text-zinc-500">Control explícito por empresa.</p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) => onPatchPolicy({ enabled })}
              aria-label="Habilitar publicación para esta empresa"
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-900">
            {([
              ["review", "Con revisión"],
              ["auto", "Automático"],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onPatchPolicy({ mode })}
                className={cn(
                  "h-9 rounded-lg text-xs font-medium",
                  draft.mode === mode ? "bg-white shadow-sm dark:bg-zinc-950" : "text-zinc-500",
                )}
                aria-pressed={draft.mode === mode}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-zinc-200/80 px-3 py-2.5 dark:border-white/10">
            <div>
              <p className="text-xs font-semibold">Contenido diario</p>
              <p className="mt-0.5 text-[10px] text-zinc-500">Marketing operará con los recursos que tenga asignados.</p>
            </div>
            <Switch
              checked={draft.autopilot}
              onCheckedChange={(autopilot) => onPatchPolicy({ autopilot })}
              disabled={draft.mode !== "auto"}
              aria-label="Habilitar contenido diario de Marketing"
            />
          </div>

          <div className="mt-4 space-y-1.5">
            <p className="text-xs font-semibold">Canales habilitados</p>
            {operations.providers.map((provider) => {
              const assigned = allowedPlatforms.includes(provider.platform)
                && Boolean(provider.connection?.connected)
              return (
                <label
                  key={`marketing-policy-${provider.platform}`}
                  className="flex min-h-9 items-center justify-between gap-3 rounded-lg px-2 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <span>
                    {provider.label}
                    {!assigned ? (
                      <span className="ml-1.5 text-[10px] text-zinc-400">No asignado</span>
                    ) : null}
                  </span>
                  <Switch
                    checked={assigned && draft.platforms[provider.platform]}
                    onCheckedChange={(enabled) => onPatchPlatform(provider.platform, enabled)}
                    disabled={!assigned}
                    aria-label={`Habilitar ${provider.label} para Marketing`}
                  />
                </label>
              )
            })}
          </div>

          <Label htmlFor="company-marketing-objective" className="mt-4 block text-xs font-semibold">Objetivo</Label>
          <Textarea
            id="company-marketing-objective"
            value={draft.objective}
            onChange={(event) => onPatchPolicy({ objective: event.target.value })}
            placeholder="Ej. Educar al mercado y captar oportunidades calificadas."
            maxLength={2_000}
            className="mt-2 min-h-[88px] resize-none rounded-xl text-xs"
          />

          <div className="mt-4 flex items-center justify-between gap-3">
            <Label htmlFor="company-marketing-daily-limit" className="text-xs font-semibold">Límite diario</Label>
            <Input
              id="company-marketing-daily-limit"
              type="number"
              min={1}
              max={20}
              value={draft.dailyLimit}
              onChange={(event) => onPatchPolicy({
                dailyLimit: Math.max(1, Math.min(20, Number(event.target.value) || 1)),
              })}
              className="h-9 w-20 rounded-full text-right text-xs tabular-nums"
            />
          </div>

          <Button
            type="button"
            variant="outline"
            className="mt-4 w-full rounded-full"
            onClick={onSavePolicy}
            disabled={saving}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Guardar para esta empresa
          </Button>

          <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-white/5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold">Actividad reciente</h3>
              <span className="text-[10px] tabular-nums text-zinc-400">{posts.length} registros</span>
            </div>
            <div className="mt-2 space-y-2">
              {posts.slice(0, 4).map((post) => (
                <div key={post.id} className="rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
                  <p className="truncate text-[11px] font-medium">{post.caption || post.prompt}</p>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {post.status === "published"
                      ? "Publicado"
                      : post.status === "scheduled"
                        ? "Programado"
                        : post.status === "publishing"
                          ? "Publicando"
                          : post.status === "failed"
                            ? "Falló"
                            : "Borrador"}
                    {" · "}
                    {relativeActivity(Date.parse(post.publishedAt || post.scheduledAt || post.createdAt))}
                  </p>
                </div>
              ))}
              {posts.length === 0 ? (
                <p className="rounded-xl bg-zinc-50 px-3 py-4 text-center text-[11px] text-zinc-500 dark:bg-zinc-900">
                  Todavía no hay publicaciones para esta empresa.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function CompanyOperationsPanel({
  operations,
  context,
  busy,
  compact = false,
  onResearch,
  onTriage,
  onSocialTriage,
  onResolve,
  onPolicy,
  onUpdateLead,
  onOutreach,
}: {
  operations: CodexCompanyOperations
  context: CodexCompanyContext | null
  busy: string | null
  compact?: boolean
  onResearch: () => void | Promise<void>
  onTriage: () => void | Promise<void>
  onSocialTriage: () => void | Promise<void>
  onResolve: (action: CodexExternalAction, decision: "approve" | "reject") => void | Promise<void>
  onPolicy: (field: "emailReplies" | "socialReplies" | "leadOutreach", mode: "review" | "auto" | "off") => void | Promise<void>
  onUpdateLead: (leadId: string, patch: { email?: string; status?: string }) => void | Promise<void>
  onOutreach: (leadId: string) => void | Promise<void>
}) {
  const [leadEmails, setLeadEmails] = React.useState<Record<string, string>>({})
  const pendingActions = operations.actions.filter((action) =>
    ["pending_review", "approved", "error"].includes(action.status),
  )
  const modes = ["review", "auto", "off"] as const
  const modeLabel = { review: "Revisión", auto: "Auto", off: "Pausado" } as const
  const policyRows = [
    {
      field: "emailReplies" as const,
      label: "Respuestas por correo",
      value: context?.profile.autonomy.emailReplies || "review",
    },
    {
      field: "leadOutreach" as const,
      label: "Prospección comercial",
      value: context?.profile.autonomy.leadOutreach || "review",
    },
    {
      field: "socialReplies" as const,
      label: "Respuestas en redes",
      value: context?.profile.autonomy.socialReplies || "review",
    },
  ]

  return (
    <section
      className={cn(
        compact
          ? "mb-6 border-y border-border/55 py-4"
          : "mt-8 border-y border-zinc-200 py-6 dark:border-white/10",
      )}
      data-testid="company-operations-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BriefcaseBusiness className="h-4 w-4 text-muted-foreground" />
            <h2 className={compact ? "text-sm font-semibold" : "text-base font-semibold"}>
              Clientes, canales y ventas
            </h2>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {operations.counts.leads} leads · {operations.counts.pendingInbox} conversaciones · {operations.counts.pendingActions} aprobaciones
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-md"
            onClick={() => void onResearch()}
            disabled={Boolean(busy)}
          >
            {busy === "research" ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-2 h-3.5 w-3.5" />}
            Buscar clientes
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-md"
            onClick={() => void onTriage()}
            disabled={Boolean(busy)}
          >
            {busy === "inbox" ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <MessageSquareText className="mr-2 h-3.5 w-3.5" />}
            Revisar correo
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-md"
            onClick={() => void onSocialTriage()}
            disabled={Boolean(busy)}
          >
            {busy === "social" ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Radio className="mr-2 h-3.5 w-3.5" />}
            Revisar redes
          </Button>
        </div>
      </div>

      <div className={cn("mt-5 grid gap-6", !compact && "lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]")}>
        <div>
          <h3 className="text-xs font-semibold">Políticas de salida</h3>
          <div className="mt-2 divide-y divide-border/45 border-y border-border/45">
            {policyRows.map((row) => (
              <div key={row.field} className="py-3">
                <span className="text-[11px] font-medium">{row.label}</span>
                <div className="mt-2 grid grid-cols-3 gap-1 rounded-md bg-muted/55 p-1">
                  {modes.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={cn(
                        "h-8 rounded text-[10px] font-semibold",
                        row.value === mode ? "bg-background shadow-sm" : "text-muted-foreground",
                      )}
                      onClick={() => void onPolicy(row.field, mode)}
                      disabled={Boolean(busy)}
                      aria-pressed={row.value === mode}
                    >
                      {modeLabel[mode]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <h3 className="mt-5 text-xs font-semibold">Acciones pendientes</h3>
          <div className="mt-2 divide-y divide-border/45 border-y border-border/45">
            {pendingActions.slice(0, 6).map((action) => (
              <div key={action.id} className="py-3">
                <p className="truncate text-[11px] font-semibold">
                  {action.kind === "email_reply"
                    ? "Responder correo"
                    : action.kind === "lead_outreach"
                      ? "Contactar lead"
                      : action.kind === "social_reply"
                        ? `Responder en ${action.payload.platform || "red social"}`
                        : "Acción externa"}
                </p>
                <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                  {action.payload.subject || action.payload.body || action.error || "Sin vista previa"}
                </p>
                <div className="mt-2 space-y-1 text-[10px]">
                  <p>
                    <span className="font-semibold">Para:</span>{" "}
                    <span className="break-all text-muted-foreground">
                      {action.payload.to || (action.kind === "social_reply" ? "Autor de la conversación" : "Destinatario del hilo")}
                    </span>
                  </p>
                  <p>
                    <span className="font-semibold">Asunto:</span>{" "}
                    <span className="text-muted-foreground">{action.payload.subject || "Respuesta al hilo original"}</span>
                  </p>
                  {action.kind !== "social_reply" && action.payload._approval ? (
                    <p className="break-all text-[9px] text-muted-foreground">
                      <span className="font-semibold">Aprobación:</span>{" "}
                      v{action.payload._approval.version || "?"} · {action.payload._approval.actionHash || "hash ausente"}
                    </p>
                  ) : null}
                  <details className="border-y border-border/45 py-2">
                    <summary className="cursor-pointer font-semibold">Revisar mensaje completo</summary>
                    <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
                      {action.payload.body || action.error || "Sin contenido disponible."}
                    </p>
                  </details>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 rounded-md text-[11px]"
                    onClick={() => {
                      if (window.confirm("Esta acción enviará el mensaje mostrado. ¿Deseas aprobar y enviar?")) {
                        void onResolve(action, "approve")
                      }
                    }}
                    disabled={Boolean(busy)}
                  >
                    {busy === `action:${action.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                    Aprobar y enviar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-md text-[11px]"
                    onClick={() => void onResolve(action, "reject")}
                    disabled={Boolean(busy)}
                  >
                    Rechazar
                  </Button>
                </div>
              </div>
            ))}
            {pendingActions.length === 0 ? (
              <p className="py-5 text-center text-[11px] text-muted-foreground">Sin acciones pendientes.</p>
            ) : null}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold">Pipeline comercial</h3>
          <div className="mt-2 divide-y divide-border/45 border-y border-border/45">
            {operations.leads.slice(0, 8).map((lead) => (
              <div key={lead.id} className="py-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold tabular-nums">
                    {lead.score}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-semibold">{lead.companyName}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      {lead.status} · {lead.domain || lead.sourceTitle || "fuente pública"}
                    </span>
                    {lead.evidence ? (
                      <span className="mt-1 line-clamp-2 block text-[10px] leading-relaxed text-muted-foreground">
                        {lead.evidence}
                      </span>
                    ) : null}
                  </span>
                  <a
                    href={lead.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Abrir fuente de ${lead.companyName}`}
                    title="Abrir fuente"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                {lead.email ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 rounded-md text-[11px]"
                    onClick={() => void onOutreach(lead.id)}
                    disabled={Boolean(busy) || lead.status === "do_not_contact"}
                  >
                    {busy === `outreach:${lead.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                    Preparar correo
                  </Button>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <Input
                      type="email"
                      value={leadEmails[lead.id] || ""}
                      onChange={(event) => setLeadEmails((current) => ({
                        ...current,
                        [lead.id]: event.target.value,
                      }))}
                      placeholder="Correo verificado"
                      aria-label={`Correo verificado de ${lead.companyName}`}
                      className="h-8 min-w-0 flex-1 rounded-md text-[11px]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-md px-2 text-[11px]"
                      onClick={() => void onUpdateLead(lead.id, { email: leadEmails[lead.id] || "" })}
                      disabled={Boolean(busy) || !(leadEmails[lead.id] || "").includes("@")}
                    >
                      Guardar
                    </Button>
                  </div>
                )}
                {lead.status === "do_not_contact" ? (
                  <p className="mt-2 text-[10px] font-semibold text-muted-foreground">No contactar</p>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-8 rounded-md px-2 text-[10px] text-muted-foreground"
                    onClick={() => void onUpdateLead(lead.id, { status: "do_not_contact" })}
                    disabled={Boolean(busy)}
                  >
                    <X className="mr-1.5 h-3.5 w-3.5" />
                    No contactar
                  </Button>
                )}
              </div>
            ))}
            {operations.leads.length === 0 ? (
              <p className="py-5 text-center text-[11px] text-muted-foreground">
                Aún no hay leads respaldados por fuentes.
              </p>
            ) : null}
          </div>

          <h3 className="mt-5 text-xs font-semibold">Bandeja priorizada</h3>
          <div className="mt-2 divide-y divide-border/45 border-y border-border/45">
            {operations.inboxItems.slice(0, 6).map((item) => (
              <div key={item.id} className="flex items-start gap-3 py-3">
                <span className={cn(
                  "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
                  item.urgency === "critical" || item.urgency === "high" ? "bg-amber-500" : "bg-zinc-300",
                )} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold">{item.subject || "Sin asunto"}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {item.provider === "gmail" ? "Correo" : item.provider.toUpperCase()} · {item.senderName || item.senderEmail || "Remitente"} · {item.category} · urgencia {item.urgency} · {item.status}
                  </span>
                </span>
              </div>
            ))}
            {operations.inboxItems.length === 0 ? (
              <p className="py-5 text-center text-[11px] text-muted-foreground">Bandeja aún no revisada.</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
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

function okrStatusLabel(status: CodexObjectivePortfolio["objectives"][number]["status"]): string {
  if (status === "at_risk") return "En riesgo"
  if (status === "done") return "Completado"
  if (status === "paused") return "En pausa"
  return "Activo"
}

function CompanyOkrPortfolio({ portfolio }: { portfolio: CodexObjectivePortfolio }) {
  const latestReview = portfolio.latestReview
  return (
    <section
      className="mt-7 border-y border-zinc-200 py-6 dark:border-white/10"
      data-testid="company-okr-portfolio"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase text-zinc-500">OKRs empresariales</p>
          <h2 className="mt-1 text-lg font-semibold">Prioridades revisadas por CEO Office</h2>
        </div>
        <div className="text-right text-[11px] text-zinc-500">
          <p>
            Revisión {portfolio.revision} · {portfolio.summary.active} activos ·{" "}
            {portfolio.summary.atRisk} en riesgo
          </p>
          <p className="mt-1">
            {latestReview
              ? `${latestReview.reviewer} · ${relativeActivityFromDate(latestReview.createdAt)}`
              : "Pendiente de la primera revisión estructurada"}
          </p>
        </div>
      </div>

      {portfolio.objectives.length ? (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {portfolio.objectives.slice(0, 5).map((objective) => {
            const measured = objective.keyResults.filter((keyResult) => keyResult.progress != null)
            const progress = measured.length
              ? Math.round(measured.reduce((sum, keyResult) => sum + Number(keyResult.progress), 0) / measured.length)
              : objective.status === "done"
                ? 100
                : 0
            return (
              <article
                key={objective.id}
                className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900"
                data-testid="company-okr-objective"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-[11px] font-semibold tabular-nums dark:border-white/10">
                    {objective.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 flex-1 text-[13px] font-semibold">{objective.title}</h3>
                      <span className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-medium",
                        objective.status === "done"
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : objective.status === "at_risk"
                            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                            : objective.status === "paused"
                              ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                              : "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
                      )}>
                        {okrStatusLabel(objective.status)}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-zinc-900 dark:bg-zinc-100"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <strong className="text-[11px] tabular-nums">{progress}%</strong>
                    </div>
                    <ul className="mt-3 space-y-2">
                      {objective.keyResults.slice(0, 5).map((keyResult) => (
                        <li key={keyResult.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                          <span className={cn(
                            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                            keyResult.status === "achieved"
                              ? "bg-emerald-500"
                              : keyResult.status === "at_risk"
                                ? "bg-amber-500"
                                : keyResult.status === "on_track"
                                  ? "bg-sky-500"
                                  : "bg-zinc-300 dark:bg-zinc-700",
                          )} />
                          <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-300">
                            {keyResult.title}
                            {keyResult.target ? ` · Meta ${keyResult.target}` : ""}
                          </span>
                          {keyResult.progress == null ? null : (
                            <span className="shrink-0 tabular-nums text-zinc-500">{keyResult.progress}%</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {objective.keyResults.length === 0 ? (
                      <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
                        CEO Office debe definir resultados clave medibles en la siguiente revisión.
                      </p>
                    ) : null}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-300 px-5 py-8 text-center dark:border-white/15">
          <p className="text-sm font-medium">Aún no hay OKRs persistentes</p>
          <p className="mt-1 text-xs text-zinc-500">
            CEO Office los definirá y repriorizará con métricas y resultados clave en el siguiente ciclo.
          </p>
        </div>
      )}
    </section>
  )
}

function CompanyDashboardSurface({
  companyName,
  snapshot,
  sessions,
  runs,
  checkpointCount,
  proactiveState,
  companyContext,
  commandCenter,
  activity,
  departments,
  departmentCount,
  rootSessionId,
  onStart,
  onPause,
  onCancel,
  onOpenDepartment,
  onOpenCeo,
  onOpenTask,
}: {
  companyName: string
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  sessions: CodeChatSession[]
  runs: CodexRun[]
  checkpointCount: number
  proactiveState: CodexProactiveState
  companyContext: CodexCompanyContext | null
  commandCenter: CodexEnterpriseCommandCenter | null
  activity: CodexProjectActivity[]
  departments: readonly AgentDepartmentDefinition[]
  departmentCount: number
  rootSessionId: string | null
  onStart: () => void
  onPause: () => void
  onCancel: () => void
  onOpenDepartment: (departmentId: string) => void
  onOpenCeo: () => void
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
  const commandReadiness: EnterpriseReadiness = commandCenter?.readiness
    ?? enterpriseReadiness(companyContext, runs, proactiveState)
  const commandSwarm: EnterpriseSwarmSummary = commandCenter?.swarmSummary
    ?? enterpriseSwarmSummary(runs)
  const commandDepartments: EnterpriseDepartment[] = commandCenter
    ? commandCenter.departments.map((department) => ({
        ...department,
        currentWork: department.currentWork || undefined,
      }))
    : enterpriseDepartments(departments, runs)
  const commandEvents: EnterpriseLiveEvent[] = commandCenter?.liveEvents
    ?? enterpriseLiveEvents(activity)
  const commandExecutiveSummary = commandCenter?.executiveSummary ?? {
    title: "Informe del CEO Office",
    summary: objective,
    updatedAt: new Date().toISOString(),
    highlights: [
      `${completed} ejecuciones completadas`,
      `${checkpointCount} evidencias verificables`,
    ],
    risks: attention.length ? [`${attention.length} ejecuciones requieren atención`] : [],
    nextActions: ["Definir el siguiente resultado medible desde CEO Office"],
  }
  const operationActive = commandReadiness.runState === "running"
  const operationPaused = commandReadiness.runState === "paused"

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
          operationActive
            ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
            : "border-zinc-200 bg-white text-zinc-600 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300",
        )}>
          <span className={cn("h-2 w-2 rounded-full", operationActive ? "bg-emerald-500" : operationPaused ? "bg-amber-500" : "bg-zinc-400")} />
          {operationActive ? "Operación activa" : operationPaused ? "Operación en pausa" : "Lista para ejecutar"}
        </span>
      </div>

      <EnterpriseCommandCenter
        className="mt-7"
        readiness={commandReadiness}
        mission={commandCenter?.mission || companyContext?.profile.mission || "Pendiente de confirmar con evidencia del negocio."}
        vision={commandCenter?.vision || companyContext?.profile.vision || "Pendiente de confirmar con evidencia del negocio."}
        swarmSummary={commandSwarm}
        departments={commandDepartments}
        liveEvents={commandEvents}
        executiveSummary={commandExecutiveSummary}
        onStart={onStart}
        onPause={onPause}
        onCancel={onCancel}
        onOpen={(target) => {
          if (target.type === "department") {
            onOpenDepartment(target.id)
            return
          }
          onOpenCeo()
        }}
      />

      {companyContext?.okrs ? <CompanyOkrPortfolio portfolio={companyContext.okrs} /> : null}

      {!commandCenter && companyContext ? (
        <section className="mt-7 border-y border-zinc-200 py-6 dark:border-white/10" data-testid="company-operating-diagnosis">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase text-zinc-500">Diagnóstico empresarial</p>
              <h2 className="mt-2 text-xl font-semibold">Contexto compartido por todos los departamentos</h2>
            </div>
            <div className="min-w-[180px] text-right">
              <span className="text-3xl font-semibold tabular-nums">{companyContext.readiness.score}%</span>
              <p className="mt-1 text-[11px] text-zinc-500">
                {companyContext.readiness.readyCount} de {companyContext.readiness.total} áreas listas
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase text-zinc-500">Misión</p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                {companyContext.profile.mission || "Pendiente de confirmar con evidencia del negocio."}
              </p>
            </div>
            <div className="min-w-0 lg:border-l lg:border-zinc-200 lg:pl-5 dark:lg:border-white/10">
              <p className="text-[11px] font-semibold uppercase text-zinc-500">Visión</p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                {companyContext.profile.vision || "Pendiente de confirmar con evidencia del negocio."}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 sm:grid-cols-2 xl:grid-cols-4 dark:border-white/10 dark:bg-white/10">
            {companyContext.readiness.areas.map((area) => (
              <div key={area.id} className="min-h-[112px] bg-white p-4 dark:bg-zinc-900">
                <div className="flex items-center gap-2">
                  {area.status === "ready" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <AlertTriangle className={cn(
                      "h-4 w-4 shrink-0",
                      area.status === "blocked" ? "text-red-500" : "text-amber-500",
                    )} />
                  )}
                  <span className="truncate text-xs font-semibold">{area.label}</span>
                </div>
                <p className="mt-3 line-clamp-3 text-[11px] leading-relaxed text-zinc-500">
                  {area.status === "ready" ? area.evidence : area.action}
                </p>
              </div>
            ))}
          </div>

          {companyContext.portfolio ? (
            <div className="mt-6" data-testid="company-mission-portfolio">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase text-zinc-500">Misiones de CEO Office</p>
                  <h3 className="mt-1 text-base font-semibold">Prioridades derivadas de evidencia real</h3>
                </div>
                <p className="text-[11px] text-zinc-500">
                  {companyContext.portfolio.summary.readyToExecute} ejecutables ·{" "}
                  {companyContext.portfolio.summary.blocked} bloqueadas ·{" "}
                  {companyContext.portfolio.summary.reviewRequired} por revisar
                </p>
              </div>
              <div className="mt-3 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-white/10 dark:border-white/10">
                {companyContext.portfolio.missions.slice(0, 8).map((mission) => (
                  <div key={mission.id} className="grid gap-2 py-3 md:grid-cols-[36px_minmax(0,1fr)_180px] md:items-center">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 text-[11px] font-semibold tabular-nums dark:border-white/10">
                      {mission.priority}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{mission.title}</span>
                      <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-zinc-500">
                        {mission.nextAction}
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-3 text-[11px] md:justify-end">
                      <span className="truncate text-zinc-500">{mission.departmentName}</span>
                      <span className={cn(
                        "h-2.5 w-2.5 shrink-0 rounded-full",
                        mission.status === "completed"
                          ? "bg-emerald-500"
                          : mission.status === "ready_to_execute"
                            ? "bg-sky-500"
                            : mission.status === "review_required"
                              ? "bg-amber-500"
                              : mission.status === "paused"
                                ? "bg-zinc-400"
                                : "bg-red-500",
                      )} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

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
  companyContext,
  commandCenter,
  activity,
  departments,
  departmentCount,
  rootSessionId,
  onStart,
  onPause,
  onCancel,
  onOpenDepartment,
  onOpenCeo,
  onOpenTask,
  surface = false,
}: {
  companyName: string
  snapshot: ReturnType<typeof buildAgentCompanySnapshot>
  sessions: CodeChatSession[]
  runs: CodexRun[]
  checkpointCount: number
  proactiveState: CodexProactiveState
  companyContext: CodexCompanyContext | null
  commandCenter: CodexEnterpriseCommandCenter | null
  activity: CodexProjectActivity[]
  departments: readonly AgentDepartmentDefinition[]
  departmentCount: number
  rootSessionId: string | null
  onStart: () => void
  onPause: () => void
  onCancel: () => void
  onOpenDepartment: (departmentId: string) => void
  onOpenCeo: () => void
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
        companyContext={companyContext}
        commandCenter={commandCenter}
        activity={activity}
        departments={departments}
        departmentCount={departmentCount}
        rootSessionId={rootSessionId}
        onStart={onStart}
        onPause={onPause}
        onCancel={onCancel}
        onOpenDepartment={onOpenDepartment}
        onOpenCeo={onOpenCeo}
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

type CompanyArtifact = CompanyAgentFileArtifact

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

function artifactTypeLabel(artifact: CompanyArtifact): string {
  if (artifact.kind === "report") return "Reporte"
  if (["ts", "tsx", "js", "jsx"].includes(artifact.extension)) return "Código"
  if (["json", "html", "css", "py"].includes(artifact.extension)) return "Fuente"
  if (["csv", "xls", "xlsx"].includes(artifact.extension)) return "Hoja"
  if (["md", "mdx", "txt", "doc", "docx", "pdf"].includes(artifact.extension)) return "Documento"
  return "Archivo"
}

function artifactSizeLabel(content: string): string {
  const bytes = Math.max(0, content.length)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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

function missionReviewLabel(status: CodexMissionReviewStatus): string {
  if (status === "approved") return "Aprobado por CEO"
  if (status === "changes_requested") return "Cambios solicitados"
  if (status === "rejected") return "Rechazado por CEO"
  return "Pendiente de CEO"
}

function reportDeliveryLabel(status: string): string {
  if (status === "queued") return "En cola de correo"
  if (status === "blocked_connection") return "Falta conexión de correo"
  if (status === "blocked_policy") return "Correo desactivado"
  if (status === "pending_permission") return "Falta permiso"
  return "Borrador"
}

function FilesView({
  companyName,
  codexProjectId,
  files,
  sessions,
  runs = [],
  workers = [],
  missionEvidence = null,
  rootSessionId = null,
  departments,
  surface = false,
}: {
  companyName: string
  codexProjectId: string | null
  files: CodeFiles
  sessions: CodeChatSession[]
  runs?: readonly CodexRun[]
  workers?: readonly AgentOfficeWorker[]
  missionEvidence?: CodexMissionEvidenceLedger | null
  rootSessionId?: string | null
  departments: readonly AgentDepartmentDefinition[]
  surface?: boolean
}) {
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState<"all" | "reports" | "files">("all")
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [missionLedger, setMissionLedger] = React.useState<CodexMissionEvidenceLedger | null>(null)
  const [missionBusy, setMissionBusy] = React.useState<string | null>(null)
  const [missionError, setMissionError] = React.useState<string | null>(null)
  const [expandedRecordId, setExpandedRecordId] = React.useState<string | null>(null)
  const [viewMode, setViewMode] = React.useState<"icons" | "list">("icons")

  const refreshMissionLedger = React.useCallback(async () => {
    if (!codexProjectId) {
      setMissionLedger(null)
      setMissionError(null)
      return
    }
    try {
      const ledger = await codexApi.getMissionEvidence(codexProjectId)
      setMissionLedger(ledger)
      setMissionError(null)
    } catch (error) {
      setMissionError(error instanceof Error ? error.message : "No se pudo cargar la evidencia.")
    }
  }, [codexProjectId])

  React.useEffect(() => {
    void refreshMissionLedger()
  }, [refreshMissionLedger])

  const reviewMission = React.useCallback(async (
    record: CodexMissionEvidenceRecord,
    status: CodexMissionReviewStatus,
  ) => {
    if (!codexProjectId || missionBusy) return
    setMissionBusy(`review:${record.id}`)
    try {
      const updated = await codexApi.reviewMissionEvidence(codexProjectId, record.id, status)
      setMissionLedger((current) => current ? {
        ...current,
        summary: {
          ...current.summary,
          pendingReview: current.records.filter((item) => (
            item.id === updated.id ? updated : item
          )).filter((item) => item.ceoReview.status === "pending").length,
          approved: current.records.filter((item) => (
            item.id === updated.id ? updated : item
          )).filter((item) => item.ceoReview.status === "approved").length,
        },
        records: current.records.map((item) => item.id === updated.id ? updated : item),
      } : current)
      toast.success(
        status === "approved"
          ? "Entregable aprobado por CEO Office."
          : status === "rejected"
            ? "Entregable rechazado por CEO Office."
            : "Cambios solicitados a la misión.",
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo guardar la revisión.")
    } finally {
      setMissionBusy(null)
    }
  }, [codexProjectId, missionBusy])

  const createReport = React.useCallback(async (queueEmail: boolean) => {
    if (!codexProjectId || missionBusy) return
    setMissionBusy(queueEmail ? "report:email" : "report:draft")
    try {
      const report = await codexApi.createActivityReport(codexProjectId, {
        days: 7,
        requestEmail: queueEmail,
        confirmEmailQueue: queueEmail,
      })
      await refreshMissionLedger()
      if (report.delivery.status === "queued") {
        toast.success("Reporte preparado y puesto en cola. No se envió ningún correo.")
      } else if (queueEmail) {
        toast.info(report.delivery.reason || "El reporte quedó como borrador.")
      } else {
        toast.success("Resumen de actividad creado como borrador.")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo generar el reporte.")
    } finally {
      setMissionBusy(null)
    }
  }, [codexProjectId, missionBusy, refreshMissionLedger])

  const built = React.useMemo(() => buildCompanyAgentFileArtifacts({
    companyName,
    departments,
    files,
    sessions,
    runs,
    workers,
    missionEvidence: missionLedger || missionEvidence,
    rootSessionId,
  }), [companyName, departments, files, missionEvidence, missionLedger, rootSessionId, runs, sessions, workers])

  const artifacts = built.artifacts
  const agentGroups = built.groups

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es")
    return artifacts.filter((artifact) => {
      if (filter === "reports" && artifact.kind !== "report") return false
      if (filter === "files" && artifact.kind !== "file") return false
      if (!needle) return true
      return `${artifact.name} ${artifact.path} ${artifact.departmentName} ${artifact.agentName}`
        .toLocaleLowerCase("es")
        .includes(needle)
    })
  }, [artifacts, filter, query])

  const groups = React.useMemo(() => {
    const allowed = new Set(filtered.map((artifact) => artifact.id))
    return agentGroups
      .map((group) => ({
        ...group,
        artifacts: group.artifacts.filter((artifact) => allowed.has(artifact.id)),
      }))
      .filter((group) => group.artifacts.length > 0)
  }, [agentGroups, filtered])

  const selected = artifacts.find((artifact) => artifact.id === selectedId) || null
  const reportCount = artifacts.filter((artifact) => artifact.kind === "report").length
  const workspaceFileCount = artifacts.length - reportCount
  const sidebarRows = [
    { value: "all" as const, label: "Todos", count: artifacts.length, icon: FolderOpen },
    { value: "reports" as const, label: "Reportes", count: reportCount, icon: FileText },
    { value: "files" as const, label: "Archivos", count: workspaceFileCount, icon: Folder },
  ]
  const missionSummary = missionLedger?.summary

  const body = (
    <SurfacePage testId="company-files-surface">
      <div className="min-h-[680px] overflow-hidden rounded-xl border border-zinc-300/80 bg-[#f4f4f2] shadow-[0_24px_80px_-50px_rgba(15,23,42,0.8)] dark:border-white/10 dark:bg-zinc-950">
        <div className="flex h-12 items-center gap-3 border-b border-zinc-300/70 bg-[#ededeb]/95 px-3 text-zinc-900 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/95 dark:text-zinc-50">
          <div className="flex shrink-0 items-center gap-2" aria-hidden="true">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]" />
          </div>
          <div className="hidden h-8 items-center gap-1 rounded-lg border border-zinc-300/70 bg-white/70 p-1 sm:flex dark:border-white/10 dark:bg-white/10" role="group" aria-label="Modo de vista">
            <button
              type="button"
              onClick={() => setViewMode("icons")}
              className={cn(
                "flex h-6 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white",
                viewMode === "icons" && "bg-white text-zinc-950 shadow-sm dark:bg-zinc-700 dark:text-white",
              )}
              aria-pressed={viewMode === "icons"}
              title="Iconos"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={cn(
                "flex h-6 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white",
                viewMode === "list" && "bg-white text-zinc-950 shadow-sm dark:bg-zinc-700 dark:text-white",
              )}
              aria-pressed={viewMode === "list"}
              title="Lista"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-w-0 flex-1 text-center">
            <div className="truncate text-[13px] font-semibold">{companyName}</div>
            <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">Archivos</div>
          </div>
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar"
              aria-label="Buscar archivos"
              className="h-8 rounded-lg border-zinc-300/70 bg-white/75 pl-8 text-[12px] shadow-inner dark:border-white/10 dark:bg-white/10"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100vh-220px)] lg:min-h-[520px] lg:flex-row">
          <aside className="shrink-0 border-b border-zinc-300/70 bg-[#e8e8e6]/90 p-3 dark:border-white/10 dark:bg-zinc-900/80 lg:w-56 lg:border-b-0 lg:border-r">
            <p className="px-2 text-[11px] font-semibold uppercase text-zinc-500 dark:text-zinc-400">Favoritos</p>
            <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
              {sidebarRows.map(({ value, label, count, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium transition-colors",
                    filter === value
                      ? "bg-white/85 text-zinc-950 shadow-sm dark:bg-white/12 dark:text-white"
                      : "text-zinc-600 hover:bg-white/55 dark:text-zinc-300 dark:hover:bg-white/8",
                  )}
                  aria-pressed={filter === value}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", value === "files" ? "text-[#0a84ff]" : "text-zinc-500 dark:text-zinc-400")} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="shrink-0 rounded-full bg-zinc-200/75 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-600 dark:bg-white/10 dark:text-zinc-300">{count}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="flex h-9 items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium text-zinc-600 hover:bg-white/55 dark:text-zinc-300 dark:hover:bg-white/8"
                title="Departamentos"
              >
                <PackageOpen className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                <span className="min-w-0 flex-1 truncate">Habilidades</span>
                <span className="shrink-0 rounded-full bg-zinc-200/75 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-600 dark:bg-white/10 dark:text-zinc-300">{departments.length}</span>
              </button>
            </div>

            <div className="mt-6 rounded-xl border border-zinc-300/70 bg-white/60 p-3 text-xs text-zinc-600 dark:border-white/10 dark:bg-white/8 dark:text-zinc-300">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">Evidencia</span>
                {missionLedger ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/45 dark:text-emerald-300">{missionSummary?.approved || 0}</span>
                ) : null}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <span><strong className="block text-base tabular-nums text-zinc-950 dark:text-white">{missionSummary?.missions || 0}</strong>misiones</span>
                <span><strong className="block text-base tabular-nums text-zinc-950 dark:text-white">{missionSummary?.pendingReview || 0}</strong>pendientes</span>
              </div>
              {missionError ? (
                <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{missionError}</span>
                </p>
              ) : null}
              {!missionLedger && codexProjectId && !missionError ? (
                <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Cargando
                </p>
              ) : null}
              <div className="mt-3 flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  disabled={!codexProjectId || Boolean(missionBusy)}
                  onClick={() => void createReport(false)}
                  title="Generar reporte"
                  aria-label="Generar reporte"
                >
                  {missionBusy === "report:draft" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  disabled={!codexProjectId || Boolean(missionBusy)}
                  onClick={() => void createReport(true)}
                  title="Preparar correo"
                  aria-label="Preparar correo"
                >
                  {missionBusy === "report:email" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </aside>

          <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-[#fbfbfa] text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
            <div className="sticky top-0 z-10 flex min-h-12 flex-wrap items-center gap-2 border-b border-zinc-200/80 bg-[#fbfbfa]/92 px-4 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/92">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold">Archivos</h1>
                <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  {filtered.length} elementos · {groups.length} agentes · {reportCount} reportes · {workspaceFileCount} archivos
                </p>
              </div>
              <div className="flex h-8 items-center rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 dark:border-white/10 dark:bg-white/10" role="group" aria-label="Filtrar archivos">
                {sidebarRows.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                    className={cn(
                      "h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors",
                      filter === value ? "bg-white text-zinc-950 shadow-sm dark:bg-zinc-700 dark:text-white" : "text-zinc-500 hover:text-zinc-950 dark:hover:text-white",
                    )}
                    aria-pressed={filter === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-4 py-5">
              {groups.map((group) => (
                <section key={group.id} className="mb-8 last:mb-0" data-testid="company-agent-files-group" data-agent-id={group.id}>
                  <div className="mb-3 flex items-center gap-2 px-1">
                    <span className="relative flex h-7 w-8 shrink-0 items-end">
                      <span className="absolute left-1 top-1 h-2.5 w-4 rounded-t-md bg-[#74c7ff]" />
                      <span className="relative h-5 w-8 rounded-[6px] bg-gradient-to-b from-[#62c5ff] to-[#0a84ff] shadow-sm" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-[13px] font-semibold">{group.name}</h2>
                      <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                        {(group as { departmentName?: string }).departmentName || "Empresa"} · {group.artifacts.length} elementos
                        {(group as { reportCount?: number }).reportCount ? ` · ${(group as { reportCount?: number }).reportCount} reportes` : ""}
                      </p>
                    </div>
                  </div>

                  {viewMode === "icons" ? (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-5 gap-y-7 sm:grid-cols-[repeat(auto-fill,minmax(118px,1fr))]">
                      {group.artifacts.map((artifact) => {
                        const Icon = artifactIcon(artifact.extension, artifact.kind)
                        const active = selectedId === artifact.id
                        return (
                          <button
                            key={artifact.id}
                            type="button"
                            onClick={() => setSelectedId(artifact.id)}
                            onDoubleClick={() => downloadArtifact(artifact)}
                            className="group/file flex h-[136px] min-w-0 flex-col items-center rounded-lg px-2 py-2 text-center transition-colors hover:bg-zinc-200/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0a84ff] dark:hover:bg-white/8"
                            title={artifact.path}
                          >
                            <span className={cn(
                              "relative flex h-[62px] w-[54px] shrink-0 items-center justify-center rounded-[10px] border bg-white shadow-[0_10px_22px_-16px_rgba(15,23,42,0.65)] transition-transform group-hover/file:-translate-y-0.5 dark:border-white/10 dark:bg-zinc-900",
                              artifact.kind === "report" ? "border-sky-200" : "border-zinc-200",
                            )}>
                              <span className="absolute right-0 top-0 h-4 w-4 rounded-bl-md border-b border-l border-zinc-200 bg-zinc-100 dark:border-white/10 dark:bg-zinc-800" />
                              <Icon className={cn("h-7 w-7", artifact.kind === "report" ? "text-[#0a84ff]" : "text-zinc-500 dark:text-zinc-300")} />
                            </span>
                            <span className={cn(
                              "mt-2 line-clamp-2 max-w-[108px] rounded-md px-1.5 py-0.5 text-[12px] font-medium leading-4",
                              active ? "bg-[#0a84ff] text-white" : "text-zinc-800 dark:text-zinc-100",
                            )}>
                              {artifact.name}
                            </span>
                            <span className="mt-1 max-w-[108px] truncate text-[10px] uppercase text-zinc-500 dark:text-zinc-400">{artifact.extension}</span>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-zinc-200/85 bg-white/80 dark:border-white/10 dark:bg-white/5">
                      {group.artifacts.map((artifact) => {
                        const Icon = artifactIcon(artifact.extension, artifact.kind)
                        const active = selectedId === artifact.id
                        return (
                          <button
                            key={artifact.id}
                            type="button"
                            onClick={() => setSelectedId(artifact.id)}
                            className={cn(
                              "grid min-h-11 w-full grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-3 border-b border-zinc-100 px-3 text-left text-[12px] last:border-b-0 dark:border-white/5 sm:grid-cols-[minmax(0,1fr)_110px_100px_84px]",
                              active ? "bg-[#0a84ff] text-white" : "hover:bg-zinc-100 dark:hover:bg-white/8",
                            )}
                            title={artifact.path}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Icon className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-zinc-500 dark:text-zinc-300")} />
                              <span className="truncate font-medium">{artifact.name}</span>
                            </span>
                            <span className={cn("hidden truncate text-[11px] sm:block", active ? "text-white/85" : "text-zinc-500")}>{artifactTypeLabel(artifact)}</span>
                            <span className={cn("truncate text-[11px]", active ? "text-white/85" : "text-zinc-500")}>{relativeActivity(artifact.updatedAt)}</span>
                            <span className={cn("text-right text-[11px] tabular-nums", active ? "text-white/85" : "text-zinc-500")}>{artifactSizeLabel(artifact.content)}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </section>
              ))}

              {groups.length === 0 ? (
                <div className="flex min-h-[340px] flex-col items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-white/55 text-center dark:border-zinc-700 dark:bg-white/5">
                  <span className="relative flex h-16 w-20 items-end">
                    <span className="absolute left-2 top-2 h-4 w-9 rounded-t-lg bg-[#74c7ff]" />
                    <span className="relative h-12 w-20 rounded-xl bg-gradient-to-b from-[#62c5ff] to-[#0a84ff] shadow-lg" />
                  </span>
                  <p className="mt-4 text-sm font-semibold">No hay resultados</p>
                  <p className="mt-1 max-w-sm text-xs text-zinc-500">Cada agente tiene su carpeta y reporte de archivos. Cambia el filtro o busca otro nombre.</p>
                </div>
              ) : null}

              <section className="mt-8 border-t border-zinc-200/80 pt-5 dark:border-white/10" data-testid="company-mission-evidence-ledger">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[13px] font-semibold">Evidencia de misiones</h2>
                    <p className="mt-0.5 text-[11px] text-zinc-500">CEO Office · {missionSummary?.reports || 0} resúmenes</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-lg"
                      disabled={!codexProjectId || Boolean(missionBusy)}
                      onClick={() => void createReport(false)}
                    >
                      {missionBusy === "report:draft" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileText className="mr-1.5 h-3.5 w-3.5" />}
                      Reporte
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-lg"
                      disabled={!codexProjectId || Boolean(missionBusy)}
                      onClick={() => void createReport(true)}
                    >
                      {missionBusy === "report:email" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                      Correo
                    </Button>
                  </div>
                </div>

                {missionLedger?.records.length ? (
                  <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white/75 dark:border-white/10 dark:bg-white/5">
                    {missionLedger.records.slice(0, 12).map((record) => {
                      const expanded = expandedRecordId === record.id
                      const reviewing = missionBusy === `review:${record.id}`
                      return (
                        <article key={record.id} className="border-b border-zinc-100 last:border-b-0 dark:border-white/5" data-testid="company-mission-evidence-record">
                          <div className="flex flex-col gap-3 px-3 py-3">
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0a84ff]"
                              onClick={() => setExpandedRecordId(expanded ? null : record.id)}
                              aria-expanded={expanded}
                            >
                              <span className="flex items-center gap-2">
                                <span className={cn("h-2.5 w-2.5 rounded-full", record.status === "completed" ? "bg-emerald-500" : "bg-amber-500")} />
                                <span className="truncate text-[12px] font-semibold">{record.missionTitle}</span>
                                <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                                  {missionReviewLabel(record.ceoReview.status)}
                                </span>
                              </span>
                              <span className="mt-1 block truncate text-[11px] text-zinc-500">
                                {record.department} · {record.author} · {relativeActivity(Date.parse(record.createdAt))}
                              </span>
                            </button>
                            <div className="flex shrink-0 items-center gap-1.5 self-end">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950/30"
                                disabled={Boolean(missionBusy)}
                                onClick={() => void reviewMission(record, "rejected")}
                                title="Rechazar"
                                aria-label="Rechazar"
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8 rounded-lg"
                                disabled={Boolean(missionBusy)}
                                onClick={() => void reviewMission(record, "changes_requested")}
                                title="Pedir cambios"
                                aria-label="Pedir cambios"
                              >
                                {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                className="h-8 w-8 rounded-lg"
                                disabled={Boolean(missionBusy)}
                                onClick={() => void reviewMission(record, "approved")}
                                title="Aprobar"
                                aria-label="Aprobar"
                              >
                                {reviewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </div>
                          {expanded ? (
                            <div className="grid gap-4 border-t border-zinc-100 px-3 pb-4 pt-3 text-xs dark:border-white/5">
                              <div className="rounded-lg bg-zinc-100/75 px-3 py-2 text-[10px] text-zinc-600 dark:bg-white/5 dark:text-zinc-300">
                                <span className="font-semibold">v{record.version} · {record.source}</span>
                                {record.contentHash ? (
                                  <code className="mt-1 block break-all font-mono text-[9px] text-zinc-500 dark:text-zinc-400">
                                    {record.contentHash}
                                  </code>
                                ) : null}
                              </div>
                              <div>
                                <h3 className="text-[10px] font-semibold uppercase text-zinc-500">Entregables</h3>
                                <div className="mt-2 space-y-2">
                                  {record.deliverables.map((deliverable) => (
                                    <div key={deliverable.id} className="flex items-start gap-2">
                                      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                                      <span className="min-w-0">
                                        <span className="block font-medium">{deliverable.name}</span>
                                        {deliverable.ref ? <span className="mt-0.5 block break-all font-mono text-[10px] text-zinc-500">{deliverable.ref}</span> : null}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <h3 className="text-[10px] font-semibold uppercase text-zinc-500">Evidencia</h3>
                                <div className="mt-2 space-y-2">
                                  {record.evidence.map((evidence) => (
                                    <div key={evidence.id}>
                                      <span className="flex items-center gap-2 font-medium">
                                        {evidence.passed === true ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : evidence.passed === false ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> : null}
                                        {evidence.label}
                                      </span>
                                      <p className="mt-1 break-words leading-5 text-zinc-500">{evidence.detail}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </article>
                      )
                    })}
                  </div>
                ) : missionLedger ? (
                  <div className="mt-3 rounded-lg border border-dashed border-zinc-300 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700">
                    Las misiones cerradas aparecerán aquí.
                  </div>
                ) : null}

                {missionLedger?.reports.length ? (
                  <div className="mt-4 space-y-2" data-testid="company-activity-reports">
                    {missionLedger.reports.map((report) => (
                      <div
                        key={report.id}
                        className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white/75 px-3 py-2.5 text-xs dark:border-white/10 dark:bg-white/5 sm:flex-row sm:items-center"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">{report.title}</span>
                          <span className="mt-0.5 block text-[10px] text-zinc-500">
                            {report.author} · {report.counts.missions} misiones · {report.status === "queued" ? "En cola" : "Borrador"}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-1 text-[10px] font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                          v{report.version}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          </main>

          <aside className="shrink-0 border-t border-zinc-300/70 bg-[#f3f3f1]/90 p-4 dark:border-white/10 dark:bg-zinc-900/85 lg:w-80 lg:border-l lg:border-t-0">
            {selected ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase text-zinc-500">Vista previa</p>
                    <h2 className="mt-1 break-words text-sm font-semibold">{selected.name}</h2>
                    <p className="mt-1 break-words text-[11px] text-zinc-500">{selected.path}</p>
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-lg" onClick={() => setSelectedId(null)} aria-label="Cerrar detalle" title="Cerrar">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-5 flex flex-col items-center border-b border-zinc-200 pb-5 dark:border-white/10">
                  <span className="relative flex h-24 w-20 items-center justify-center rounded-[16px] border border-zinc-200 bg-white shadow-[0_18px_32px_-24px_rgba(15,23,42,0.85)] dark:border-white/10 dark:bg-zinc-950">
                    <span className="absolute right-0 top-0 h-6 w-6 rounded-bl-lg border-b border-l border-zinc-200 bg-zinc-100 dark:border-white/10 dark:bg-zinc-800" />
                    {React.createElement(artifactIcon(selected.extension, selected.kind), { className: cn("h-10 w-10", selected.kind === "report" ? "text-[#0a84ff]" : "text-zinc-500 dark:text-zinc-300") })}
                  </span>
                  <span className="mt-3 rounded-md bg-zinc-200/70 px-2 py-1 text-[10px] font-semibold uppercase text-zinc-600 dark:bg-white/10 dark:text-zinc-300">{selected.extension}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 border-b border-zinc-200 py-4 text-xs dark:border-white/10">
                  <div><span className="block text-[10px] text-zinc-500">Clase</span><strong className="mt-1 block">{artifactTypeLabel(selected)}</strong></div>
                  <div><span className="block text-[10px] text-zinc-500">Tamaño</span><strong className="mt-1 block tabular-nums">{artifactSizeLabel(selected.content)}</strong></div>
                  <div><span className="block text-[10px] text-zinc-500">Agente</span><strong className="mt-1 block truncate">{selected.agentName}</strong></div>
                  <div><span className="block text-[10px] text-zinc-500">Departamento</span><strong className="mt-1 block truncate">{selected.departmentName}</strong></div>
                  <div><span className="block text-[10px] text-zinc-500">Actualizado</span><strong className="mt-1 block">{relativeActivity(selected.updatedAt)}</strong></div>
                </div>
                <pre className="mt-4 min-h-0 max-h-[320px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-200 bg-white p-3 font-mono text-[10px] leading-relaxed text-zinc-600 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300">
                  {selected.content.slice(0, 8_000)}
                  {selected.content.length > 8_000 ? "\n\n… vista previa limitada" : ""}
                </pre>
                <Button type="button" className="mt-4 w-full rounded-lg" onClick={() => downloadArtifact(selected)}>
                  <Download className="mr-2 h-4 w-4" />
                  Descargar
                </Button>
              </div>
            ) : (
              <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center">
                <span className="relative flex h-20 w-24 items-end">
                  <span className="absolute left-2 top-2 h-5 w-12 rounded-t-xl bg-[#74c7ff]" />
                  <span className="relative h-14 w-24 rounded-2xl bg-gradient-to-b from-[#62c5ff] to-[#0a84ff] shadow-lg" />
                </span>
                <h2 className="mt-5 text-sm font-semibold">Archivos</h2>
                <p className="mt-1 text-xs text-zinc-500">{artifacts.length} elementos disponibles</p>
              </div>
            )}
          </aside>
        </div>
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
