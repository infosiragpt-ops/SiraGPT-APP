import {
  codeRunActivityAt,
  codeRunIsActive,
  codeRunStatus,
  codeSessionIsActive,
  codeSessionStatus,
  departmentIdForRun,
  departmentIdForSession,
  type AgentDepartmentDefinition,
} from "./code-agent-company"
import type { CodeChatSession } from "./code-chat-sessions"
import type { CodexRun } from "./codex/codex-api"

export type AgentOfficeActivity =
  | "coordination"
  | "software"
  | "publishing"
  | "research"
  | "operations"
  | "localization"
  | "security"

export type AgentOfficeWorker = {
  id: string
  source: "session" | "run"
  sessionId: string | null
  runId: string | null
  departmentId: string
  departmentName: string
  name: string
  task: string
  statusLabel: string
  statusTone: "idle" | "active" | "ready" | "attention"
  active: boolean
  activity: AgentOfficeActivity
  model: string | null
  updatedAt: number
}

export type AgentOfficeDepartment = {
  id: string
  name: string
  description: string
  workers: AgentOfficeWorker[]
  activeCount: number
}

export type AgentOfficeModel = {
  departments: AgentOfficeDepartment[]
  workers: AgentOfficeWorker[]
  activeCount: number
  totalCount: number
}

const MAX_WORKERS_PER_DEPARTMENT = 12
const MAX_OFFICE_WORKERS = 48

function compactLine(value: string, fallback: string, max = 120): string {
  const line = value.replace(/\s+/g, " ").trim() || fallback
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

function activityForDepartment(department: AgentDepartmentDefinition): AgentOfficeActivity {
  const text = `${department.id} ${department.name} ${department.keywords.join(" ")}`.toLocaleLowerCase("es")
  if (department.id === "ceo-office") return "coordination"
  if (/marketing|contenido|social|campaña|campana|seo|public/.test(text)) return "publishing"
  if (/localiza|idioma|traduc|transcultural/.test(text)) return "localization"
  if (/confianza|seguridad|security|privacidad|cumplimiento/.test(text)) return "security"
  if (/growth|crecimiento|investiga|mercado|distribu/.test(text)) return "research"
  if (/infra|integra|conector|runner|sandbox|operaci/.test(text)) return "operations"
  return "software"
}

function sessionTask(session: CodeChatSession, department: AgentDepartmentDefinition): string {
  const lastTurn = [...session.turns].reverse().find((turn) => turn.content.trim())
  const phase = session.agent?.phase
  if (lastTurn) return compactLine(lastTurn.content, department.description)
  if (phase && phase !== "idle") return compactLine(`Fase ${phase}`, department.description)
  return department.description
}

function sessionName(session: CodeChatSession): string {
  const agentLabel = [...session.turns].reverse().find((turn) => turn.agentLabel?.trim())?.agentLabel
  return compactLine(agentLabel || session.title, "Agente", 54)
}

function runTask(run: CodexRun, department: AgentDepartmentDefinition): string {
  const prompt = String(run.prompt || "")
    .replace(/^\s*\[PROACTIVO\s*·\s*[^\]]+\]\s*/i, "")
    .trim()
  return compactLine(prompt || run.error || department.description, department.description)
}

function runName(run: CodexRun, department: AgentDepartmentDefinition): string {
  const model = String(run.model || "").trim()
  if (model) return compactLine(model, "Agente Codex", 32)
  return `Agente ${department.name}`.slice(0, 54)
}

function compareWorkers(a: AgentOfficeWorker, b: AgentOfficeWorker): number {
  if (a.active !== b.active) return a.active ? -1 : 1
  if (a.statusTone !== b.statusTone) {
    const rank = { attention: 0, active: 1, ready: 2, idle: 3 }
    return rank[a.statusTone] - rank[b.statusTone]
  }
  return b.updatedAt - a.updatedAt
}

export function buildAgentOfficeModel({
  departments,
  sessions,
  runs,
  rootSessionId,
}: {
  departments: readonly AgentDepartmentDefinition[]
  sessions: readonly CodeChatSession[]
  runs: readonly CodexRun[]
  rootSessionId: string | null
}): AgentOfficeModel {
  const departmentMap = new Map(departments.map((department) => [department.id, department]))
  const fallbackDepartment = departmentMap.get("product-engineering") || departments[0]
  if (!fallbackDepartment) {
    return { departments: [], workers: [], activeCount: 0, totalCount: 0 }
  }

  const sessionWorkers = sessions.map<AgentOfficeWorker>((session) => {
    const departmentId = departmentIdForSession(session, rootSessionId, departments)
    const department = departmentMap.get(departmentId) || fallbackDepartment
    const status = codeSessionStatus(session)
    return {
      id: `session:${session.id}`,
      source: "session",
      sessionId: session.id,
      runId: null,
      departmentId: department.id,
      departmentName: department.name,
      name: sessionName(session),
      task: sessionTask(session, department),
      statusLabel: status.label,
      statusTone: status.tone,
      active: codeSessionIsActive(session),
      activity: activityForDepartment(department),
      model: null,
      updatedAt: session.updatedAt,
    }
  })

  const runWorkers = runs.map<AgentOfficeWorker>((run) => {
    const departmentId = departmentIdForRun(run, departments)
    const department = departmentMap.get(departmentId) || fallbackDepartment
    const status = codeRunStatus(run)
    return {
      id: `run:${run.id}`,
      source: "run",
      sessionId: null,
      runId: run.id,
      departmentId: department.id,
      departmentName: department.name,
      name: runName(run, department),
      task: runTask(run, department),
      statusLabel: status.label,
      statusTone: status.tone,
      active: codeRunIsActive(run),
      activity: activityForDepartment(department),
      model: run.model,
      updatedAt: codeRunActivityAt(run),
    }
  })

  const selectedIds = new Set<string>()
  for (const department of departments) {
    const candidates = [...sessionWorkers, ...runWorkers]
      .filter((worker) => worker.departmentId === department.id)
      .sort(compareWorkers)
      .slice(0, MAX_WORKERS_PER_DEPARTMENT)
    for (const worker of candidates) selectedIds.add(worker.id)
  }

  const workers = [...sessionWorkers, ...runWorkers]
    .filter((worker) => selectedIds.has(worker.id))
    .sort(compareWorkers)
    .slice(0, MAX_OFFICE_WORKERS)
  const visibleIds = new Set(workers.map((worker) => worker.id))

  const officeDepartments = departments.map<AgentOfficeDepartment>((department) => {
    const departmentWorkers = workers.filter(
      (worker) => visibleIds.has(worker.id) && worker.departmentId === department.id,
    )
    return {
      id: department.id,
      name: department.name,
      description: department.description,
      workers: departmentWorkers,
      activeCount: departmentWorkers.filter((worker) => worker.active).length,
    }
  })

  return {
    departments: officeDepartments,
    workers,
    activeCount: workers.filter((worker) => worker.active).length,
    totalCount: workers.length,
  }
}
