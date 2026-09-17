import assert from "node:assert/strict"
import test from "node:test"

import { buildAgentOfficeModel, officeWorkerStance } from "../lib/agent-office-model"
import { AGENT_COMPANY_DEPARTMENTS } from "../lib/code-agent-company"
import type { CodeChatSession } from "../lib/code-chat-sessions"
import type {
  CodexCompanyOperations,
  CodexDepartmentPool,
  CodexEnterpriseCommandCenter,
  CodexMissionEvidenceLedger,
  CodexProgressMemory,
  CodexRun,
} from "../lib/codex/codex-api"

function session(overrides: Partial<CodeChatSession> & Pick<CodeChatSession, "id" | "title">): CodeChatSession {
  return {
    id: overrides.id,
    workspaceId: "office-qa",
    title: overrides.title,
    turns: overrides.turns || [],
    createdAt: overrides.createdAt || 100,
    updatedAt: overrides.updatedAt || 200,
    agent: overrides.agent,
  }
}

function run(overrides: Partial<CodexRun> & Pick<CodexRun, "id" | "prompt" | "status">): CodexRun {
  return {
    id: overrides.id,
    projectId: "office-qa",
    mode: "build",
    status: overrides.status,
    tier: "pro",
    model: overrides.model || "gpt-5.4",
    planRunId: null,
    departmentPoolId: overrides.departmentPoolId,
    prompt: overrides.prompt,
    error: overrides.error || null,
    createdAt: overrides.createdAt || "2026-07-28T15:00:00.000Z",
    startedAt: overrides.startedAt || "2026-07-28T15:00:01.000Z",
    finishedAt: overrides.finishedAt || null,
    metric: overrides.metric,
  }
}

test("buildAgentOfficeModel maps real sessions and runs to departments and work states", () => {
  const sessions = [
    session({ id: "ceo", title: "CEO Office" }),
    session({
      id: "marketing",
      title: "Marketing",
      updatedAt: 300,
      turns: [{
        id: "turn-1",
        role: "assistant",
        content: "Publicando la campaña editorial de lanzamiento.",
        agentLabel: "Editora de campaña",
        streaming: true,
      }],
    }),
  ]
  const runs = [
    run({
      id: "trust-run",
      status: "running",
      prompt: "[PROACTIVO · Confianza, Privacidad y Cumplimiento] Auditar permisos del runner",
    }),
    run({
      id: "localization-run",
      status: "done",
      prompt: "[PROACTIVO · Localización e IA Transcultural] Adaptar el producto al portugués",
      finishedAt: "2026-07-28T15:10:00.000Z",
    }),
  ]

  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions,
    runs,
    rootSessionId: "ceo",
  })

  assert.equal(model.totalCount, 4)
  assert.equal(model.activeCount, 2)
  assert.equal(model.departments.length, AGENT_COMPANY_DEPARTMENTS.length)
  assert.ok(model.truth)

  const marketing = model.workers.find((worker) => worker.sessionId === "marketing")
  assert.equal(marketing?.departmentId, "marketing")
  assert.equal(marketing?.activity, "publishing")
  assert.equal(marketing?.name, "Editora de campaña")
  assert.equal(marketing?.statusLabel, "Trabajando")

  const trust = model.workers.find((worker) => worker.runId === "trust-run")
  assert.equal(trust?.departmentId, "trust")
  assert.equal(trust?.activity, "security")
  assert.equal(trust?.active, true)
  assert.equal(trust?.task, "Auditar permisos del runner")

  const localization = model.workers.find((worker) => worker.runId === "localization-run")
  assert.equal(localization?.departmentId, "localization")
  assert.equal(localization?.statusTone, "ready")
})

test("buildAgentOfficeModel keeps empty departments without inventing workers", () => {
  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions: [],
    runs: [],
    rootSessionId: null,
  })

  assert.equal(model.totalCount, 0)
  assert.equal(model.activeCount, 0)
  assert.equal(model.departments.length, AGENT_COMPANY_DEPARTMENTS.length)
  assert.ok(model.departments.every((department) => department.workers.length === 0))
  assert.equal(model.truth.occupiedDesks, 0)
  assert.equal(model.truth.pendingApprovals, 0)
})

test("buildAgentOfficeModel preserves every built-in and custom department with its logical capacity", () => {
  const customDepartment = {
    id: "custom-legal-ops",
    name: "Legal Operations",
    description: "Contratos, políticas y trazabilidad legal.",
    keywords: ["legal", "contrato", "política"],
    kind: "research" as const,
    desiredAgents: 7,
    custom: true,
  }
  const departments = [...AGENT_COMPANY_DEPARTMENTS, customDepartment]
  const model = buildAgentOfficeModel({
    departments,
    sessions: [],
    runs: [
      run({
        id: "only-live-run",
        prompt: "[PROACTIVO · Producto e Ingeniería] Mantener activa una sola unidad",
        status: "running",
      }),
    ],
    rootSessionId: null,
  })

  const expectedIds = departments.map((department) => department.id)
  assert.deepEqual(model.departments.map((department) => department.id), expectedIds)
  assert.equal(new Set(model.departments.map((department) => department.id)).size, expectedIds.length)

  const builtInLogicalCapacity = AGENT_COMPANY_DEPARTMENTS.reduce(
    (sum, department) => sum + Math.max(1, Number(department.desiredAgents) || 1),
    0,
  )
  assert.equal(builtInLogicalCapacity, 196)
  assert.equal(
    model.departments.reduce((sum, department) => sum + department.pool.size, 0),
    builtInLogicalCapacity + customDepartment.desiredAgents,
  )

  assert.equal(model.totalCount, 1)
  assert.equal(model.departments.find((department) => department.id === customDepartment.id)?.workers.length, 0)
  assert.equal(model.departments.find((department) => department.id === "trust")?.workers.length, 0)
  assert.equal(model.departments.find((department) => department.id === "product-engineering")?.activeCount, 1)
})

test("a linked pooled run stays authoritative and is represented by only its session worker", () => {
  const departmentPools: CodexDepartmentPool[] = [{
    id: "pool-product",
    projectId: "office-qa",
    departmentId: "product-engineering",
    size: 16,
    dailyBudgetUsd: 25,
    enabled: true,
    createdAt: "2026-08-10T15:00:00.000Z",
    updatedAt: "2026-08-10T15:00:00.000Z",
  }]
  const linkedRun = run({
    id: "pooled-run",
    status: "running",
    departmentPoolId: "pool-product",
    prompt: "[PROACTIVO · Marketing] Lanzar una campaña engañosa para la atribución",
  })
  const misleadingSession = session({
    id: "misleading-sales-session",
    title: "Ventas y Marketing",
    turns: [{
      id: "linked-turn",
      role: "assistant",
      content: "Preparando anuncios y captación comercial.",
      codexRunId: linkedRun.id,
      streaming: true,
    }],
  })

  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions: [misleadingSession],
    runs: [linkedRun],
    rootSessionId: null,
    departmentPools,
  })

  assert.equal(model.totalCount, 1)
  assert.equal(model.workers.length, 1)
  assert.equal(model.workers[0]?.source, "session")
  assert.equal(model.workers[0]?.sessionId, misleadingSession.id)
  assert.equal(model.workers[0]?.runId, linkedRun.id)
  assert.equal(model.workers[0]?.departmentId, "product-engineering")
  assert.equal(model.departments.find((department) => department.id === "marketing")?.workers.length, 0)
})

test("officeWorkerStance seats running agents and paces blocked ones", () => {
  // Work has to be visible: a running agent sits at its desk and types, a
  // blocked one paces, everyone else waits. Before this, every worker walked
  // an endless loop and a busy office looked exactly like an empty one.
  assert.equal(officeWorkerStance({ active: true, statusTone: "active", blocker: null }), "working")
  assert.equal(officeWorkerStance({ active: true, statusTone: "attention", blocker: null }), "working")
  assert.equal(officeWorkerStance({ active: false, statusTone: "attention", blocker: null }), "blocked")
  assert.equal(officeWorkerStance({ active: false, statusTone: "ready", blocker: "budget" }), "blocked")
  assert.equal(officeWorkerStance({ active: false, statusTone: "ready", blocker: null }), "standby")
  assert.equal(officeWorkerStance({ active: false, statusTone: "idle", blocker: null }), "standby")
})

test("a department that starts working reports its active desks", () => {
  const runs = [
    run({ id: "r-live", prompt: "[PROACTIVO · Ingeniería de Producto] build", status: "running" }),
    run({ id: "r-done", prompt: "[PROACTIVO · Ingeniería de Producto] ship", status: "done" }),
  ]
  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions: [],
    runs,
    rootSessionId: null,
  })
  const working = model.workers.filter((worker) => officeWorkerStance(worker) === "working")
  assert.equal(working.length, 1)
  assert.equal(model.activeCount, 1)
  const department = model.departments.find((entry) => entry.activeCount > 0)
  assert.ok(department, "the running agent must light up exactly one department")
})

test("office truth binds pools, cost, evidence, approvals and blockers", () => {
  const nowMs = Date.parse("2026-07-28T18:00:00.000Z")
  const pools: CodexDepartmentPool[] = [
    {
      id: "pool-eng",
      projectId: "office-qa",
      departmentId: "product-engineering",
      size: 4,
      dailyBudgetUsd: 5,
      enabled: true,
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    },
  ]
  const runs = [
    run({
      id: "run-ok",
      status: "running",
      prompt: "[PROACTIVO · Ingeniería de Producto] Implementar billing",
      metric: {
        timeWorkedMs: 1_000,
        actionsCount: 3,
        itemsReadLines: 10,
        additions: 4,
        deletions: 1,
        tokensIn: 100,
        tokensOut: 50,
        model: "gpt-5.4",
        costUsd: 1.25,
        costSource: "meter",
        costOriginalUsd: 1.25,
        costAppliedUsd: 1.25,
        costInputUsd: 0.8,
        costOutputUsd: 0.45,
      },
    }),
    run({
      id: "run-blocked",
      status: "failed",
      prompt: "[PROACTIVO · Ingeniería de Producto] Deploy prod",
      error: "health gate failed",
      finishedAt: "2026-07-28T17:00:00.000Z",
    }),
  ]
  const missionEvidence: CodexMissionEvidenceLedger = {
    version: 1,
    summary: {
      missions: 2,
      completed: 1,
      blocked: 1,
      pendingReview: 1,
      approved: 0,
      reports: 0,
      emailQueued: 0,
    },
    records: [
      {
        id: "ev-1",
        missionId: "m1",
        missionTitle: "Billing",
        objective: "Ship billing",
        department: "product-engineering",
        status: "completed",
        summary: "PR listo para revisión",
        author: "agent",
        runId: "run-ok",
        source: "run",
        sourceRef: "run-ok",
        version: 1,
        contentHash: null,
        createdAt: "2026-07-28T16:00:00.000Z",
        updatedAt: "2026-07-28T16:00:00.000Z",
        deliverables: [],
        evidence: [],
        ceoReview: {
          status: "pending",
          reviewedAt: null,
          reviewedBy: null,
          note: null,
        },
      },
      {
        id: "ev-2",
        missionId: "m2",
        missionTitle: "Deploy",
        objective: "Deploy prod",
        department: "Ingeniería de Producto",
        status: "blocked",
        summary: "Canary rojo",
        author: "agent",
        runId: "run-blocked",
        source: "run",
        sourceRef: "run-blocked",
        version: 1,
        contentHash: null,
        createdAt: "2026-07-28T17:00:00.000Z",
        updatedAt: "2026-07-28T17:00:00.000Z",
        deliverables: [],
        evidence: [],
        ceoReview: {
          status: "pending",
          reviewedAt: null,
          reviewedBy: null,
          note: null,
        },
      },
    ],
    reports: [],
  }
  const operations: CodexCompanyOperations = {
    counts: { leads: 0, pendingInbox: 0, pendingActions: 2 },
    leads: [],
    inboxItems: [],
    actions: [],
  }
  const commandCenter = {
    readiness: {
      status: "attention",
      score: 72,
      runState: "running",
      checks: [],
    },
    mission: "Crecer",
    vision: "Escalar",
    swarmSummary: {
      logicalAgents: 3,
      active: 1,
      queued: 1,
      completed: 0,
      failed: 1,
      maxParallel: 2,
    },
    departments: [
      {
        id: "product-engineering",
        name: "Ingeniería",
        objective: "Billing",
        status: "blocked",
        logicalAgents: 2,
        activeAgents: 1,
        queuedTasks: 1,
        completedTasks: 0,
        progress: 40,
        currentWork: "Implementar billing",
      },
    ],
    liveEvents: [],
    executiveSummary: { title: "Hoy", summary: "En curso" },
    swarm: null,
    governance: {},
  } satisfies CodexEnterpriseCommandCenter
  const progressMemory: CodexProgressMemory = {
    objectives: [
      {
        id: "okr-1",
        title: "MRR",
        description: null,
        ownerDepartmentId: "product-engineering",
        metric: "usd",
        target: "10k",
        keyResults: [],
        status: "at_risk",
        priority: 1,
        reviewStatus: "approved",
        reviewNote: null,
        reviewedBy: "CEO Office",
        reviewedAt: "2026-07-28T12:00:00.000Z",
        createdAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      {
        id: "okr-2",
        title: "Latency",
        description: null,
        ownerDepartmentId: "agent-infrastructure",
        metric: "ms",
        target: "200",
        keyResults: [],
        status: "active",
        priority: 2,
        reviewStatus: "approved",
        reviewNote: null,
        reviewedBy: "CEO Office",
        reviewedAt: "2026-07-28T12:00:00.000Z",
        createdAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
    ],
    ledger: [
      {
        department: "product-engineering",
        runId: "run-ok",
        outcome: "passed",
        task: "billing",
        checkpointSha: null,
        diffstat: { additions: 4, deletions: 1, filesChanged: 1 },
        costUsd: 1.25,
        acceptance: [{ criterion: "tests", passed: true, evidence: "green" }],
        learnings: [],
        createdAt: "2026-07-28T16:05:00.000Z",
      },
    ],
  }

  const model = buildAgentOfficeModel({
    departments: AGENT_COMPANY_DEPARTMENTS,
    sessions: [],
    runs,
    rootSessionId: null,
    departmentPools: pools,
    capacity: {
      departments: AGENT_COMPANY_DEPARTMENTS.length,
      logicalAgents: 40,
      departmentPools: 1,
      physicalAgents: 4,
      writerConcurrency: 2,
      dailyBudgetUsd: 25,
      strategy: "isolated_worktrees_serialized_merge",
    },
    proactive: {
      costTodayUsd: 1.25,
      dailyBudgetUsd: 25,
      budgetBlocked: false,
    },
    commandCenter,
    missionEvidence,
    operations,
    progressMemory,
    nowMs,
  })

  const eng = model.departments.find((department) => department.id === "product-engineering")
  assert.ok(eng)
  assert.equal(eng.pool.size, 4)
  assert.equal(eng.pool.occupied, 1)
  assert.equal(eng.pool.free, 3)
  assert.equal(eng.pool.dailyBudgetUsd, 5)
  assert.equal(eng.costTodayUsd, 1.25)
  assert.equal(eng.commandStatus, "blocked")
  assert.equal(eng.evidencePending, 2)
  assert.equal(eng.evidenceBlocked, 1)
  assert.ok(eng.blockers.length >= 1)

  const blockedWorker = model.workers.find((worker) => worker.runId === "run-blocked")
  assert.equal(blockedWorker?.blocker?.includes("health gate") || blockedWorker?.blocker?.includes("Canary"), true)
  assert.equal(blockedWorker?.evidenceReview, "blocked")
  assert.equal(officeWorkerStance(blockedWorker!), "blocked")

  const liveWorker = model.workers.find((worker) => worker.runId === "run-ok")
  assert.equal(liveWorker?.costUsd, 1.25)
  assert.equal(liveWorker?.evidenceReview, "pending")

  assert.equal(model.truth.occupiedDesks, 1)
  assert.equal(model.truth.physicalAgents, 4)
  assert.equal(model.truth.writerConcurrency, 2)
  assert.equal(model.truth.costTodayUsd, 1.25)
  assert.equal(model.truth.dailyBudgetUsd, 25)
  assert.equal(model.truth.pendingApprovals, 3)
  assert.equal(model.truth.pendingEvidenceReview, 1)
  assert.equal(model.truth.blockedMissions, 1)
  assert.equal(model.truth.atRiskObjectives, 1)
  assert.equal(model.truth.activeObjectives, 1)
  assert.equal(model.truth.readinessStatus, "attention")
  assert.equal(model.truth.swarmFailed, 1)
  assert.ok(model.truth.latestBlockers.length >= 1)
})
