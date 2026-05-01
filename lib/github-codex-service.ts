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
  name: string
  displayTitle: string
  status: string | null
  conclusion: string | null
  event: string | null
  htmlUrl: string
  runNumber: number
  branch: string | null
  headSha: string | null
  actor: string | null
  createdAt: string | null
  updatedAt: string | null
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
}
