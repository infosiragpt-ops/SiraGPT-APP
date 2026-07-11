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
    try {
      const body = await res.json()
      message = body.error || body.message || message
    } catch {
      // response body wasn't JSON — use the status line
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
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
    const res = await authenticatedFetch(`${baseUrl}/${id}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ project: ProjectDetail }>(res)
    return json.project
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
}
