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

export function codexErrorCode(error: unknown): string | null {
  const candidate = error as {
    code?: unknown
    body?: { error?: unknown; code?: unknown }
    status?: unknown
  } | null
  if (typeof candidate?.code === "string" && candidate.code.trim()) return candidate.code.trim()
  if (typeof candidate?.body?.error === "string" && candidate.body.error.trim()) return candidate.body.error.trim()
  if (typeof candidate?.body?.code === "string" && candidate.body.code.trim()) return candidate.body.code.trim()
  return candidate?.status === 404 ? "project_not_found" : null
}

export function codexIdentityIssue(
  error: unknown,
  fallbackCode = "company_association_unavailable",
): { code: string; message: string } {
  const code = codexErrorCode(error) || fallbackCode
  const message = code === "company_project_not_found"
    ? "No se encontró el Project de esta empresa o ya no tienes acceso."
    : code === "project_not_found"
      ? "El proyecto Codex asociado ya no existe."
      : "No se pudo comprobar la asociación persistente."
  return { code, message }
}

export interface CodexHealth { ok: boolean; enabled: boolean; previewOrigin?: string | null }
export interface CodexAccess { ok: boolean; enabled: boolean; canRun: boolean; allowlistConfigured: boolean }
export interface CodexProject { id: string; name: string; status: string; organizationId?: string | null; workspacePath: string | null; previewUrl: string | null; error: string | null }
export interface CodexCompanyConnectorAssignment {
  id: string
  provider: string
  accountLabel: string | null
  organizationId: string | null
  scopes: string[]
  status: string
  lastHealthAt: string | null
  lastError: string | null
  updatedAt: string | null
}
export interface CodexCompanyAssociationProject {
  id: string
  name: string
  organizationId: string | null
  type?: string
  status?: string
  updatedAt: string | null
}
export interface CodexCompanyAssociation {
  id: string
  source: "manual" | "created_for_company"
  organizationId: string | null
  linkedAt: string
  updatedAt: string
  codexProject: CodexCompanyAssociationProject
  connectors: CodexCompanyConnectorAssignment[]
}
export interface CodexCompanyAssociationState {
  company: CodexCompanyAssociationProject
  association: CodexCompanyAssociation | null
  candidates: CodexCompanyAssociationProject[]
  connectors: CodexCompanyConnectorAssignment[]
  requiresAssociation: boolean
}
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
export interface CodexKeyResult {
  id: string
  title: string
  metric: string | null
  baseline: string | null
  current: string | null
  target: string | null
  unit: string | null
  status: "not_started" | "on_track" | "at_risk" | "achieved"
  progress: number | null
  updatedAt: string | null
}
export interface CodexObjective {
  id: string
  title: string
  description: string | null
  ownerDepartmentId: string | null
  metric: string | null
  target: string | null
  keyResults: CodexKeyResult[]
  status: "active" | "at_risk" | "done" | "paused"
  priority: number
  reviewStatus: "pending" | "approved" | "changes_requested"
  reviewNote: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}
export interface CodexObjectiveReview {
  id: string
  revision: number
  reviewer: string
  source: string
  decision: "approved" | "changes_requested"
  rationale: string | null
  objectiveIds: string[]
  changes: {
    added: number
    removed: number
    reprioritized: number
    statusChanged: number
    keyResultsChanged: number
  }
  createdAt: string
}
export interface CodexObjectivePortfolio {
  version: number
  revision: number
  objectives: CodexObjective[]
  latestReview: CodexObjectiveReview | null
  summary: {
    total: number
    active: number
    atRisk: number
    done: number
    averageProgress: number
  }
  reviews: CodexObjectiveReview[]
}
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
export interface CodexBusinessAudit {
  version: number
  generatedAt: string
  projectId: string | null
  companyName: string
  status: "healthy" | "gaps_detected"
  score: number
  networkUsed: boolean
  websiteUrl: string | null
  signals: Array<{
    id: "software" | "landing" | "social" | "seo" | string
    label: string
    status: "ready" | "observed" | "needs_attention" | "blocked"
    evidence: string
    sources: string[]
  }>
  gaps: Array<{
    id: string
    priority: "P0" | "P1" | "P2"
    score: number
    departmentId: string
    title: string
    action: string
    evidence: string | null
  }>
  sources: Array<{
    kind: string
    title: string | null
    url: string
    snippet: string | null
    provider: string | null
  }>
}
export interface CodexCompanyContext {
  profile: CodexCompanyProfile
  okrs: CodexObjectivePortfolio
  readiness: {
    score: number
    readyCount: number
    total: number
    areas: CodexCompanyReadinessArea[]
    gaps: Array<Pick<CodexCompanyReadinessArea, "id" | "label" | "status" | "action">>
    evidence: {
      publishedUrl: string | null
      workspaceReady: boolean
      socialConnections: Array<{
        platform: string
        accountName: string | null
        scopes: string[]
        conversationsReady: boolean
      }>
      gmailConnected: boolean
      connectorAssignment?: {
        enforced: boolean
        companyProjectId: string | null
        providers: string[]
        accountIds: string[]
      }
    }
  }
  businessAudit: CodexBusinessAudit | null
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
      executor: "agent-run" | "social-publish" | "company-operation" | null
    }>
  }
}
export type CodexMissionReviewStatus = "pending" | "approved" | "changes_requested" | "rejected"
export interface CodexMissionEvidenceRecord {
  id: string
  missionId: string
  missionTitle: string
  objective: string
  department: string
  status: "completed" | "blocked"
  summary: string
  author: string
  runId: string | null
  source: string
  sourceRef: string
  version: number
  contentHash: string | null
  createdAt: string
  updatedAt: string
  deliverables: Array<{
    id: string
    name: string
    type: string
    ref: string | null
    status: "recorded" | "verified"
  }>
  evidence: Array<{
    id: string
    label: string
    detail: string
    kind: string
    passed: boolean | null
  }>
  ceoReview: {
    status: CodexMissionReviewStatus
    reviewedAt: string | null
    reviewedBy: string | null
    note: string | null
  }
}
export interface CodexActivityReport {
  id: string
  title: string
  summary: string
  author: string
  source: string
  sourceRef: string
  version: number
  contentHash: string | null
  createdAt: string
  period: { from: string; to: string }
  counts: {
    missions: number
    completed: number
    blocked: number
    pendingReview: number
    approved: number
  }
  status: "draft" | "queued"
  delivery: {
    channel: "email"
    status: "not_requested" | "blocked_connection" | "blocked_policy" | "pending_permission" | "queued"
    connectionReady: boolean
    permissionGranted: boolean
    permissionMode: "review" | "auto" | "off"
    queuedAt: string | null
    sentAt: null
    reason: string | null
  }
}
export interface CodexMissionEvidenceLedger {
  version: number
  summary: {
    missions: number
    completed: number
    blocked: number
    pendingReview: number
    approved: number
    reports: number
    emailQueued: number
  }
  records: CodexMissionEvidenceRecord[]
  reports: CodexActivityReport[]
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
export interface CodexDepartmentPool {
  id: string
  projectId: string
  departmentId: string
  size: number
  dailyBudgetUsd: number | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}
export interface CodexCompanyCapacity {
  departments: number
  logicalAgents: number
  departmentPools: number
  physicalAgents: number
  writerConcurrency: number
  dailyBudgetUsd: number
  strategy: "isolated_worktrees_serialized_merge"
}
export interface CodexCompanyResourceState {
  assignments: Record<string, string>
  pinned: string[]
  revision: number
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
  provider: string
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
  kind: "email_reply" | "email_send" | "email_forward" | "lead_outreach" | "social_reply"
  targetRef: string
  status: string
  expiresAt?: string | null
  consumedAt?: string | null
  attemptId?: string | null
  revokedAt?: string | null
  payload: {
    body?: string
    subject?: string
    to?: string
    sourceUrl?: string
    platform?: string
    interactionId?: string
    connectionId?: string
    authorId?: string
    metadata?: Record<string, string | null>
    providerDraftId?: string | null
    _approval?: {
      actionHash?: string | null
      version?: number | null
      expiresAt?: string | null
      attemptId?: string | null
      mode?: string | null
    }
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
export interface CodexProjectActivity {
  id: string
  runId: string
  seq: number
  type: string
  department: string
  createdAt: string
  tone: "active" | "success" | "info" | "attention" | "error"
  title: string
  detail: string
}
export type CodexSwarmStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
export interface CodexSwarmSummary {
  id: string
  name: string
  status: CodexSwarmStatus
  progressPercent: number
  maxConcurrency: number
  totalTaskCount: number
  updatedAt: string
}
export interface CodexEnterpriseCommandCenter {
  readiness: {
    status: "ready" | "attention" | "blocked"
    score: number
    runState: "idle" | "running" | "paused" | "completed" | "failed"
    checks: Array<{
      id: string
      label: string
      status: "ready" | "attention" | "blocked"
      detail?: string
    }>
    lastCheckedAt?: string
  }
  mission: string
  vision: string
  swarmSummary: {
    logicalAgents: number
    active: number
    queued: number
    completed: number
    failed: number
    maxParallel: number
  }
  departments: Array<{
    id: string
    workstreamId?: string
    name: string
    objective: string
    status: "active" | "queued" | "paused" | "blocked" | "completed"
    logicalAgents: number
    activeAgents: number
    queuedTasks: number
    completedTasks: number
    progress: number
    currentWork?: string | null
    owner?: string
    lastUpdatedAt?: string
  }>
  liveEvents: Array<{
    id: string
    timestamp: string
    title: string
    kind: "planning" | "delegation" | "research" | "coding" | "verification" | "delivery" | "warning" | "error"
    status: "running" | "completed" | "blocked"
    detail?: string
    departmentId?: string
    departmentName?: string
  }>
  executiveSummary: {
    title: string
    summary: string
    updatedAt?: string
    highlights?: string[]
    risks?: string[]
    nextActions?: string[]
  }
  swarm: CodexSwarmSummary | null
  governance: Record<string, unknown>
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

  getCompanyAssociation: (projectId: string) =>
    req<CodexCompanyAssociationState>(
      `/company-associations?projectId=${encodeURIComponent(projectId)}`,
      { cache: "no-store" },
    ),
  listCompanyAssociationOrphans: () =>
    req<{
      companies: CodexCompanyAssociationProject[]
      codexProjects: CodexCompanyAssociationProject[]
      backfillApplied: false
    }>("/company-associations/orphans", { cache: "no-store" }),
  associateCompany: (
    projectId: string,
    codexProjectId: string,
    connectorAccountIds: string[] = [],
    source: "manual" | "created_for_company" = "manual",
  ) =>
    req<{ association: CodexCompanyAssociation }>("/company-associations", {
      method: "POST",
      body: JSON.stringify({ projectId, codexProjectId, connectorAccountIds, source }),
    }).then((result) => result.association),
  assignCompanyConnectors: (projectId: string, connectorAccountIds: string[]) =>
    req<{ connectors: CodexCompanyConnectorAssignment[] }>(
      `/company-associations/${encodeURIComponent(projectId)}/connectors`,
      {
        method: "PUT",
        body: JSON.stringify({ connectorAccountIds }),
      },
    ).then((result) => result.connectors),
  addCompanyConnector: (projectId: string, connectorAccountId: string) =>
    req<{ connector: CodexCompanyConnectorAssignment; changed: boolean }>(
      `/company-associations/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(connectorAccountId)}`,
      { method: "POST" },
    ),
  removeCompanyConnector: (projectId: string, connectorAccountId: string) =>
    req<{ connector: CodexCompanyConnectorAssignment; changed: boolean }>(
      `/company-associations/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(connectorAccountId)}`,
      { method: "DELETE" },
    ),

  listProjects: () => req<{ projects: CodexProject[] }>("/projects").then((r) => r.projects),
  createProject: (name: string, brief?: unknown, organizationId?: string | null) =>
    req<{ project: CodexProject }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, brief, organizationId: organizationId || null }),
    }).then((r) => r.project),
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
  previewStatus: (id: string) => req<any>(`/projects/${id}/preview/status`, { cache: "no-store" }),
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
    req<{ state: CodexProactiveState; departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity; memory: CodexProgressMemory; company: CodexCompanyContext }>(`/projects/${id}/proactive`, { cache: "no-store" }),
  setProactive: (id: string, enabled: boolean) =>
    req<{ state: CodexProactiveState; departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(`/projects/${id}/proactive`, { method: "POST", body: JSON.stringify({ enabled }) }),
  getCompanyOkrs: (id: string) =>
    req<{ portfolio: CodexObjectivePortfolio }>(
      `/projects/${id}/okrs`,
      { cache: "no-store" },
    ).then((result) => result.portfolio),
  reviewCompanyOkrs: (
    id: string,
    portfolio: Pick<CodexObjectivePortfolio, "revision" | "objectives">,
    options?: {
      decision?: CodexObjectiveReview["decision"]
      rationale?: string | null
    },
  ) =>
    req<{ portfolio: CodexObjectivePortfolio }>(
      `/projects/${id}/okrs/review`,
      {
        method: "PUT",
        body: JSON.stringify({
          objectives: portfolio.objectives,
          expectedRevision: portfolio.revision,
          decision: options?.decision || "approved",
          rationale: options?.rationale || null,
        }),
      },
    ).then((result) => result.portfolio),
  reprioritizeCompanyOkrs: (
    id: string,
    orderedIds: string[],
    expectedRevision: number,
    rationale?: string | null,
  ) =>
    req<{ portfolio: CodexObjectivePortfolio }>(
      `/projects/${id}/okrs/reprioritize`,
      {
        method: "POST",
        body: JSON.stringify({
          orderedIds,
          expectedRevision,
          rationale: rationale || null,
        }),
      },
    ).then((result) => result.portfolio),
  upsertDepartment: (id: string, department: Partial<CodexCompanyDepartment> & { name: string; poolSize?: number; dailyBudgetUsd?: number | null }) =>
    req<{ departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/departments`,
      { method: "PUT", body: JSON.stringify({ department }) },
    ),
  deleteDepartment: (id: string, departmentId: string) =>
    req<{ departments: CodexCompanyDepartment[]; departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/departments/${encodeURIComponent(departmentId)}`,
      { method: "DELETE" },
    ),
  getDepartmentPools: (id: string) =>
    req<{ departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/department-pools`,
      { cache: "no-store" },
    ),
  updateDepartmentPool: (
    id: string,
    departmentId: string,
    pool: { size: number; dailyBudgetUsd?: number | null; enabled?: boolean },
  ) =>
    req<{ departmentPools: CodexDepartmentPool[]; capacity: CodexCompanyCapacity }>(
      `/projects/${id}/department-pools/${encodeURIComponent(departmentId)}`,
      { method: "PUT", body: JSON.stringify(pool) },
    ),
  getCompanyResources: (id: string) =>
    req<{ resources: CodexCompanyResourceState }>(
      `/projects/${id}/company-resources`,
      { cache: "no-store" },
    ).then((result) => result.resources),
  updateCompanyResources: (id: string, resources: CodexCompanyResourceState) =>
    req<{ resources: CodexCompanyResourceState }>(
      `/projects/${id}/company-resources`,
      {
        method: "PUT",
        body: JSON.stringify({
          ...resources,
          expectedRevision: resources.revision,
        }),
      },
    ).then((result) => result.resources),
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
  runBusinessAudit: (id: string) =>
    req<{ audit: CodexBusinessAudit; company: CodexCompanyContext }>(
      `/projects/${id}/business-audit`,
      { method: "POST", timeoutMs: 90_000 },
    ),
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
  triageCompanySocial: (id: string, maxResults = 20) =>
    req<{ result: {
      action: string
      items: CodexCompanyInboxItem[]
      actions: CodexExternalAction[]
      errors?: Array<{ platform: string; code: string; message: string }>
    } }>(
      `/projects/${id}/company-operations/triage-social`,
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
  approveCompanyAction: (
    id: string,
    actionId: string,
    approval: { actionHash: string; actionVersion: number },
  ) =>
    req<{ result: { action: string; record: CodexExternalAction | null } }>(
      `/projects/${id}/company-operations/actions/${actionId}/approve`,
      { method: "POST", body: JSON.stringify(approval) },
    ).then((result) => result.result),
  rejectCompanyAction: (id: string, actionId: string) =>
    req<{ result: { action: string } }>(
      `/projects/${id}/company-operations/actions/${actionId}/reject`,
      { method: "POST" },
    ).then((result) => result.result),
  listProjectActivity: (id: string, limit = 80) =>
    req<{ activity?: unknown }>(`/projects/${id}/activity?limit=${Math.max(1, Math.min(200, limit))}`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexProjectActivity>(r?.activity)),
  getMissionEvidence: (id: string) =>
    req<{ ledger: CodexMissionEvidenceLedger }>(
      `/projects/${id}/mission-evidence`,
      { cache: "no-store" },
    ).then((result) => result.ledger),
  reviewMissionEvidence: (
    id: string,
    recordId: string,
    status: CodexMissionReviewStatus,
    note?: string | null,
  ) =>
    req<{ record: CodexMissionEvidenceRecord }>(
      `/projects/${id}/mission-evidence/${encodeURIComponent(recordId)}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({ status, note: note || null }),
      },
    ).then((result) => result.record),
  createActivityReport: (
    id: string,
    options?: {
      days?: number
      requestEmail?: boolean
      confirmEmailQueue?: boolean
    },
  ) =>
    req<{ report: CodexActivityReport }>(
      `/projects/${id}/activity-reports`,
      {
        method: "POST",
        body: JSON.stringify({
          days: options?.days || 7,
          requestEmail: options?.requestEmail === true,
          confirmEmailQueue: options?.confirmEmailQueue === true,
        }),
      },
    ).then((result) => result.report),
  getCommandCenter: (id: string) =>
    req<{ commandCenter: CodexEnterpriseCommandCenter; company: CodexCompanyContext }>(
      `/projects/${id}/command-center`,
      { cache: "no-store" },
    ),
  startSwarm: (
    id: string,
    body: {
      objective: string
      logicalAgents?: number
      maxConcurrency?: number
      maxConcurrentWriters?: number
      model?: string
      tier?: string
    },
  ) =>
    req<{ swarm: CodexSwarmSummary; commandCenter: CodexEnterpriseCommandCenter }>(
      `/projects/${id}/swarms`,
      // Large logical fleets (up to 10k tasks) can take >60s to plan + persist.
      { method: "POST", body: JSON.stringify(body), timeoutMs: 180_000 },
    ),
  pauseSwarm: (projectId: string, swarmId: string) =>
    req<{ swarm: CodexSwarmSummary }>(
      `/projects/${projectId}/swarms/${swarmId}/pause`,
      { method: "POST" },
    ),
  resumeSwarm: (projectId: string, swarmId: string) =>
    req<{ swarm: CodexSwarmSummary }>(
      `/projects/${projectId}/swarms/${swarmId}/resume`,
      { method: "POST" },
    ),
  cancelSwarm: (projectId: string, swarmId: string, reason = "cancelled_by_user") =>
    req<{ swarm: CodexSwarmSummary }>(
      `/projects/${projectId}/swarms/${swarmId}/cancel`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),

  createRun: (projectId: string, body: { mode: "plan" | "build"; prompt?: string; model?: string; tier?: string; planRunId?: string; autoExecute?: boolean }) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.run),
  listRuns: (projectId: string) =>
    req<{ runs?: unknown }>(`/projects/${projectId}/runs`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexRun>(r?.runs)),
  getRun: (projectId: string, runId: string) => req<{ run: CodexRun }>(`/projects/${projectId}/runs/${runId}`).then((r) => r.run),
  cancelRun: (runId: string) => req<{ run: CodexRun }>(`/runs/${runId}/cancel`, { method: "POST" }).then((r) => r.run),
  generateRunSummaryAudio: (runId: string) =>
    req<{
      audio: {
        audioUrl: string
        mime: "audio/mpeg"
        sizeBytes: number
        characters: number
        voiceId: string | null
        modelId: string | null
      }
      cached: boolean
    }>(`/runs/${runId}/summary-audio`, { method: "POST", timeoutMs: 130_000 }),
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

  approvePlan: (projectId: string, planRunId: string, tier?: string, opts?: { autoExecute?: boolean }) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        mode: "build",
        planRunId,
        tier,
        ...(opts?.autoExecute ? { autoExecute: true } : {}),
      }),
    }).then((r) => r.run),
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
