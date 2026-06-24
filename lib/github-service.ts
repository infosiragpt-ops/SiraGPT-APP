"use client"

/**
 * Frontend client for the /api/github backend (Replit-style workspace).
 *
 * Covers the whole flow:
 *   connect / status / disconnect            (OAuth)
 *   repos / search / connect repo / connected (discovery)
 *   clone / workspace                         (checkout on the server)
 *   files / file / folder / rename            (editor reads/writes the real clone)
 *   status / changes / diff / add / commit /
 *     push / pull / branches / commits        (git operations)
 *
 * Mirrors lib/projects-service.ts: localStorage "auth-token" Bearer,
 * credentials:include, thin fetch wrappers.
 */

const baseUrl = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/github`

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
    let code: string | undefined
    try {
      const body = await res.json()
      message = body.error || body.message || message
      code = body.code
    } catch {
      /* non-JSON body — use status line */
    }
    const err = new Error(message) as Error & { status?: number; code?: string }
    err.status = res.status
    err.code = code
    throw err
  }
  return res.json() as Promise<T>
}

function get<T>(path: string): Promise<T> {
  return fetch(`${baseUrl}${path}`, { credentials: "include", headers: authHeaders() }).then(handle<T>)
}
function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return fetch(`${baseUrl}${path}`, {
    method,
    credentials: "include",
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handle<T>)
}

// ── Types ─────────────────────────────────────────────────────────

export interface GithubStatus {
  connected: boolean
  configured: boolean
  login?: string
  name?: string | null
  avatarUrl?: string | null
  scopes?: string[]
  connectedAt?: string
}

export interface GithubRepo {
  repoId: string
  fullName: string
  owner: string
  name: string
  private: boolean
  defaultBranch: string
  cloneUrl: string
  htmlUrl?: string
  description?: string | null
  stars?: number
  language?: string | null
  updatedAt?: string
}

export interface ConnectedRepository {
  id: string
  repoId: string
  fullName: string
  owner: string
  name: string
  private: boolean
  defaultBranch: string
  cloneUrl: string
  htmlUrl?: string | null
  connectedAt: string
  workspace?: WorkspaceState | null
}

export interface WorkspaceState {
  id: string
  repositoryId: string
  localPath: string
  currentBranch: string | null
  status: "pending" | "cloning" | "ready" | "error"
  lastError: string | null
  lastSyncAt: string | null
}

export interface FileNode {
  name: string
  path: string
  type: "file" | "dir"
  size?: number
  children?: FileNode[]
}

export interface FileContent {
  path: string
  content?: string
  binary?: boolean
  tooLarge?: boolean
  size?: number
  maxBytes?: number
}

export interface GitStatus {
  current: string
  tracking: string | null
  ahead: number
  behind: number
  detached: boolean
  clean: boolean
  staged: string[]
  files: Array<{ path: string; index: string; workingDir: string }>
}

export interface GitChanges {
  new: string[]
  modified: string[]
  deleted: string[]
  renamed: Array<{ from: string; to: string }> | string[]
  conflicted: string[]
  staged: string[]
  total: number
}

export interface GitBranches {
  current: string
  local: string[]
  remote: string[]
}

export interface RunStatus {
  running: boolean
  status: "idle" | "starting" | "ready" | "error" | "stopped"
  ready?: boolean
  port?: number
  previewUrl?: string
  framework?: string
  kind?: "node" | "static" | "none"
  error?: string | null
  tail?: string[]
  uptimeMs?: number
}

export interface GitCommit {
  hash: string
  date: string
  message: string
  authorName: string
  authorEmail: string
  refs: string
}

// ── Service ───────────────────────────────────────────────────────

export const githubService = {
  // OAuth
  status: () => get<GithubStatus>("/status"),
  connectUrl: () => get<{ url: string }>("/connect"),
  disconnect: () => send<{ ok: boolean }>("POST", "/disconnect"),

  // Discovery
  listRepos: (opts: { page?: number; perPage?: number; sort?: string } = {}) => {
    const p = new URLSearchParams()
    if (opts.page) p.set("page", String(opts.page))
    if (opts.perPage) p.set("per_page", String(opts.perPage))
    if (opts.sort) p.set("sort", opts.sort)
    return get<{ repos: GithubRepo[]; page: number; count: number }>(`/repos?${p.toString()}`)
  },
  searchRepos: (q: string, opts: { page?: number; perPage?: number } = {}) => {
    const p = new URLSearchParams({ q })
    if (opts.page) p.set("page", String(opts.page))
    if (opts.perPage) p.set("per_page", String(opts.perPage))
    return get<{ items: GithubRepo[]; total: number; incompleteResults: boolean }>(`/repos/search?${p.toString()}`)
  },
  connectRepo: (owner: string, repo: string) =>
    send<{ ok: boolean; connection: ConnectedRepository }>("POST", "/repos/connect", { owner, repo }),
  createRepo: (input: { name: string; description?: string; private?: boolean }) =>
    send<{ ok: boolean; connection: ConnectedRepository; repo: GithubRepo }>("POST", "/repos/create", input),
  listConnected: () => get<{ connections: ConnectedRepository[]; count: number }>("/connected"),
  removeConnection: (id: string) => send<{ ok: boolean }>("DELETE", `/connected/${id}`),

  // Clone / workspace
  clone: (id: string, branch?: string) =>
    send<{ ok: boolean; alreadyCloned: boolean; workspace: WorkspaceState }>(
      "POST",
      `/connected/${id}/clone`,
      branch ? { branch } : {},
    ),
  workspace: (id: string) => get<{ workspace: WorkspaceState | null }>(`/connected/${id}/workspace`),
  removeWorkspace: (id: string) => send<{ ok: boolean }>("DELETE", `/connected/${id}/workspace`),

  // Download the whole workspace as a .zip to the user's machine. Uses a
  // fetch+blob flow (not a plain <a href>) so the Bearer auth header rides along.
  downloadZip: async (id: string, fileName = "workspace.zip") => {
    const res = await fetch(`${baseUrl}/connected/${id}/download`, {
      credentials: "include",
      headers: authHeaders(),
    })
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        message = (await res.json()).error || message
      } catch {
        /* binary/non-json */
      }
      throw new Error(message)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },

  // Run / live preview
  run: (id: string) => send<RunStatus & { ok: boolean }>("POST", `/connected/${id}/run`),
  stop: (id: string) => send<{ ok: boolean; stopped: boolean }>("POST", `/connected/${id}/stop`),
  runStatus: (id: string) => get<RunStatus>(`/connected/${id}/run/status`),

  // Files
  files: (id: string) => get<{ tree: FileNode[]; truncated: boolean; count: number }>(`/connected/${id}/files`),
  filesWithContent: (id: string) =>
    get<{ files: Array<{ path: string; content: string }>; truncated: boolean }>(`/connected/${id}/files/contents`),
  readFile: (id: string, path: string) =>
    get<FileContent>(`/connected/${id}/file?path=${encodeURIComponent(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    send<{ ok: boolean; path: string; size: number }>("PUT", `/connected/${id}/file`, { path, content }),
  createFolder: (id: string, path: string) =>
    send<{ ok: boolean; path: string }>("POST", `/connected/${id}/folder`, { path }),
  rename: (id: string, from: string, to: string) =>
    send<{ ok: boolean; from: string; to: string }>("POST", `/connected/${id}/rename`, { from, to }),
  deleteFile: (id: string, path: string) =>
    send<{ ok: boolean; deleted: boolean }>("DELETE", `/connected/${id}/file?path=${encodeURIComponent(path)}`),

  // Git
  gitStatus: (id: string) => get<{ status: GitStatus }>(`/connected/${id}/status`),
  changes: (id: string) => get<{ changes: GitChanges }>(`/connected/${id}/changes`),
  diff: (id: string, file?: string, staged?: boolean) => {
    const p = new URLSearchParams()
    if (file) p.set("file", file)
    if (staged) p.set("staged", "1")
    return get<{ patch: string; summary: unknown }>(`/connected/${id}/diff?${p.toString()}`)
  },
  stage: (id: string, files: string[]) => send<{ ok: boolean }>("POST", `/connected/${id}/add`, { files }),
  discard: (id: string, files?: string[]) =>
    send<{ ok: boolean; discarded: string | string[] }>("POST", `/connected/${id}/discard`, files ? { files } : {}),
  commit: (id: string, message: string) =>
    send<{ ok: boolean; commit: string; branch: string }>("POST", `/connected/${id}/commit`, { message }),
  push: (id: string, opts: { branch?: string; setUpstream?: boolean } = {}) =>
    send<{ ok: boolean; pushed: unknown; branch: string | null }>("POST", `/connected/${id}/push`, opts),
  pull: (id: string, branch?: string) =>
    send<{ ok: boolean }>("POST", `/connected/${id}/pull`, branch ? { branch } : {}),
  sync: (id: string) =>
    send<{ ok: boolean; pulled: boolean; pushed: boolean; status: GitStatus }>("POST", `/connected/${id}/sync`),
  fetch: (id: string, branch?: string) =>
    send<{ ok: boolean }>("POST", `/connected/${id}/fetch`, branch ? { branch } : {}),
  branches: (id: string) => get<{ branches: GitBranches }>(`/connected/${id}/branches`),
  createBranch: (id: string, name: string, checkout = true) =>
    send<{ ok: boolean; created: string; checkedOut: boolean }>("POST", `/connected/${id}/branches`, {
      name,
      checkout,
    }),
  switchBranch: (id: string, name: string) =>
    send<{ ok: boolean; current: string }>("PUT", `/connected/${id}/branches/switch`, { name }),
  deleteBranch: (id: string, name: string, force = false) =>
    send<{ ok: boolean }>("DELETE", `/connected/${id}/branches/${encodeURIComponent(name)}${force ? "?force=1" : ""}`),
  commits: (id: string, limit = 30, branch?: string) => {
    const p = new URLSearchParams({ limit: String(limit) })
    if (branch) p.set("branch", branch)
    return get<{ commits: GitCommit[]; count: number }>(`/connected/${id}/commits?${p.toString()}`)
  },
}
