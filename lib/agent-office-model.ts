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
import type {
  CodexCompanyCapacity,
  CodexCompanyOperations,
  CodexDepartmentPool,
  CodexEnterpriseCommandCenter,
  CodexLedgerEntry,
  CodexMissionEvidenceLedger,
  CodexMissionEvidenceRecord,
  CodexObjective,
  CodexProgressMemory,
  CodexProactiveState,
  CodexRun,
} from "./codex/codex-api"

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
  /** Real runtime cost when the worker is a Codex run with metrics. */
  costUsd: number | null
  /** Explicit blocker reason (failed/blocked run, failed acceptance, etc.). */
  blocker: string | null
  /** Linked mission evidence review state, if any. */
  evidenceReview: "pending" | "approved" | "changes_requested" | "rejected" | "blocked" | null
  evidenceSummary: string | null
}

/**
 * What the worker's body is doing in the 3D office.
 *
 * The office used to walk every agent around its department in an endless
 * loop, so a department with 8 running agents looked identical to an empty
 * one — only the walking speed changed. Stance makes work legible: an agent
 * that is actually running SITS DOWN at its desk and types, a blocked one
 * paces, and everyone else waits at their desk.
 */
export type AgentOfficeStance = "working" | "blocked" | "standby"

export function officeWorkerStance(
  worker: Pick<AgentOfficeWorker, "active" | "statusTone" | "blocker">,
): AgentOfficeStance {
  if (worker.active) return "working"
  if (worker.blocker || worker.statusTone === "attention") return "blocked"
  return "standby"
}

export type AgentOfficePoolTruth = {
  poolId: string | null
  size: number
  enabled: boolean
  occupied: number
  free: number
  dailyBudgetUsd: number | null
  costTodayUsd: number
  remainingUsd: number | null
  budgetBlocked: boolean
}

export type AgentOfficeDepartment = {
  id: string
  name: string
  description: string
  workers: AgentOfficeWorker[]
  activeCount: number
  pool: AgentOfficePoolTruth
  commandStatus: "active" | "queued" | "paused" | "blocked" | "completed" | "idle"
  currentWork: string | null
  tasksActive: number
  tasksQueued: number
  tasksCompleted: number
  progress: number
  blockers: Array<{ id: string; label: string; source: "run" | "mission" | "command" | "operations" }>
  pendingApprovals: number
  evidencePending: number
  evidenceBlocked: number
  costTodayUsd: number
}

export type AgentOfficeTruth = {
  costTodayUsd: number
  dailyBudgetUsd: number | null
  budgetBlocked: boolean
  physicalAgents: number
  writerConcurrency: number
  occupiedDesks: number
  freeDesks: number
  pendingApprovals: number
  pendingEvidenceReview: number
  blockedMissions: number
  activeObjectives: number
  atRiskObjectives: number
  readinessStatus: "ready" | "attention" | "blocked" | "unknown"
  readinessScore: number | null
  swarmActive: number
  swarmQueued: number
  swarmFailed: number
  latestBlockers: Array<{ id: string; label: string; departmentId: string | null; source: string }>
}

export type AgentOfficeModel = {
  departments: AgentOfficeDepartment[]
  workers: AgentOfficeWorker[]
  activeCount: number
  totalCount: number
  truth: AgentOfficeTruth
}

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

function runCostUsd(run: CodexRun): number | null {
  const metric = run.metric
  if (!metric) return null
  const value = Number(metric.costAppliedUsd ?? metric.costUsd ?? metric.costOriginalUsd)
  return Number.isFinite(value) ? Math.max(0, value) : null
}

function normalizeDepartmentKey(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

function resolveDepartmentId(
  raw: string | null | undefined,
  departments: readonly AgentDepartmentDefinition[],
  fallbackId: string,
): string {
  const key = normalizeDepartmentKey(raw)
  if (!key) return fallbackId
  const byId = departments.find((department) => normalizeDepartmentKey(department.id) === key)
  if (byId) return byId.id
  const byName = departments.find((department) => normalizeDepartmentKey(department.name) === key)
  if (byName) return byName.id
  const byPartial = departments.find((department) => {
    const id = normalizeDepartmentKey(department.id)
    const name = normalizeDepartmentKey(department.name)
    return key.includes(id) || id.includes(key) || key.includes(name) || name.includes(key)
  })
  return byPartial?.id || fallbackId
}

function isSameUtcDay(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return false
  const now = new Date(nowMs)
  return (
    date.getUTCFullYear() === now.getUTCFullYear()
    && date.getUTCMonth() === now.getUTCMonth()
    && date.getUTCDate() === now.getUTCDate()
  )
}

function compareWorkers(a: AgentOfficeWorker, b: AgentOfficeWorker): number {
  if (a.active !== b.active) return a.active ? -1 : 1
  if (Boolean(a.blocker) !== Boolean(b.blocker)) return a.blocker ? -1 : 1
  if (a.statusTone !== b.statusTone) {
    const rank = { attention: 0, active: 1, ready: 2, idle: 3 }
    return rank[a.statusTone] - rank[b.statusTone]
  }
  return b.updatedAt - a.updatedAt
}

function emptyTruth(): AgentOfficeTruth {
  return {
    costTodayUsd: 0,
    dailyBudgetUsd: null,
    budgetBlocked: false,
    physicalAgents: 0,
    writerConcurrency: 1,
    occupiedDesks: 0,
    freeDesks: 0,
    pendingApprovals: 0,
    pendingEvidenceReview: 0,
    blockedMissions: 0,
    activeObjectives: 0,
    atRiskObjectives: 0,
    readinessStatus: "unknown",
    readinessScore: null,
    swarmActive: 0,
    swarmQueued: 0,
    swarmFailed: 0,
    latestBlockers: [],
  }
}

function emptyPool(size = 0): AgentOfficePoolTruth {
  return {
    poolId: null,
    size,
    enabled: true,
    occupied: 0,
    free: size,
    dailyBudgetUsd: null,
    costTodayUsd: 0,
    remainingUsd: null,
    budgetBlocked: false,
  }
}

function ledgerCostForDepartment(
  ledger: readonly CodexLedgerEntry[],
  department: AgentDepartmentDefinition,
  nowMs: number,
): number {
  const keys = new Set([
    normalizeDepartmentKey(department.id),
    normalizeDepartmentKey(department.name),
  ])
  return ledger.reduce((sum, entry) => {
    if (!isSameUtcDay(entry.createdAt, nowMs)) return sum
    const dept = normalizeDepartmentKey(entry.department)
    if (!keys.has(dept) && ![...keys].some((key) => dept.includes(key) || key.includes(dept))) {
      return sum
    }
    const cost = Number(entry.costUsd)
    return sum + (Number.isFinite(cost) ? Math.max(0, cost) : 0)
  }, 0)
}

function evidenceForRun(
  records: readonly CodexMissionEvidenceRecord[],
  runId: string | null,
): CodexMissionEvidenceRecord | null {
  if (!runId) return null
  return records.find((record) => record.runId === runId) || null
}

export function buildAgentOfficeModel({
  departments,
  sessions,
  runs,
  rootSessionId,
  departmentPools = [],
  capacity = null,
  proactive = null,
  commandCenter = null,
  missionEvidence = null,
  operations = null,
  progressMemory = null,
  nowMs = Date.now(),
}: {
  departments: readonly AgentDepartmentDefinition[]
  sessions: readonly CodeChatSession[]
  runs: readonly CodexRun[]
  rootSessionId: string | null
  departmentPools?: readonly CodexDepartmentPool[] | null
  capacity?: CodexCompanyCapacity | null
  proactive?: Pick<
    CodexProactiveState,
    "costTodayUsd" | "dailyBudgetUsd" | "budgetBlocked"
  > | null
  commandCenter?: CodexEnterpriseCommandCenter | null
  missionEvidence?: CodexMissionEvidenceLedger | null
  operations?: CodexCompanyOperations | null
  progressMemory?: CodexProgressMemory | null
  nowMs?: number
}): AgentOfficeModel {
  const departmentMap = new Map(departments.map((department) => [department.id, department]))
  const fallbackDepartment = departmentMap.get("product-engineering") || departments[0]
  if (!fallbackDepartment) {
    return { departments: [], workers: [], activeCount: 0, totalCount: 0, truth: emptyTruth() }
  }

  const poolByDepartment = new Map(
    (departmentPools || [])
      .filter((pool) => pool?.departmentId)
      .map((pool) => [pool.departmentId, pool] as const),
  )
  const departmentByPoolId = new Map(
    (departmentPools || [])
      .filter((pool) => pool?.id && pool?.departmentId)
      .map((pool) => [pool.id, pool.departmentId] as const),
  )
  const commandByDepartment = new Map(
    (commandCenter?.departments || []).map((department) => [department.id, department] as const),
  )
  const evidenceRecords = missionEvidence?.records || []
  const ledger = progressMemory?.ledger || []
  const objectives: readonly CodexObjective[] = progressMemory?.objectives || []
  const sessionRunIds = new Set(
    sessions.flatMap((session) => session.turns.map((turn) => turn.codexRunId).filter((id): id is string => Boolean(id))),
  )

  const sessionWorkers = sessions.map<AgentOfficeWorker>((session) => {
    const linkedRunId = [...session.turns].reverse().find((turn) => turn.codexRunId)?.codexRunId || null
    const linkedRun = linkedRunId ? runs.find((run) => run.id === linkedRunId) || null : null
    const linkedPooledDepartmentId = linkedRun?.departmentPoolId
      ? departmentByPoolId.get(linkedRun.departmentPoolId) || null
      : null
    const inferredDepartmentId = departmentIdForSession(session, rootSessionId, departments)
    const departmentId = linkedPooledDepartmentId && departmentMap.has(linkedPooledDepartmentId)
      ? linkedPooledDepartmentId
      : inferredDepartmentId
    const department = departmentMap.get(departmentId) || fallbackDepartment
    const status = codeSessionStatus(session)
    const active = codeSessionIsActive(session)
    const linkedEvidence = evidenceForRun(evidenceRecords, linkedRunId)
    const linkedBlocker = linkedRun?.error
      || (linkedEvidence?.status === "blocked" ? linkedEvidence.summary : null)
    return {
      id: `session:${session.id}`,
      source: "session",
      sessionId: session.id,
      runId: linkedRunId,
      departmentId: department.id,
      departmentName: department.name,
      name: sessionName(session),
      task: sessionTask(session, department),
      statusLabel: status.label,
      statusTone: status.tone,
      active,
      activity: activityForDepartment(department),
      model: null,
      updatedAt: session.updatedAt,
      costUsd: linkedRun ? runCostUsd(linkedRun) : null,
      blocker: linkedBlocker || (status.tone === "attention" && !active)
        ? compactLine(linkedBlocker || status.label, "Requiere atención", 160)
        : null,
      evidenceReview: linkedEvidence
        ? (linkedEvidence.status === "blocked" ? "blocked" : linkedEvidence.ceoReview.status)
        : null,
      evidenceSummary: linkedEvidence
        ? compactLine(linkedEvidence.summary, linkedEvidence.missionTitle, 180)
        : null,
    }
  })

  const runWorkers = runs.filter((run) => !sessionRunIds.has(run.id)).map<AgentOfficeWorker>((run) => {
    // Durable pool attribution is authoritative. Text inference remains only
    // for legacy runs created before departmentPoolId was persisted.
    const pooledDepartmentId = run.departmentPoolId
      ? departmentByPoolId.get(run.departmentPoolId) || null
      : null
    const departmentId = pooledDepartmentId && departmentMap.has(pooledDepartmentId)
      ? pooledDepartmentId
      : departmentIdForRun(run, departments)
    const department = departmentMap.get(departmentId) || fallbackDepartment
    const status = codeRunStatus(run)
    const active = codeRunIsActive(run)
    const evidence = evidenceForRun(evidenceRecords, run.id)
    const failedAcceptance = (ledger.find((entry) => entry.runId === run.id)?.acceptance || [])
      .filter((item) => item.passed === false)
      .map((item) => item.criterion)
    const blocker = !active && (status.tone === "attention" || run.error || evidence?.status === "blocked" || failedAcceptance.length)
      ? compactLine(
        run.error
          || (evidence?.status === "blocked" ? evidence.summary : "")
          || (failedAcceptance[0] ? `Criterio fallido: ${failedAcceptance[0]}` : "")
          || status.label,
        "Bloqueado",
        180,
      )
      : null
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
      statusTone: blocker && status.tone !== "active" ? "attention" : status.tone,
      active,
      activity: activityForDepartment(department),
      model: run.model,
      updatedAt: codeRunActivityAt(run),
      costUsd: runCostUsd(run),
      blocker,
      evidenceReview: evidence
        ? (evidence.status === "blocked" ? "blocked" : evidence.ceoReview.status)
        : null,
      evidenceSummary: evidence ? compactLine(evidence.summary, evidence.missionTitle, 180) : null,
    }
  })

  // The office is an operational view, so silently dropping workers would make
  // its counts and navigation untrustworthy. Rendering code is responsible for
  // choosing an efficient representation (detailed mesh vs. instanced seat),
  // while the model always retains every real session and durable run.
  const workers = [...sessionWorkers, ...runWorkers]
    .sort(compareWorkers)
  const visibleIds = new Set(workers.map((worker) => worker.id))

  const pendingOpsFromActions = (operations?.actions || []).filter((action) => (
    /pending|review|await/i.test(String(action.status || ""))
  )).length
  const pendingOpsApprovals = operations?.counts && Number.isFinite(Number(operations.counts.pendingActions))
    ? Math.max(0, Number(operations.counts.pendingActions))
    : pendingOpsFromActions
  const pendingEvidenceFromRecords = evidenceRecords.filter((record) => record.ceoReview?.status === "pending").length
  const pendingEvidenceReview = missionEvidence?.summary && Number.isFinite(Number(missionEvidence.summary.pendingReview))
    ? Math.max(0, Number(missionEvidence.summary.pendingReview))
    : pendingEvidenceFromRecords
  const blockedFromRecords = evidenceRecords.filter((record) => record.status === "blocked").length
  const blockedMissions = missionEvidence?.summary && Number.isFinite(Number(missionEvidence.summary.blocked))
    ? Math.max(0, Number(missionEvidence.summary.blocked))
    : blockedFromRecords

  const officeDepartments = departments.map<AgentOfficeDepartment>((department) => {
    const departmentWorkers = workers.filter(
      (worker) => visibleIds.has(worker.id) && worker.departmentId === department.id,
    )
    const activeWorkers = departmentWorkers.filter((worker) => worker.active)
    const poolRow = poolByDepartment.get(department.id) || null
    const command = commandByDepartment.get(department.id) || null
    const desired = Math.max(1, Number(department.desiredAgents) || 1)
    const size = Math.max(1, Number(poolRow?.size) || desired)
    const occupied = Math.min(size, activeWorkers.length || Number(command?.activeAgents) || 0)
    const costFromLedger = ledgerCostForDepartment(ledger, department, nowMs)
    const costFromRuns = departmentWorkers.reduce((sum, worker) => {
      if (worker.costUsd == null) return sum
      // Prefer ledger for "today"; run metrics are still useful when ledger is empty.
      return sum + worker.costUsd
    }, 0)
    const costTodayUsd = costFromLedger > 0 ? costFromLedger : costFromRuns
    const dailyBudgetUsd = poolRow?.dailyBudgetUsd == null ? null : Number(poolRow.dailyBudgetUsd)
    const remainingUsd = dailyBudgetUsd == null
      ? null
      : Math.max(0, Math.round((dailyBudgetUsd - costTodayUsd) * 10_000) / 10_000)
    const budgetBlocked = dailyBudgetUsd != null && costTodayUsd >= dailyBudgetUsd
    const deptEvidence = evidenceRecords.filter((record) => (
      resolveDepartmentId(record.department, departments, fallbackDepartment.id) === department.id
    ))
    const blockers: AgentOfficeDepartment["blockers"] = []
    for (const worker of departmentWorkers) {
      if (!worker.blocker) continue
      blockers.push({
        id: `worker:${worker.id}`,
        label: worker.blocker,
        source: worker.source === "run" ? "run" : "command",
      })
    }
    for (const record of deptEvidence) {
      if (record.status !== "blocked") continue
      blockers.push({
        id: `mission:${record.id}`,
        label: compactLine(record.summary || record.missionTitle, "Misión bloqueada", 160),
        source: "mission",
      })
    }
    if (command?.status === "blocked") {
      blockers.push({
        id: `command:${department.id}`,
        label: compactLine(command.currentWork || command.objective || "Departamento bloqueado", "Bloqueado", 160),
        source: "command",
      })
    }
    if (budgetBlocked) {
      blockers.push({
        id: `budget:${department.id}`,
        label: `Presupuesto diario agotado ($${costTodayUsd.toFixed(2)} / $${dailyBudgetUsd!.toFixed(2)})`,
        source: "operations",
      })
    }

    const evidencePending = deptEvidence.filter((record) => record.ceoReview?.status === "pending").length
    const evidenceBlocked = deptEvidence.filter((record) => record.status === "blocked").length

    return {
      id: department.id,
      name: department.name,
      description: department.description,
      workers: departmentWorkers,
      activeCount: activeWorkers.length,
      pool: {
        poolId: poolRow?.id || null,
        size,
        enabled: poolRow ? poolRow.enabled !== false : true,
        occupied,
        free: Math.max(0, size - occupied),
        dailyBudgetUsd,
        costTodayUsd: Math.round(costTodayUsd * 10_000) / 10_000,
        remainingUsd,
        budgetBlocked,
      },
      commandStatus: command?.status || (activeWorkers.length > 0 ? "active" : "idle"),
      currentWork: command?.currentWork
        || activeWorkers[0]?.task
        || departmentWorkers.find((worker) => worker.blocker)?.task
        || null,
      tasksActive: Number(command?.activeAgents) || activeWorkers.length,
      tasksQueued: Number(command?.queuedTasks) || 0,
      tasksCompleted: Number(command?.completedTasks) || 0,
      progress: Number(command?.progress) || 0,
      blockers: blockers.slice(0, 8),
      pendingApprovals: evidencePending,
      evidencePending,
      evidenceBlocked,
      costTodayUsd: Math.round(costTodayUsd * 10_000) / 10_000,
    }
  })

  const occupiedDesks = officeDepartments.reduce((sum, department) => sum + department.pool.occupied, 0)
  // Prefer server capacity. Only fall back to configured pool sizes — never sum
  // synthetic defaults for departments without a pool, or an empty company looks full.
  const configuredPoolSize = officeDepartments.reduce(
    (sum, department) => sum + (department.pool.poolId ? department.pool.size : 0),
    0,
  )
  const reportedPhysicalAgents = capacity?.physicalAgents
  const serverPhysicalAgents = typeof reportedPhysicalAgents === "number"
    && Number.isFinite(reportedPhysicalAgents)
    && reportedPhysicalAgents >= 0
    ? Math.floor(reportedPhysicalAgents)
    : null
  // The backend already applies the global physical-execution hard cap. When
  // it reports a valid value (including zero), it is the source of truth;
  // summing per-department pools can describe 196 logical seats while only 32
  // agents may execute physically. Pool totals are only a legacy fallback.
  // Occupancy remains a separate observation and must never expand capacity.
  const physicalAgents = serverPhysicalAgents ?? configuredPoolSize
  const freeDesks = Math.max(0, physicalAgents - occupiedDesks)
  const costTodayUsd = Math.max(
    Number(proactive?.costTodayUsd) || 0,
    officeDepartments.reduce((sum, department) => sum + department.costTodayUsd, 0),
  )
  const dailyBudgetUsd = proactive?.dailyBudgetUsd == null
    ? (Number(capacity?.dailyBudgetUsd) > 0 ? Number(capacity?.dailyBudgetUsd) : null)
    : Number(proactive.dailyBudgetUsd)
  const latestBlockers = officeDepartments
    .flatMap((department) => department.blockers.map((blocker) => ({
      id: blocker.id,
      label: blocker.label,
      departmentId: department.id,
      source: blocker.source,
    })))
    .slice(0, 12)

  const truth: AgentOfficeTruth = {
    costTodayUsd: Math.round(costTodayUsd * 10_000) / 10_000,
    dailyBudgetUsd,
    budgetBlocked: Boolean(proactive?.budgetBlocked) || officeDepartments.some((department) => department.pool.budgetBlocked),
    physicalAgents,
    writerConcurrency: Math.max(1, Number(capacity?.writerConcurrency) || 1),
    occupiedDesks,
    freeDesks,
    pendingApprovals: pendingOpsApprovals + pendingEvidenceReview,
    pendingEvidenceReview,
    blockedMissions,
    activeObjectives: objectives.filter((objective) => objective.status === "active").length,
    atRiskObjectives: objectives.filter((objective) => objective.status === "at_risk").length,
    readinessStatus: commandCenter?.readiness?.status || "unknown",
    readinessScore: commandCenter?.readiness ? Number(commandCenter.readiness.score) || 0 : null,
    swarmActive: Number(commandCenter?.swarmSummary?.active) || 0,
    swarmQueued: Number(commandCenter?.swarmSummary?.queued) || 0,
    swarmFailed: Number(commandCenter?.swarmSummary?.failed) || 0,
    latestBlockers,
  }

  return {
    departments: officeDepartments,
    workers,
    activeCount: workers.filter((worker) => worker.active).length,
    totalCount: workers.length,
    truth,
  }
}
