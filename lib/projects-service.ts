"use client"

import { authenticatedFetch } from "./authenticated-fetch"

/**
 * Frontend client for the /api/projects backend.
 *
 * Mirrors the style of lib/gpts-service.ts so the chat-app codebase
 * stays consistent: localStorage JWT, credentials:include, thin
 * wrappers over fetch. When the shared fetch abstraction in
 * lib/api-client.ts matures, this file is a natural candidate to
 * migrate — but for now parity with gpts-service keeps debugging
 * predictable.
 */

export type ProjectType = "general" | "webapp"
export type ProjectHostingProvider = "sira-cloud" | "github"

export interface Project {
  id: string
  organizationId?: string | null
  name: string
  description: string | null
  instructions: string | null
  type?: ProjectType
  hostingProvider?: ProjectHostingProvider
  isStarred: boolean
  shareId: string | null
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  deleteAfter?: string | null
  fileCount?: number
  chatCount?: number
}

export interface ProjectMemoryItem {
  id: string
  fact: string
  sourceChatId: string | null
  createdAt: string
}

export interface SharedProjectSnapshot {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
  files: Array<{ id: string; originalName: string; mimeType: string; size: number }>
}

export interface ProjectDetail extends Project {
  files: Array<{
    id: string
    filename: string
    originalName: string
    mimeType: string
    size: number
    createdAt: string
  }>
  chats: Array<{
    id: string
    title: string
    model: string
    createdAt: string
    updatedAt: string
  }>
}

export interface ProjectContextManifest {
  projectId: string | null
  name: string
  isolation: "project_scoped"
  hasInstructions: boolean
  counts: {
    files: number
    chats: number
    memories: number
    documents: number
  }
  fileTypes: Record<string, number>
  textCoverage: {
    extracted: number
    total: number
    percent: number
  }
  updatedAt: string | null
  status: {
    knowledgeReady: boolean
    instructionsReady: boolean
    conversationsReady: boolean
    memoryReady: boolean
  }
}

export interface ProjectChatSummary {
  id: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
  snippet: string
  snippetRole: "USER" | "ASSISTANT" | null
}

export interface CreateProjectInput {
  name: string
  organizationId?: string | null
  description?: string
  instructions?: string
  type?: ProjectType
  hostingProvider?: ProjectHostingProvider
}

export interface UpdateProjectInput {
  name?: string
  description?: string | null
  instructions?: string | null
  isStarred?: boolean
}

export type ProjectSort = "activity" | "edited" | "created"

export interface ProjectFilters {
  search?: string
  sort?: ProjectSort
  type?: ProjectType
  trash?: boolean
}

const apiRoot = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
const baseUrl = `${apiRoot}/projects`

export type ProjectErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "client"
  | "server"
  | "network"
  | "unknown"

export class ProjectServiceError extends Error {
  readonly status: number | undefined
  readonly kind: ProjectErrorKind
  readonly code: string | null

  constructor(
    message: string,
    options: { status?: number; kind?: ProjectErrorKind; code?: string | null; cause?: unknown } = {},
  ) {
    super(message)
    this.name = "ProjectServiceError"
    this.status = options.status
    this.kind = options.kind ?? classifyStatus(options.status)
    this.code = options.code ?? (options.status === 404 ? "project_not_found" : null)
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

function classifyStatus(status: number | undefined): ProjectErrorKind {
  if (typeof status !== "number") return "unknown"
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status >= 500) return "server"
  return "client"
}

export function projectsServiceErrorCode(error: unknown): string | null {
  if (error instanceof ProjectServiceError) {
    return error.code || (error.status === 404 ? "project_not_found" : null)
  }
  const candidate = error as { code?: unknown; status?: unknown } | null
  if (candidate?.status === 404) return "project_not_found"
  if (typeof candidate?.code === "string" && candidate.code.trim()) return candidate.code.trim()
  return null
}

/** /code editor FS snapshot stored on Project.codeWorkspace (not knowledge files). */
export interface ProjectCodeWorkspaceFile {
  content: string
  language?: string
  updatedAt?: number
}

export interface ProjectCodeWorkspaceSnapshot {
  v: number
  files: Record<string, ProjectCodeWorkspaceFile>
  openTabs?: string[]
  activePath?: string | null
  updatedAt?: string | null
}

export interface ProjectCodeWorkspaceResponse {
  projectId: string
  workspace: ProjectCodeWorkspaceSnapshot
  fileCount: number
  projectUpdatedAt: string
}

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    let code: string | null = null
    try {
      const body = await res.json()
      message = body.error || body.message || message
      const rawCode = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : null
      code = rawCode && /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : null
    } catch {
      // response body wasn't JSON — use the status line
    }
    throw new ProjectServiceError(message, {
      status: res.status,
      code: res.status === 404 ? "project_not_found" : code,
    })
  }
  return res.json() as Promise<T>
}

async function guardNetwork<T>(perform: () => Promise<T>): Promise<T> {
  try {
    return await perform()
  } catch (err) {
    if (err instanceof ProjectServiceError) throw err
    throw new ProjectServiceError(err instanceof Error ? err.message : "Network error", {
      kind: "network",
      cause: err,
    })
  }
}

export const projectsService = {
  async uploadFiles(files: Iterable<File>): Promise<Array<{ id: string }>> {
    const body = new FormData()
    for (const file of files) body.append("files", file)
    const res = await authenticatedFetch(`${apiRoot}/files/upload`, {
      method: "POST",
      body,
    })
    const json = await handle<{ files?: Array<{ id: string }> }>(res)
    return json.files || []
  },

  async list(filters: ProjectFilters = {}): Promise<Project[]> {
    const params = new URLSearchParams()
    if (filters.search) params.set("search", filters.search)
    if (filters.sort) params.set("sort", filters.sort)
    if (filters.type) params.set("type", filters.type)
    if (filters.trash) params.set("trash", "true")
    const qs = params.toString()
    const res = await authenticatedFetch(`${baseUrl}${qs ? `?${qs}` : ""}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ projects: Project[] }>(res)
    return json.projects
  },

  async get(id: string): Promise<ProjectDetail> {
    return guardNetwork(async () => {
      const res = await authenticatedFetch(`${baseUrl}/${id}`, {
        credentials: "include",
        headers: authHeaders(),
      })
      const json = await handle<{ project: ProjectDetail }>(res)
      return json.project
    })
  },

  async context(id: string): Promise<ProjectContextManifest> {
    const res = await authenticatedFetch(`${baseUrl}/${id}/context`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ context: ProjectContextManifest }>(res)
    return json.context
  },

  async listChats(id: string, opts: { search?: string; limit?: number } = {}): Promise<ProjectChatSummary[]> {
    const params = new URLSearchParams()
    if (opts.search) params.set("search", opts.search)
    if (opts.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    const res = await authenticatedFetch(`${baseUrl}/${id}/chats${qs ? `?${qs}` : ""}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ chats: ProjectChatSummary[] }>(res)
    return json.chats
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const res = await authenticatedFetch(baseUrl, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    const json = await handle<{ project: Project }>(res)
    return json.project
  },

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const res = await authenticatedFetch(`${baseUrl}/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    const json = await handle<{ project: Project }>(res)
    return json.project
  },

  async remove(id: string): Promise<void> {
    const res = await authenticatedFetch(`${baseUrl}/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ deleted: boolean }>(res)
  },

  async restore(id: string): Promise<Project> {
    const res = await authenticatedFetch(`${baseUrl}/${id}/restore`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ restored: boolean; project: Project }>(res)
    return json.project
  },

  /** Start a new chat inside this project. Returns the created chat. */
  async startChat(id: string, opts: { title?: string; model?: string } = {}): Promise<{ id: string; title: string; projectId: string | null; model: string }> {
    const res = await authenticatedFetch(`${baseUrl}/${id}/chat`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(opts),
    })
    const json = await handle<{ chat: { id: string; title: string; projectId: string | null; model: string } }>(res)
    return json.chat
  },

  async attachFile(projectId: string, fileId: string): Promise<void> {
    const res = await authenticatedFetch(`${baseUrl}/${projectId}/files/${fileId}`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ attached: boolean }>(res)
  },

  async detachFile(projectId: string, fileId: string): Promise<void> {
    const res = await authenticatedFetch(`${baseUrl}/${projectId}/files/${fileId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ detached: boolean }>(res)
  },

  async listMemory(projectId: string): Promise<ProjectMemoryItem[]> {
    const res = await authenticatedFetch(`${baseUrl}/${projectId}/memory`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ memories: ProjectMemoryItem[] }>(res)
    return json.memories
  },

  async deleteMemory(projectId: string, factId: string): Promise<void> {
    const res = await authenticatedFetch(`${baseUrl}/${projectId}/memory/${factId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ deleted: boolean }>(res)
  },

  async enableShare(projectId: string): Promise<{ shareId: string; url: string }> {
    const res = await authenticatedFetch(`${baseUrl}/${projectId}/share`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
    })
    return handle<{ shareId: string; url: string }>(res)
  },

  async revokeShare(projectId: string): Promise<void> {
    const res = await authenticatedFetch(`${baseUrl}/${projectId}/share`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ revoked: boolean }>(res)
  },

  async getShared(shareId: string): Promise<SharedProjectSnapshot> {
    // Public endpoint — no auth header needed.
    const res = await fetch(`${baseUrl}/share/${shareId}`)
    const json = await handle<{ project: SharedProjectSnapshot }>(res)
    return json.project
  },

  /** /code editor FS for a Project (not knowledge File attachments). */
  async getCodeWorkspace(projectId: string): Promise<ProjectCodeWorkspaceResponse> {
    return guardNetwork(async () => {
      const res = await authenticatedFetch(`${baseUrl}/${projectId}/code-workspace`, {
        credentials: "include",
        headers: authHeaders(),
      })
      return handle<ProjectCodeWorkspaceResponse>(res)
    })
  },

  async putCodeWorkspace(
    projectId: string,
    workspace: ProjectCodeWorkspaceSnapshot,
  ): Promise<ProjectCodeWorkspaceResponse> {
    return guardNetwork(async () => {
      const res = await authenticatedFetch(`${baseUrl}/${projectId}/code-workspace`, {
        method: "PUT",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ workspace }),
      })
      return handle<ProjectCodeWorkspaceResponse>(res)
    })
  },
}
