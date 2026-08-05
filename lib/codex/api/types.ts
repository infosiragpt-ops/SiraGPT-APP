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
  reasoningEffort?: string | null
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
