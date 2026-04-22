"use client"

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

export interface Project {
  id: string
  name: string
  description: string | null
  instructions: string | null
  isStarred: boolean
  createdAt: string
  updatedAt: string
  fileCount?: number
  chatCount?: number
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

export interface CreateProjectInput {
  name: string
  description?: string
  instructions?: string
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
}

const baseUrl = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/projects`

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
  async list(filters: ProjectFilters = {}): Promise<Project[]> {
    const params = new URLSearchParams()
    if (filters.search) params.set("search", filters.search)
    if (filters.sort) params.set("sort", filters.sort)
    const qs = params.toString()
    const res = await fetch(`${baseUrl}${qs ? `?${qs}` : ""}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ projects: Project[] }>(res)
    return json.projects
  },

  async get(id: string): Promise<ProjectDetail> {
    const res = await fetch(`${baseUrl}/${id}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    const json = await handle<{ project: ProjectDetail }>(res)
    return json.project
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const res = await fetch(baseUrl, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    const json = await handle<{ project: Project }>(res)
    return json.project
  },

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    const res = await fetch(`${baseUrl}/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(input),
    })
    const json = await handle<{ project: Project }>(res)
    return json.project
  },

  async remove(id: string): Promise<void> {
    const res = await fetch(`${baseUrl}/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ deleted: boolean }>(res)
  },

  /** Start a new chat inside this project. Returns the created chat. */
  async startChat(id: string, opts: { title?: string; model?: string } = {}): Promise<{ id: string; title: string; projectId: string | null; model: string }> {
    const res = await fetch(`${baseUrl}/${id}/chat`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify(opts),
    })
    const json = await handle<{ chat: { id: string; title: string; projectId: string | null; model: string } }>(res)
    return json.chat
  },

  async attachFile(projectId: string, fileId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/${projectId}/files/${fileId}`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ attached: boolean }>(res)
  },

  async detachFile(projectId: string, fileId: string): Promise<void> {
    const res = await fetch(`${baseUrl}/${projectId}/files/${fileId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    })
    await handle<{ detached: boolean }>(res)
  },
}
