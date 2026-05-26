"use client"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface GitHubCodexStatus {
  provider: "github"
  package: "octokit"
  configured: boolean
  mode: "server_token" | "public_read_only"
  tokenSource: string | null
  tokenPlacement: string
  recommendedScopes: string[]
  actionsIntelligence?: {
    enabled: boolean
    readOnly: boolean
    runLimit: { default: number; max: number }
    logAnalysis: {
      maxBytes: number
      failedJobLimit: number
      sanitization: string[]
    }
  }
}

export interface GitHubCodexRepository {
  id: number
  name: string
  fullName: string
  owner: string | null
  private: boolean
  visibility: string
  htmlUrl: string
  description: string
  defaultBranch: string
  language: string
  stargazersCount: number
  forksCount: number
  openIssuesCount: number
  archived: boolean
  disabled: boolean
  pushedAt: string | null
  updatedAt: string | null
}

export interface GitHubCodexPullRequest {
  number: number
  title: string
  state: string
  draft: boolean
  htmlUrl: string
  author: string | null
  base: string | null
  head: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface GitHubCodexIssue {
  number: number
  title: string
  state: string
  htmlUrl: string
  author: string | null
  labels: string[]
  createdAt: string | null
  updatedAt: string | null
}

export interface GitHubCodexWorkflowRun {
  id: number
  workflowId?: number | null
  name: string
  displayTitle: string
  status: string | null
  conclusion: string | null
  event: string | null
  htmlUrl: string
  runNumber: number
  runAttempt?: number | null
  branch: string | null
  headSha: string | null
  headShaFull?: string | null
  actor: string | null
  createdAt: string | null
  updatedAt: string | null
  durationMs?: number | null
  headCommit?: {
    id: string | null
    message: string
    timestamp: string | null
    author: string | null
  } | null
}

export interface GitHubCodexWorkflowStep {
  name: string
  number: number
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
}

export interface GitHubCodexWorkflowJob {
  id: number
  runId: number | null
  name: string
  status: string | null
  conclusion: string | null
  htmlUrl: string | null
  runnerName: string | null
  runnerGroupName: string | null
  labels: string[]
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  steps: GitHubCodexWorkflowStep[]
}

export interface GitHubCodexReadme {
  name: string
  path: string
  htmlUrl: string
  sha: string
  bytes: number
  preview: string
  truncated: boolean
}

export interface GitHubCodexWarning {
  area: string
  code: string
  status: number
  message: string
}

export interface GitHubCodexContext {
  repository: GitHubCodexRepository
  branch: string
  auth: {
    mode: "server_token" | "public_read_only"
    configured: boolean
    tokenSource: string | null
  }
  pullRequests: GitHubCodexPullRequest[]
  issues: GitHubCodexIssue[]
  workflowRuns: GitHubCodexWorkflowRun[]
  readme: GitHubCodexReadme | null
  codexSummary: {
    health: "ready" | "partial" | "needs_attention"
    latestWorkflowConclusion: string | null
    signals: string[]
    nextActions: string[]
  }
  warnings: GitHubCodexWarning[]
  limits: {
    recentItems: number
    readmePreviewChars: number
  }
  rateLimit: {
    limit: string | null
    remaining: string | null
    reset: string | null
    used: string | null
  }
}

export interface GitHubCodexRepositoryFile {
  path: string
  language: string
  bytes: number
  sha: string | null
  htmlUrl: string
  content?: string
}

export interface GitHubCodexFileSet {
  repository: GitHubCodexRepository
  branch: string
  auth: {
    mode: "server_token" | "public_read_only"
    configured: boolean
    tokenSource: string | null
  }
  files: GitHubCodexRepositoryFile[]
  collection: string
  skipped: {
    notFile: number
    skippedDirectory: number
    gitignored: number
    unsupportedExtension: number
    oversized: number
    fetchFailed: number
  }
  filtering?: {
    gitignore?: {
      applied: boolean
      source: {
        path: string
        sha: string | null
        bytes: number
        htmlUrl: string | null
      } | null
    }
  }
  limits: {
    fileLimit: number
    maxFileBytes: number
    candidates: number
    selected: number
    treeTruncated: boolean
  }
}

export interface GitHubCodexActionsSummary {
  health: "green" | "red" | "running" | "unknown" | "empty"
  latestConclusion: string | null
  latestRunId: number | null
  failingRuns: number
  inProgressRuns: number
  totalRuns: number
}

export interface GitHubCodexActionRunsResult {
  repository: GitHubCodexRepository
  branch: string
  auth: GitHubCodexContext["auth"]
  runs: GitHubCodexWorkflowRun[]
  summary: GitHubCodexActionsSummary
  limits: { runLimit: number }
  rateLimit: GitHubCodexContext["rateLimit"]
}

export interface GitHubCodexActionJobsResult {
  repository: GitHubCodexRepository
  branch: string
  auth: GitHubCodexContext["auth"]
  run: GitHubCodexWorkflowRun
  jobs: GitHubCodexWorkflowJob[]
  summary: {
    totalJobs: number
    failedJobs: number
    completedJobs: number
  }
  rateLimit: GitHubCodexContext["rateLimit"]
}

export interface GitHubCodexActionFailureAnalysisResult {
  repository: GitHubCodexRepository
  branch: string
  auth: GitHubCodexContext["auth"]
  run: GitHubCodexWorkflowRun
  jobs: GitHubCodexWorkflowJob[]
  analysis: {
    health: "green" | "red" | "running" | "unknown"
    runId: number
    runName: string
    conclusion: string | null
    status: string | null
    failedJobs: Array<{
      id: number
      name: string
      conclusion: string | null
      htmlUrl: string | null
      failedSteps: string[]
    }>
    rootCauseCandidates: string[]
    nextActions: string[]
    warnings: GitHubCodexWarning[]
  }
  logs: {
    included: boolean
    maxBytes: number
    failedJobLimit: number
    excerpts: Array<{
      jobId: number
      jobName: string
      excerpt: string
      truncated: boolean
      originalBytes: number
      sanitizedBytes: number
    }>
  }
  rateLimit: GitHubCodexContext["rateLimit"]
}

export interface GitHubCodexRagIngestResult {
  ok: true
  collection: string
  repository: GitHubCodexRepository
  branch: string
  filesIndexed: number
  bytesIndexed: number
  chunksAdded: number
  totalChunks: number
  skipped: GitHubCodexFileSet["skipped"]
  limits: GitHubCodexFileSet["limits"]
}

export interface GitHubCodexRagHit {
  text: string
  source: string | null
  title: string | null
  score: number
  retrievalMode?: string
}

export interface GitHubCodexRagSearchResult {
  ok: true
  collection: string
  query: string
  hits: GitHubCodexRagHit[]
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function handle<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return data as T
}

export const githubCodexService = {
  async status(): Promise<GitHubCodexStatus> {
    const res = await fetch(`${API_ROOT}/codex/github/status`, {
      credentials: "include",
      headers: authHeader(),
    })
    const json = await handle<{ github: GitHubCodexStatus }>(res)
    return json.github
  },

  async inspectRepository(input: { repo: string; branch?: string; limit?: number }): Promise<GitHubCodexContext> {
    const qs = new URLSearchParams()
    qs.set("repo", input.repo)
    if (input.branch?.trim()) qs.set("branch", input.branch.trim())
    if (input.limit) qs.set("limit", String(input.limit))
    const res = await fetch(`${API_ROOT}/codex/github/repo?${qs.toString()}`, {
      credentials: "include",
      headers: authHeader(),
    })
    const json = await handle<{ context: GitHubCodexContext }>(res)
    return json.context
  },

  async listRepositoryFiles(input: { repo: string; branch?: string; limit?: number; maxBytes?: number }): Promise<GitHubCodexFileSet> {
    const qs = new URLSearchParams()
    qs.set("repo", input.repo)
    if (input.branch?.trim()) qs.set("branch", input.branch.trim())
    if (input.limit) qs.set("limit", String(input.limit))
    if (input.maxBytes) qs.set("maxBytes", String(input.maxBytes))
    const res = await fetch(`${API_ROOT}/codex/github/files?${qs.toString()}`, {
      credentials: "include",
      headers: authHeader(),
    })
    const json = await handle<{ fileSet: GitHubCodexFileSet }>(res)
    return json.fileSet
  },

  async listActionRuns(input: {
    repo: string
    branch?: string
    limit?: number
    status?: string
    event?: string
  }): Promise<GitHubCodexActionRunsResult> {
    const qs = new URLSearchParams()
    qs.set("repo", input.repo)
    if (input.branch?.trim()) qs.set("branch", input.branch.trim())
    if (input.limit) qs.set("limit", String(input.limit))
    if (input.status?.trim()) qs.set("status", input.status.trim())
    if (input.event?.trim()) qs.set("event", input.event.trim())
    const res = await fetch(`${API_ROOT}/codex/github/actions/runs?${qs.toString()}`, {
      credentials: "include",
      headers: authHeader(),
    })
    return handle<GitHubCodexActionRunsResult>(res)
  },

  async listActionJobs(input: { repo: string; runId: number }): Promise<GitHubCodexActionJobsResult> {
    const qs = new URLSearchParams()
    qs.set("repo", input.repo)
    const res = await fetch(`${API_ROOT}/codex/github/actions/runs/${input.runId}/jobs?${qs.toString()}`, {
      credentials: "include",
      headers: authHeader(),
    })
    return handle<GitHubCodexActionJobsResult>(res)
  },

  async analyzeActionFailure(input: {
    repo: string
    runId: number
    includeLogs?: boolean
    maxLogBytes?: number
  }): Promise<GitHubCodexActionFailureAnalysisResult> {
    const res = await fetch(`${API_ROOT}/codex/github/actions/analyze-failure`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
      },
      body: JSON.stringify(input),
    })
    return handle<GitHubCodexActionFailureAnalysisResult>(res)
  },

  async ingestRepository(input: {
    repo: string
    branch?: string
    collection?: string
    limit?: number
    maxBytes?: number
  }): Promise<GitHubCodexRagIngestResult> {
    const res = await fetch(`${API_ROOT}/codex/github/ingest`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
      },
      body: JSON.stringify(input),
    })
    return handle<GitHubCodexRagIngestResult>(res)
  },

  async searchRepositoryContext(input: {
    query: string
    repo?: string
    branch?: string
    collection?: string
    k?: number
  }): Promise<GitHubCodexRagSearchResult> {
    const res = await fetch(`${API_ROOT}/codex/github/retrieve`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
      },
      body: JSON.stringify(input),
    })
    return handle<GitHubCodexRagSearchResult>(res)
  },
}
