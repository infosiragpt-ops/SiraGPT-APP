import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  codexApi,
  type CodexOfficeState,
  type CodexRun,
} from "@/lib/codex/codex-api"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const OFFICE_STATE: CodexOfficeState = {
  generatedAt: "2026-08-10T15:00:00.000Z",
  projectId: "project-1",
  proactive: {
    enabled: true,
    runsToday: 3,
    lastCycleAt: "2026-08-10T14:59:00.000Z",
    lastError: null,
  },
  lease: {
    active: true,
    expiresAt: "2026-08-10T15:05:00.000Z",
  },
  pools: [{
    id: "pool-engineering",
    departmentId: "product-engineering",
    size: 8,
    enabled: true,
    dailyBudgetUsd: 20,
    spentTodayUsd: 1.25,
    activeRuns: 1,
  }],
  runs: {
    active: [{
      id: "run-1",
      mode: "build",
      status: "running",
      departmentPoolId: "pool-engineering",
      swarmTaskId: null,
      createdAt: "2026-08-10T14:50:00.000Z",
      startedAt: "2026-08-10T14:51:00.000Z",
      updatedAt: "2026-08-10T14:59:30.000Z",
    }],
    recentErrors: [],
  },
  missions: {
    counts: { in_progress: 1, blocked: 0, completed: 2 },
    open: [{
      id: "mission-1",
      missionKey: "ship-office",
      title: "Interconectar la oficina",
      department: "product-engineering",
      status: "in_progress",
      updatedAt: "2026-08-10T14:58:00.000Z",
    }],
  },
  evidence: { artifacts: 4 },
  approvals: { pending: [], count: 0 },
  operations: { pendingInbox: 1, pendingActions: 0, leads: 5 },
  usageToday: { costUsd: 1.25, tokensIn: 1000, tokensOut: 400, entries: 2 },
  blockers: [{
    kind: "inbox_attention",
    id: "inbox-1",
    department: null,
    title: "Correo crítico sin resolver",
    detail: "Incidente de cliente",
    since: "2026-08-10T14:55:00.000Z",
  }],
}

describe("codexApi.getOfficeState", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem("auth-token", "office-state-test-token")
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("requests the tenant-scoped no-store URL and preserves the complete state shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: OFFICE_STATE }))

    await expect(
      codexApi.getOfficeState("project /?", { take: 250.8 }),
    ).resolves.toEqual(OFFICE_STATE)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0]
    const url = new URL(String(input))
    expect(url.pathname).toBe("/api/codex/projects/project%20%2F%3F/office-state")
    expect(url.search).toBe("?take=100")
    expect(init?.cache).toBe("no-store")
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer office-state-test-token")
  })

  it("omits take when it is absent and surfaces the backend status and body on errors", async () => {
    const failure = {
      error: "codex_office_state_failed",
      message: "Office state unavailable",
    }
    // The shared transport retries a 503 once (250ms backoff) before the
    // structured error surfaces; both attempts see the same failure body.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(failure, 503))
      .mockResolvedValueOnce(jsonResponse(failure, 503))

    await expect(codexApi.getOfficeState("project-1")).rejects.toMatchObject({
      message: "Office state unavailable",
      status: 503,
      body: failure,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [input] = fetchMock.mock.calls[0]
    const url = new URL(String(input))
    expect(url.pathname).toBe("/api/codex/projects/project-1/office-state")
    expect(url.search).toBe("")
  })

  it("keeps legacy runs compatible while exposing durable pool attribution", () => {
    const legacyRun: CodexRun = {
      id: "legacy",
      projectId: "project-1",
      mode: "build",
      status: "done",
      tier: null,
      model: null,
      planRunId: null,
      prompt: null,
      error: null,
      createdAt: "2026-08-10T14:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-08-10T14:01:00.000Z",
    }
    const pooledRun: CodexRun = {
      ...legacyRun,
      id: "pooled",
      departmentPoolId: "pool-engineering",
    }

    expect(legacyRun.departmentPoolId).toBeUndefined()
    expect(pooledRun.departmentPoolId).toBe("pool-engineering")
  })
})
