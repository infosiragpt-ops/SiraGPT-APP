import assert from "node:assert/strict"
import test from "node:test"

import {
  buildCompanyAgentFileArtifacts,
  resolveCompanyAgents,
} from "../lib/company-agent-file-reports"
import type { AgentDepartmentDefinition } from "../lib/code-agent-company"
import type { AgentOfficeWorker } from "../lib/agent-office-model"
import type { CodeChatSession } from "../lib/code-chat-sessions"
import type { CodexMissionEvidenceLedger } from "../lib/codex/codex-api"

const departments: AgentDepartmentDefinition[] = [
  {
    id: "ceo-office",
    name: "CEO Office",
    description: "Coordina",
    keywords: ["ceo"],
    desiredAgents: 1,
  },
  {
    id: "product-engineering",
    name: "Producto e Ingeniería",
    description: "Construye",
    keywords: ["producto", "backend", "frontend", "código", "codigo"],
    desiredAgents: 2,
  },
  {
    id: "marketing",
    name: "Marketing",
    description: "Campañas",
    keywords: ["marketing", "campaña"],
    desiredAgents: 1,
  },
]

function worker(partial: Partial<AgentOfficeWorker> & Pick<AgentOfficeWorker, "id" | "departmentId" | "name">): AgentOfficeWorker {
  return {
    source: "run",
    sessionId: null,
    runId: partial.runId || null,
    departmentName: partial.departmentName || "Producto e Ingeniería",
    task: partial.task || "Construir feature",
    statusLabel: partial.statusLabel || "Ejecutando",
    statusTone: partial.statusTone || "active",
    active: partial.active ?? true,
    activity: partial.activity || "software",
    model: partial.model || "gpt-test",
    updatedAt: partial.updatedAt || 1_700_000_000_000,
    costUsd: partial.costUsd ?? 0.12,
    blocker: partial.blocker ?? null,
    evidenceReview: partial.evidenceReview ?? null,
    evidenceSummary: partial.evidenceSummary ?? null,
    ...partial,
  }
}

test("resolveCompanyAgents prefers live workers and fills empty departments with seats", () => {
  const agents = resolveCompanyAgents({
    departments,
    workers: [
      worker({
        id: "run:eng-1",
        departmentId: "product-engineering",
        name: "Ingeniero Alpha",
        runId: "eng-1",
      }),
    ],
  })

  assert.equal(agents.filter((row) => row.departmentId === "product-engineering").length, 1)
  assert.equal(agents.filter((row) => row.departmentId === "ceo-office").length, 1)
  assert.equal(agents.filter((row) => row.departmentId === "marketing").length, 1)
  assert.ok(agents.some((row) => row.id === "run:eng-1"))
  assert.ok(agents.some((row) => row.id.startsWith("seat:ceo-office:")))
})

test("buildCompanyAgentFileArtifacts creates one report per agent and groups by agent", () => {
  const sessions: CodeChatSession[] = [
    {
      id: "sess-mkt",
      workspaceId: "project:test",
      title: "Campaña marketing Q3",
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_200_000,
      turns: [
        {
          id: "t1",
          role: "assistant",
          content: "Borrador de campaña listo.",
          streaming: false,
          agentLabel: "Marketing Lead",
        },
      ],
    },
  ]

  const missionEvidence: CodexMissionEvidenceLedger = {
    version: 1,
    summary: {
      missions: 1,
      completed: 1,
      blocked: 0,
      pendingReview: 1,
      approved: 0,
      reports: 0,
      emailQueued: 0,
    },
    records: [
      {
        id: "m1",
        missionId: "mission-eng",
        missionTitle: "API de clientes",
        objective: "CRUD clientes",
        department: "Producto e Ingeniería",
        status: "completed",
        summary: "API lista con tests.",
        author: "Ingeniero Alpha",
        runId: "eng-1",
        source: "run_completion",
        sourceRef: "run:eng-1",
        version: 1,
        contentHash: "abc",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:10:00.000Z",
        deliverables: [
          {
            id: "d1",
            name: "backend/routes/clients.ts",
            type: "file",
            ref: "backend/routes/clients.ts",
            status: "verified",
          },
        ],
        evidence: [
          {
            id: "e1",
            label: "typecheck",
            detail: "tsc ok",
            kind: "verification",
            passed: true,
          },
        ],
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

  const result = buildCompanyAgentFileArtifacts({
    companyName: "TESIS20.COM",
    departments,
    files: {
      "backend/routes/clients.ts": {
        path: "backend/routes/clients.ts",
        content: "export const ok = true\n",
        updatedAt: 1_700_000_300_000,
      },
      "docs/readme.md": {
        path: "docs/readme.md",
        content: "# hi\n",
        updatedAt: 1_700_000_250_000,
      },
    },
    sessions,
    workers: [
      worker({
        id: "run:eng-1",
        departmentId: "product-engineering",
        name: "Ingeniero Alpha",
        runId: "eng-1",
      }),
    ],
    missionEvidence,
  })

  const agentReports = result.artifacts.filter((item) => item.source === "agent-report")
  assert.equal(agentReports.length, result.agents.length)
  assert.ok(agentReports.every((item) => item.kind === "report"))
  assert.ok(agentReports.every((item) => item.path.startsWith("Agentes/")))
  assert.ok(agentReports.every((item) => item.content.includes("# Reporte de archivos ·")))

  // One group per agent, never a single global empty dump.
  assert.equal(result.groups.length, result.agents.length)
  assert.ok(result.groups.every((group) => group.artifacts.some((item) => item.source === "agent-report")))

  const engGroup = result.groups.find((group) => group.id === "run:eng-1")
  assert.ok(engGroup)
  assert.equal(engGroup?.name, "Ingeniero Alpha")
  assert.ok(engGroup?.artifacts.some((item) => item.path === "backend/routes/clients.ts"))
  assert.ok(engGroup?.artifacts.some((item) => item.source === "mission"))
  assert.match(
    engGroup?.artifacts.find((item) => item.source === "agent-report")?.content || "",
    /API de clientes/,
  )

  const marketingGroup = result.groups.find((group) => group.departmentId === "marketing")
  assert.ok(marketingGroup)
  assert.ok(marketingGroup?.artifacts.some((item) => item.source === "session"))
})

test("empty company still exposes one report folder per agent seat", () => {
  const result = buildCompanyAgentFileArtifacts({
    companyName: "TESIS20.COM",
    departments,
    files: {},
    sessions: [],
    workers: [],
    missionEvidence: null,
  })

  assert.equal(result.agents.length, 4) // 1 + 2 + 1 seats
  assert.equal(result.groups.length, 4)
  assert.equal(result.artifacts.length, 4)
  assert.ok(result.artifacts.every((item) => item.source === "agent-report"))
  assert.ok(result.artifacts.every((item) => item.content.includes("Sin archivos de workspace atribuidos todavía.")))
})
