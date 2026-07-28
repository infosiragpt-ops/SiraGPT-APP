import { authenticatedFetch } from "./authenticated-fetch"
import { getNormalizedApiBaseUrl } from "./api-base-url"

export type CompanySocialPlatform = "facebook" | "linkedin" | "x"

export type CompanySocialConnection = {
  id: string
  platform: CompanySocialPlatform
  accountId: string | null
  accountName: string | null
  profile: {
    status?: string
    avatarUrl?: string | null
    kind?: string
  }
  scopes: string[]
  expiresAt: string | null
  updatedAt: string
  connected: boolean
}

export type CompanySocialProvider = {
  platform: CompanySocialPlatform
  label: string
  configured: boolean
  scopes: string[]
  supports: {
    text: boolean
    remoteImage: boolean
    generatedImage: boolean
  }
  connection: CompanySocialConnection | null
}

export type CompanySocialPolicy = {
  enabled: boolean
  mode: "review" | "auto"
  autopilot: boolean
  objective: string
  dailyLimit: number
  platforms: Record<CompanySocialPlatform, boolean>
  workspaceId: string | null
  updatedAt: string | null
}

export type CompanySocialOperations = {
  policy: CompanySocialPolicy
  providers: CompanySocialProvider[]
  metrics: {
    queued: number
    publishedToday: number
  }
}

export type CompanySocialPost = {
  id: string
  caption: string | null
  prompt: string
  platforms: CompanySocialPlatform[]
  status: "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled"
  scheduledAt: string
  publishedAt: string | null
  lastError: string | null
  createdAt: string
}

export type CompanySocialPublishResult = {
  action: string
  postId?: string
  published?: number
  failed?: number
  post?: CompanySocialPost
}

export type CompanySocialLegacySummary = {
  total: number
  assignable: number
  skipped: number
  skippedByReason: Record<string, number>
  deniedPlatforms: string[]
}

export type CompanySocialLegacyAssignment = {
  workspaceId: string
  total: number
  assigned: number
  skipped: number
  skippedByReason: Record<string, number>
  deniedPlatforms: string[]
}

const BASE = `${getNormalizedApiBaseUrl()}/social-posts`

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(`${BASE}${path}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  })
  const body = response.status === 204
    ? null
    : await response.json().catch(() => ({}))
  if (!response.ok) {
    const errorBody = body as { error?: string; code?: string } | null
    throw Object.assign(
      new Error(errorBody?.error || `Social operations HTTP ${response.status}`),
      { status: response.status, code: errorBody?.code, body },
    )
  }
  return body as T
}

export const companySocialApi = {
  operations: (workspaceId?: string | null) =>
    request<CompanySocialOperations>(
      `/operations${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
      { cache: "no-store" },
    ),
  listPosts: (workspaceId?: string | null) =>
    request<{ posts: CompanySocialPost[] }>(
      `/${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
      { cache: "no-store" },
    )
    .then((result) => result.posts),
  legacySummary: (workspaceId: string) =>
    request<{ workspaceId: string; legacy: CompanySocialLegacySummary }>(
      `/legacy?workspaceId=${encodeURIComponent(workspaceId)}`,
      { cache: "no-store" },
    ).then((result) => result.legacy),
  assignLegacyPosts: (workspaceId: string) =>
    request<CompanySocialLegacyAssignment>("/legacy/assign", {
      method: "POST",
      body: JSON.stringify({ workspaceId, confirm: true }),
    }),
  connectUrl: (platform: CompanySocialPlatform) =>
    request<{ platform: CompanySocialPlatform; url: string }>(`/connect/${platform}`),
  disconnect: (platform: CompanySocialPlatform) =>
    request<null>(`/connections/${platform}`, { method: "DELETE" }),
  updatePolicy: (
    policy: Partial<CompanySocialPolicy> & { confirmAutopublish?: boolean },
  ) => request<{ policy: CompanySocialPolicy }>("/operations/policy", {
    method: "PATCH",
    body: JSON.stringify(policy),
  }).then((result) => result.policy),
  queueTextPost: (input: {
    caption: string
    platforms: CompanySocialPlatform[]
    scheduledAt?: string
    workspaceId: string
  }) => request<{ post: CompanySocialPost }>("/queue", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      prompt: input.caption,
      approved: true,
    }),
  }).then((result) => result.post),
  publishNow: (postId: string) =>
    request<{ result: CompanySocialPublishResult }>(
      `/${encodeURIComponent(postId)}/publish-now`,
      { method: "POST" },
    ),
}
