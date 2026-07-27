// codex/codex-api — typed HTTP client for the Codex Agent V2 backend
// (/api/codex/*). Mirrors lib/builder/intake-service.ts: localStorage JWT
// Bearer + credentials:include. Used by the timeline hook (feature 10) and the
// cards/composer (features 11–12).

import { authenticatedFetch } from "../authenticated-fetch"

const BASE = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")}/codex`

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

type CodexRequestInit = RequestInit & { timeoutMs?: number }

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function boundedRequestSignal(
  externalSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!externalSignal) return timeoutSignal

  const anySignal = (
    AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal
    }
  ).any
  if (anySignal) return anySignal([externalSignal, timeoutSignal])

  // Compatibility fallback for browsers that have AbortSignal.timeout() but
  // not AbortSignal.any(): either user cancellation or the hard deadline wins.
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (externalSignal.aborted || timeoutSignal.aborted) {
    abort()
  } else {
    externalSignal.addEventListener("abort", abort, { once: true })
    timeoutSignal.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

async function req<T>(path: string, init?: CodexRequestInit): Promise<T> {
  // A hung backend must never freeze the composer's busy latch: every JSON
  // call gets a hard timeout (SSE streaming goes through run-stream.ts, not
  // req(), so this is safe globally). Preview startup is the exception: the
  // backend may legitimately wait up to 90s for a cold install, so that caller
  // opts into a larger bounded timeout.
  const { timeoutMs = 20_000, ...requestInit } = init || {}
  const res = await authenticatedFetch(`${BASE}${path}`, {
    credentials: "include",
    headers: authHeaders(),
    ...requestInit,
    signal: boundedRequestSignal(requestInit.signal, timeoutMs),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error((body as any)?.message || (body as any)?.error || `codex http ${res.status}`), { status: res.status, body })
  return body as T
}

export interface CodexHealth { ok: boolean; enabled: boolean; previewOrigin?: string | null }
export interface CodexAccess { ok: boolean; enabled: boolean; canRun: boolean; allowlistConfigured: boolean }
export interface CodexProject { id: string; name: string; status: string; workspacePath: string | null; previewUrl: string | null; error: string | null }
export interface CodexRun {
  id: string
  projectId: string
  mode: string
  status: string
  tier: string | null
  model: string | null
  planRunId: string | null
  prompt: string | null
  autoExecute?: boolean
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  metric?: CodexRunMetric
}
export interface CodexRunMetric { timeWorkedMs: number; actionsCount: number; itemsReadLines: number; additions: number; deletions: number; tokensIn: number; tokensOut: number; model: string | null; costUsd: number; costSource: string; costOriginalUsd: number; costAppliedUsd: number; costInputUsd: number; costOutputUsd: number }
export interface CodexCheckpointDiff { ok: boolean; commitSha: string; diff: string; truncated: boolean; additions: number; deletions: number; filesChanged: number }
export interface CodexCheckpoint { id: string; commitSha: string; shortSha: string; title: string; createdAt: string; additions: number | null; deletions: number | null }
export interface CodexObjective { id: string; title: string; metric: string | null; target: string | null; status: "active" | "at_risk" | "done" | "paused"; priority: number; updatedAt: string | null }
export interface CodexLedgerEntry {
  department: string
  runId: string
  outcome: "passed" | "failed" | "cancelled" | "blocked"
  task: string | null
  checkpointSha: string | null
  diffstat: { additions: number; deletions: number; filesChanged: number }
  costUsd: number
  acceptance: Array<{ criterion: string; passed: boolean; evidence: string | null }>
  learnings: string[]
  createdAt: string
}
export interface CodexProgressMemory { objectives: CodexObjective[]; ledger: CodexLedgerEntry[] }
export interface CodexCompanyProfile {
  version: number
  companyName: string
  stage: "new" | "existing" | "growing" | "unknown"
  mission: string | null
  vision: string | null
  offer: string | null
  targetCustomer: string | null
  businessModel: string | null
  industry: string | null
  market: string | null
  brandVoice: string | null
  websiteUrl: string | null
  salesProcess: string | null
  autonomy: {
    research: boolean
    codeChanges: "review" | "auto" | "off"
    socialPublishing: "review" | "auto" | "off"
    socialReplies: "review" | "auto" | "off"
    emailReplies: "review" | "auto" | "off"
    leadOutreach: "review" | "auto" | "off"
  }
  updatedAt: string
}
export type CodexCompanyProfilePatch =
  Omit<Partial<CodexCompanyProfile>, "autonomy"> & {
    autonomy?: Partial<CodexCompanyProfile["autonomy"]>
  }
export interface CodexCompanyReadinessArea {
  id: string
  label: string
  status: "ready" | "needs_attention" | "blocked"
  evidence: string
  action: string
}
export interface CodexCompanyContext {
  profile: CodexCompanyProfile
  readiness: {
    score: number
    readyCount: number
    total: number
    areas: CodexCompanyReadinessArea[]
    gaps: Array<Pick<CodexCompanyReadinessArea, "id" | "label" | "status" | "action">>
    evidence: {
      publishedUrl: string | null
      workspaceReady: boolean
      socialConnections: Array<{ platform: string; accountName: string | null }>
      gmailConnected: boolean
    }
  }
  safeguards: {
    externalActionsRequireConnection: boolean
    defaultExternalMode: "review"
    socialPublishing: "review" | "auto" | "off"
    socialReplies: "review" | "auto" | "off"
    emailReplies: "review" | "auto" | "off"
    leadOutreach: "review" | "auto" | "off"
  }
  portfolio?: {
    version: number
    generatedAt: string
    companyName: string
    summary: {
      total: number
      readyToExecute: number
      reviewRequired: number
      blocked: number
      completed: number
      paused: number
      highestPriorityMissionId: string | null
    }
    missions: Array<{
      id: string
      title: string
      departmentId: string
      departmentName: string
      priority: number
      status: "ready_to_execute" | "review_required" | "blocked" | "blocked_connection" | "integration_required" | "completed" | "paused"
      executionMode: "code" | "research" | "external"
      objective: string
      evidence: string
      nextAction: string
      sourceArea: string | null
      externalEffect: boolean
      autoExecutable: boolean
      approval: string | null
      executor: "agent-run" | "social-publish" | null
    }>
  }
}
export interface CodexProactiveState {
  enabled: boolean
  enabledAt: string | null
  dayKey: string | null
  runsToday: number
  deptIndex: number
  lastCycleAt: string | null
  lastError: string | null
  costTodayUsd: number
  dailyBudgetUsd: number
  budgetBlocked: boolean
  lastDepartment: string | null
  missionIndex: number
  lastMissionId: string | null
}
export interface CodexCompanyDepartment {
  id: string
  name: string
  mission: string
  description: string
  keywords: string[]
  kind: "coordination" | "engineering" | "research" | "external"
  desiredAgents: number
  custom: boolean
  enabled: boolean
}
export interface CodexCompanyCapacity {
  departments: number
  logicalAgents: number
  writerConcurrency: number
  strategy: "parallel_readers_serialized_writer"
}
export interface CodexCompanyLead {
  id: string
  companyName: string
  contactName: string | null
  domain: string | null
  websiteUrl: string | null
  email: string | null
  sourceUrl: string
  sourceTitle: string | null
  evidence: string | null
  status: string
  score: number
  tags: string[] | null
  lastContactedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface CodexCompanyInboxItem {
  id: string
  externalId: string
  senderEmail: string | null
  senderName: string | null
  subject: string | null
  snippet: string | null
  category: string
  urgency: string
  status: string
  draftBody: string | null
  providerDraftId: string | null
  createdAt: string
  updatedAt: string
}
export interface CodexExternalAction {
  id: string
  kind: "email_reply" | "lead_outreach" | "social_reply"
  targetRef: string
  status: string
  payload: {
    body?: string
    subject?: string
    to?: string
    sourceUrl?: string
  }
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface CodexCompanyOperations {
  counts: {
    leads: number
    pendingInbox: number
    pendingActions: number
  }
  leads: CodexCompanyLead[]
  inboxItems: CodexCompanyInboxItem[]
  actions: CodexExternalAction[]
}
export interface CodexPublicationRelease {
  id: string
  checkpointId: string
  commitSha: string
  outDir: string
  files: number
  bytes: number
  publishedAt: string
}
export interface CodexPublication {
  hostname: string | null
  url: string | null
  currentReleaseId: string | null
  publishedAt: string | null
  releases: CodexPublicationRelease[]
}
export interface CodexTranscriptEntry {
  seq: number
  sourceSeq?: number
  runId?: string
  ts?: string
  type?: string
  data?: unknown
  createdAt?: string
}
export interface CodexSessionSnapshot {
  version: number
  projectId: string
  sessionId: string
  cursorSeq: number
  checkpointSha: string | null
  checkpointId: string | null
  loopState: unknown
  metadata: unknown
  updatedAt: string
}

async function getPublicHealth(): Promise<CodexHealth> {
  const res = await fetch(`${BASE}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw Object.assign(new Error((body as any)?.error || `codex http ${res.status}`), {
      status: res.status,
      body,
    })
  }
  return body as CodexHealth
}

export const codexApi = {
  // no-store: the flag can change; a cached 304 (enabled:false) would strand
  // the UI on the old /code flow even after the flag is turned on.
  health: getPublicHealth,
  access: () => req<CodexAccess>("/access", { cache: "no-store" }),

  listProjects: () => req<{ projects: CodexProject[] }>("/projects").then((r) => r.projects),
  createProject: (name: string, brief?: unknown) => req<{ project: CodexProject }>("/projects", { method: "POST", body: JSON.stringify({ name, brief }) }).then((r) => r.project),
  createRepositoryProject: (name: string, repository: { url: string; sourceBranch?: string }, brief?: unknown) =>
    req<{ project: CodexProject }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, brief, repository }),
      timeoutMs: 180_000,
    }).then((r) => r.project),
  getProject: (id: string) => req<{ project: CodexProject }>(`/projects/${id}`).then((r) => r.project),
  startPreview: (id: string, signal?: AbortSignal) =>
    req<{ devUrl: string; previewUrl?: string; basePath?: string }>(
      `/projects/${id}/preview/start`,
      { method: "POST", timeoutMs: 110_000, signal },
    ),
  previewStatus: (id: string) => req<any>(`/projects/${id}/preview/status`),
  stopPreview: (id: string) => req<{ ok: boolean }>(`/projects/${id}/preview/stop`, { method: "POST" }),
  exportProject: (id: string) => req<{ ok: boolean; project: string; files: number; hostPath: string }>(`/projects/${id}/export`, { method: "POST" }),
  listFiles: (id: string) => req<{ files: string[] }>(`/projects/${id}/files`).then((r) => r.files),
  // Workspace import (browser → Codex project): push the local files into the
  // project BEFORE an iterate run so the agent edits the tree the user sees.
  importFiles: (id: string, files: Array<{ path: string; content: string }>) =>
    req<{ ok: boolean; written: number }>(`/projects/${id}/files`, { method: "POST", body: JSON.stringify({ files }) }),
  readFileContent: (id: string, path: string) => req<{ ok: boolean; path: string; content: string }>(`/projects/${id}/file?path=${encodeURIComponent(path)}`),

  // Modo PROACTIVO (compañía de agentes autónoma). no-store: el estado cambia
  // desde el ticker del backend, un 304 cacheado dejaría el chip mintiendo.
  getProactive: (id: string) =>
    req<{ state: CodexProactiveState; departments: CodexCompanyDepartment[]; capacity: CodexCompanyCapacity; memory: CodexProgressMemory; company: CodexCompanyContext }>(`/projects/${id}/proactive`, { cache: "no-store" }),
  setProactive: (id: string, enabled: boolean) =>
    req<{ state: CodexProactiveState; departments: CodexCompanyDepartment[]; capacity: CodexCompanyCapacity }>(`/projects/${id}/proactive`, { method: "POST", body: JSON.stringify({ enabled }) }),
  upsertDepartment: (id: string, department: Partial<CodexCompanyDepartment> & { name: string }) =>
    req<{ departments: CodexCompanyDepartment[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/departments`,
      { method: "PUT", body: JSON.stringify({ department }) },
    ),
  getCompanyProfile: (id: string) =>
    req<{ company: CodexCompanyContext }>(`/projects/${id}/company-profile`, { cache: "no-store" })
      .then((result) => result.company),
  updateCompanyProfile: (
    id: string,
    profile: CodexCompanyProfilePatch,
    options?: { confirmAuto?: boolean },
  ) =>
    req<{ company: CodexCompanyContext }>(`/projects/${id}/company-profile`, {
      method: "PATCH",
      body: JSON.stringify({ profile, confirmAuto: options?.confirmAuto === true }),
    }).then((result) => result.company),
  getCompanyOperations: (id: string) =>
    req<{ operations: CodexCompanyOperations }>(
      `/projects/${id}/company-operations`,
      { cache: "no-store" },
    ).then((result) => result.operations),
  researchCompanyLeads: (id: string) =>
    req<{ result: { action: string; leads?: CodexCompanyLead[]; sourceCount?: number } }>(
      `/projects/${id}/company-operations/research-leads`,
      { method: "POST" },
    ).then((result) => result.result),
  triageCompanyInbox: (id: string, maxResults = 15) =>
    req<{ result: { action: string; items: CodexCompanyInboxItem[]; actions: CodexExternalAction[] } }>(
      `/projects/${id}/company-operations/triage-inbox`,
      { method: "POST", body: JSON.stringify({ maxResults }) },
    ).then((result) => result.result),
  updateCompanyLead: (
    id: string,
    leadId: string,
    patch: { email?: string | null; contactName?: string | null; status?: string },
  ) =>
    req<{ lead: CodexCompanyLead }>(`/projects/${id}/company-operations/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((result) => result.lead),
  prepareLeadOutreach: (id: string, leadId: string) =>
    req<{ result: { action: string; record: CodexExternalAction | null } }>(
      `/projects/${id}/company-operations/leads/${leadId}/outreach`,
      { method: "POST" },
    ).then((result) => result.result),
  approveCompanyAction: (id: string, actionId: string) =>
    req<{ result: { action: string; record: CodexExternalAction | null } }>(
      `/projects/${id}/company-operations/actions/${actionId}/approve`,
      { method: "POST" },
    ).then((result) => result.result),
  rejectCompanyAction: (id: string, actionId: string) =>
    req<{ result: { action: string } }>(
      `/projects/${id}/company-operations/actions/${actionId}/reject`,
      { method: "POST" },
    ).then((result) => result.result),

  createRun: (projectId: string, body: { mode: "plan" | "build"; prompt?: string; model?: string; tier?: string; planRunId?: string; autoExecute?: boolean }) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.run),
  listRuns: (projectId: string) =>
    req<{ runs?: unknown }>(`/projects/${projectId}/runs`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexRun>(r?.runs)),
  getRun: (projectId: string, runId: string) => req<{ run: CodexRun }>(`/projects/${projectId}/runs/${runId}`).then((r) => r.run),
  cancelRun: (runId: string) => req<{ run: CodexRun }>(`/runs/${runId}/cancel`, { method: "POST" }).then((r) => r.run),
  resolveToolPermission: (runId: string, permissionId: string, decision: "allow" | "deny") =>
    req<{ run: CodexRun }>(`/runs/${runId}/tool-permission`, {
      method: "POST",
      body: JSON.stringify({ permissionId, decision }),
    }).then((r) => r.run),
  getTranscript: (projectId: string, runId: string, afterSeq = 0, limit = 200) =>
    req<{ transcript: { sessionId: string; entries: CodexTranscriptEntry[]; malformed: number; firstSeq: number | null; lastSeq: number | null } }>(
      `/projects/${projectId}/runs/${runId}/transcript?afterSeq=${afterSeq}&limit=${limit}`,
      { cache: "no-store" },
    ).then((r) => r.transcript),
  continueSession: (projectId: string, runId: string, afterSeq?: number) =>
    req<{ session: { ok: boolean; sessionId: string; resumable: boolean; snapshot: CodexSessionSnapshot | null; cursorSeq: number; tail: CodexTranscriptEntry[] } }>(
      `/projects/${projectId}/runs/${runId}/session/continue`,
      { method: "POST", body: JSON.stringify(afterSeq == null ? {} : { afterSeq }) },
    ).then((r) => r.session),
  forkSession: (projectId: string, runId: string, atSeq?: number) =>
    req<{ session: { ok: boolean; sourceSessionId: string; sessionId: string; entries: number; lastSeq: number | null } }>(
      `/projects/${projectId}/runs/${runId}/session/fork`,
      { method: "POST", body: JSON.stringify(atSeq == null ? {} : { atSeq }) },
    ).then((r) => r.session),
  rewindSession: (projectId: string, runId: string, toSeq: number, checkpointId?: string) =>
    req<{ session: { ok: boolean; sessionId: string; toSeq: number; entries: number; lastSeq: number | null } }>(
      `/projects/${projectId}/runs/${runId}/session/rewind`,
      { method: "POST", body: JSON.stringify({ toSeq, ...(checkpointId ? { checkpointId } : {}) }) },
    ).then((r) => r.session),

  approvePlan: (projectId: string, planRunId: string, tier?: string) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify({ mode: "build", planRunId, tier }) }).then((r) => r.run),
  rollbackCheckpoint: (checkpointId: string) => req<{ ok: boolean; commitSha: string; restarted: boolean }>(`/checkpoints/${checkpointId}/rollback`, { method: "POST" }),
  getCheckpointDiff: (checkpointId: string) => req<CodexCheckpointDiff>(`/checkpoints/${checkpointId}/diff`),
  listCheckpoints: (projectId: string) =>
    req<{ checkpoints?: unknown }>(`/projects/${projectId}/checkpoints`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexCheckpoint>(r?.checkpoints)),
  getPublication: (projectId: string) =>
    req<{ publication: CodexPublication }>(`/projects/${projectId}/publication`, { cache: "no-store" })
      .then((r) => r.publication),
  publishProject: (projectId: string, checkpointId?: string) =>
    req<{ ok: boolean; publication: CodexPublication; release: CodexPublicationRelease; buildLog: string }>(
      `/projects/${projectId}/publication`,
      {
        method: "POST",
        body: JSON.stringify(checkpointId ? { checkpointId } : {}),
        timeoutMs: 240_000,
      },
    ),
  rollbackPublication: (projectId: string, releaseId: string) =>
    req<{ ok: boolean; publication: CodexPublication; release: CodexPublicationRelease }>(
      `/projects/${projectId}/publication/rollback`,
      { method: "POST", body: JSON.stringify({ releaseId }), timeoutMs: 60_000 },
    ),
} as const
