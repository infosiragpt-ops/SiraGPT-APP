import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  codexApi,
  codexErrorCode,
  codexIdentityIssue,
  type CodexCompanyContext,
  type CodexProject,
  type CodexRun,
} from "@/lib/codex/codex-api"

const EXPECTED_METHODS = [
  "health",
  "access",
  "getCompanyAssociation",
  "listCompanyAssociationOrphans",
  "associateCompany",
  "assignCompanyConnectors",
  "addCompanyConnector",
  "removeCompanyConnector",
  "listProjects",
  "createProject",
  "createRepositoryProject",
  "getProject",
  "startPreview",
  "previewStatus",
  "stopPreview",
  "exportProject",
  "listFiles",
  "importFiles",
  "readFileContent",
  "getProactive",
  "setProactive",
  "getCompanyOkrs",
  "reviewCompanyOkrs",
  "reprioritizeCompanyOkrs",
  "upsertDepartment",
  "deleteDepartment",
  "getDepartmentPools",
  "updateDepartmentPool",
  "getCompanyResources",
  "updateCompanyResources",
  "getCompanyProfile",
  "updateCompanyProfile",
  "runBusinessAudit",
  "getCompanyOperations",
  "getOfficeState",
  "researchCompanyLeads",
  "triageCompanyInbox",
  "triageCompanySocial",
  "updateCompanyLead",
  "prepareLeadOutreach",
  "approveCompanyAction",
  "rejectCompanyAction",
  "listProjectActivity",
  "getMissionEvidence",
  "reviewMissionEvidence",
  "createActivityReport",
  "getCommandCenter",
  "startSwarm",
  "pauseSwarm",
  "resumeSwarm",
  "cancelSwarm",
  "createRun",
  "listRuns",
  "getRun",
  "cancelRun",
  "cancelRunFamily",
  "cancelActiveRuns",
  "generateRunSummaryAudio",
  "resolveToolPermission",
  "getTranscript",
  "continueSession",
  "forkSession",
  "rewindSession",
  "approvePlan",
  "rollbackCheckpoint",
  "getCheckpointDiff",
  "listCheckpoints",
  "getPublication",
  "publishProject",
  "rollbackPublication",
] as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function requestAt(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const [input, init] = fetchMock.mock.calls[index]
  return {
    url: new URL(String(input)),
    init: init || {},
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }
}

describe("codexApi compatibility facade", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem("auth-token", "facade-test-token")
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("preserves the complete legacy method surface and exported helpers", () => {
    expect(Object.keys(codexApi)).toEqual(EXPECTED_METHODS)
    expect(EXPECTED_METHODS.every((method) => typeof codexApi[method] === "function")).toBe(true)

    expect(codexErrorCode({ body: { code: "company_association_required" } }))
      .toBe("company_association_required")
    expect(codexIdentityIssue({ status: 404 })).toEqual({
      code: "project_not_found",
      message: "El proyecto Codex asociado ya no existe.",
    })
  })

  it("keeps representative URLs, methods, payloads, and return projections unchanged", async () => {
    const project = { id: "project-1" } as CodexProject
    const resources = { assignments: { gmail: "sales" }, pinned: ["gmail"], revision: 7 }
    const run = { id: "run-1" } as CodexRun
    const company = {} as CodexCompanyContext

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ company, requiresAssociation: false }))
      .mockResolvedValueOnce(jsonResponse({ project }))
      .mockResolvedValueOnce(jsonResponse({ resources }))
      .mockResolvedValueOnce(jsonResponse({ swarm: { id: "swarm-1" }, commandCenter: {} }))
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, commitSha: "abc", restarted: false }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, publication: {}, release: {}, buildLog: "" }))

    await expect(codexApi.getCompanyAssociation("empresa /?")).resolves.toMatchObject({
      requiresAssociation: false,
    })
    await expect(codexApi.createRepositoryProject(
      "Sira",
      { url: "https://github.com/acme/sira.git", sourceBranch: "main" },
      { goal: "ship" },
    )).resolves.toEqual(project)
    await expect(codexApi.updateCompanyResources("project-1", resources)).resolves.toEqual(resources)
    await codexApi.startSwarm("project-1", {
      objective: "Build the product",
      logicalAgents: 12,
      maxConcurrency: 4,
    })
    await expect(codexApi.approvePlan("project-1", "plan-1", "pro", {
      autoExecute: true,
      model: "gpt-5",
      reasoningEffort: "high",
    })).resolves.toEqual(run)
    await codexApi.rollbackCheckpoint("checkpoint-9")
    await codexApi.publishProject("project-1", "checkpoint-9")

    expect(fetchMock).toHaveBeenCalledTimes(7)

    const associationRequest = requestAt(fetchMock, 0)
    expect(associationRequest.url.pathname).toBe("/api/codex/company-associations")
    expect(associationRequest.url.search).toBe("?projectId=empresa%20%2F%3F")
    expect(associationRequest.init.cache).toBe("no-store")

    const repositoryRequest = requestAt(fetchMock, 1)
    expect(repositoryRequest.url.pathname).toBe("/api/codex/projects")
    expect(repositoryRequest.init.method).toBe("POST")
    expect(repositoryRequest.body).toEqual({
      name: "Sira",
      brief: { goal: "ship" },
      repository: {
        url: "https://github.com/acme/sira.git",
        sourceBranch: "main",
      },
    })

    const resourcesRequest = requestAt(fetchMock, 2)
    expect(resourcesRequest.url.pathname).toBe("/api/codex/projects/project-1/company-resources")
    expect(resourcesRequest.init.method).toBe("PUT")
    expect(resourcesRequest.body).toEqual({
      assignments: { gmail: "sales" },
      pinned: ["gmail"],
      revision: 7,
      expectedRevision: 7,
    })

    const swarmRequest = requestAt(fetchMock, 3)
    expect(swarmRequest.url.pathname).toBe("/api/codex/projects/project-1/swarms")
    expect(swarmRequest.init.method).toBe("POST")
    expect(swarmRequest.body).toEqual({
      objective: "Build the product",
      logicalAgents: 12,
      maxConcurrency: 4,
    })

    const runRequest = requestAt(fetchMock, 4)
    expect(runRequest.url.pathname).toBe("/api/codex/projects/project-1/runs")
    expect(runRequest.init.method).toBe("POST")
    expect(runRequest.body).toEqual({
      mode: "build",
      planRunId: "plan-1",
      tier: "pro",
      model: "gpt-5",
      reasoningEffort: "high",
      autoExecute: true,
    })

    const checkpointRequest = requestAt(fetchMock, 5)
    expect(checkpointRequest.url.pathname).toBe("/api/codex/checkpoints/checkpoint-9/rollback")
    expect(checkpointRequest.init.method).toBe("POST")

    const publicationRequest = requestAt(fetchMock, 6)
    expect(publicationRequest.url.pathname).toBe("/api/codex/projects/project-1/publication")
    expect(publicationRequest.init.method).toBe("POST")
    expect(publicationRequest.body).toEqual({ checkpointId: "checkpoint-9" })
  })

  it("preserves authoritative complete and partial project-wide cancellation results", async () => {
    const complete = {
      complete: true,
      requestedRunIds: ["plan-1", "plan-2"],
      cancelledRunIds: ["plan-1", "build-1", "plan-2"],
      failedRunIds: [],
      runs: [
        { id: "plan-1", status: "cancelled" },
        { id: "build-1", status: "cancelled", planRunId: "plan-1" },
        { id: "plan-2", status: "cancelled" },
      ],
    }
    const partial = {
      complete: false,
      requestedRunIds: ["plan-1", "plan-2"],
      cancelledRunIds: ["plan-1", "build-1"],
      failedRunIds: ["plan-2"],
      runs: [
        { id: "plan-1", status: "cancelled" },
        { id: "build-1", status: "cancelled", planRunId: "plan-1" },
        { id: "plan-2", status: "running" },
      ],
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse(complete))
      .mockResolvedValueOnce(jsonResponse(partial, 207))

    await expect(codexApi.cancelActiveRuns("project-1")).resolves.toEqual(complete)
    await expect(codexApi.cancelActiveRuns("project-1")).resolves.toEqual(partial)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (let index = 0; index < 2; index += 1) {
      const request = requestAt(fetchMock, index)
      expect(request.url.pathname).toBe("/api/codex/projects/project-1/runs/cancel-active")
      expect(request.init.method).toBe("POST")
      expect(request.init.body).toBeUndefined()
    }
  })

  it("returns the typed partial recovery body for an HTTP 207 swarm resume", async () => {
    const partialResume = {
      complete: false,
      swarm: { id: "swarm-1", status: "running" },
      runRecovery: {
        complete: false,
        attemptCount: 2,
        scanned: 3,
        reenqueued: 1,
        live: 1,
        leaseLost: 0,
        skipped: 0,
        failed: 1,
        attempts: [],
      },
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(partialResume, 207))

    const result = await codexApi.resumeSwarm("project-1", "swarm-1")

    expect(result).toEqual(partialResume)
    expect(result.complete).toBe(false)
    expect(result.runRecovery.failed).toBe(1)
    const request = requestAt(fetchMock, 0)
    expect(request.url.pathname).toBe("/api/codex/projects/project-1/swarms/swarm-1/resume")
    expect(request.init.method).toBe("POST")
  })
})
