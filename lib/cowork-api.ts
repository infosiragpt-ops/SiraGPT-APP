"use client"

import { getNormalizedApiBaseUrl } from "@/lib/api-base-url"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

const API_BASE = getNormalizedApiBaseUrl()

export type CoworkChecklistItem = {
  id?: string
  text: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  note?: string | null
}

export type CoworkWorkspace = {
  id: string
  name: string
  chatId?: string | null
  createdAt: string
  updatedAt: string
}

export type CoworkFile = {
  id: string
  path: string
  mime: string
  encoding?: "utf8" | "base64"
  size: number
  currentVersion: number
  contentHash?: string
  updatedBy?: string
  updatedAt: string
  versions?: Array<{
    id: string
    version: number
    size: number
    contentHash: string
    createdAt: string
    updatedBy?: string
    authorRunId?: string | null
  }>
}

export type CoworkFileContent = CoworkFile & {
  content: string
  version: number
}

export type CoworkRun = {
  id: string
  workspaceId: string
  chatId?: string | null
  parentRunId?: string | null
  prompt: string
  kind: string
  status: string
  checklist: CoworkChecklistItem[]
  currentStep: number
  maxSteps: number
  maxCostUsd?: number | string | null
  costUsd?: number | string | null
  tokensEstimate?: number | null
  lastEvent?: string | null
  pauseRequested?: boolean
  cancelRequested?: boolean
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type CoworkApproval = {
  id: string
  runId?: string | null
  chatId?: string | null
  tool: string
  humanDescription?: string | null
  args?: unknown
  status: string
  expiresAt: string
  createdAt: string
}

export type ScheduledCoworkTask = {
  id: string
  workspaceId?: string | null
  prompt: string
  cronExpr: string
  tz: string
  deliver: "chat" | "email" | "telegram"
  enabled: boolean
  maxSteps: number
  maxCostUsd?: number | string | null
  nextRunAt?: string | null
  lastRunAt?: string | null
  lastStatus?: string | null
  lastError?: string | null
  createdAt: string
}

export type CoworkConnector = {
  id: string
  name: string
  category: string
  authType: string
  capabilities: string[]
  connectUrl: string
  writeTier: string
  account?: {
    id: string
    accountLabel?: string | null
    status: string
    scopes?: string[]
    updatedAt: string
  } | null
}

export type CoworkAuditLog = {
  id: string
  action: string
  targetType?: string | null
  targetId?: string | null
  inputSummary?: string | null
  resultSummary?: string | null
  createdAt: string
}

export type CoworkCostSummary = {
  totalCostUsd: number | string
  tokensEstimate: number
  runCount: number
  rows: Array<{
    day: string
    costUsd: number | string
    tokensEstimate: number
    runCount: number
  }>
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const response = await authenticatedFetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.message || payload?.error || `HTTP ${response.status}`
    const error = new Error(message)
    ;(error as Error & { status?: number; code?: string }).status = response.status
    ;(error as Error & { status?: number; code?: string }).code = payload?.error
    throw error
  }
  return payload as T
}

async function download(path: string, fallbackName: string): Promise<void> {
  const response = await authenticatedFetch(`${API_BASE}${path}`, {
    credentials: "include",
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
  }
  const blob = await response.blob()
  const disposition = response.headers.get("content-disposition") || ""
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  const filename = decodeURIComponent(utf8Name || plainName || fallbackName)
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export const coworkApi = {
  ensureWorkspace(chatId: string) {
    return requestJson<{ workspace: CoworkWorkspace }>(`/cowork/chats/${encodeURIComponent(chatId)}/workspace`, {
      method: "POST",
      body: "{}",
    })
  },

  getWorkspace(workspaceId: string) {
    return requestJson<{
      workspace: CoworkWorkspace
      files: CoworkFile[]
      recentRuns: CoworkRun[]
    }>(`/cowork/workspaces/${encodeURIComponent(workspaceId)}`)
  },

  readFile(workspaceId: string, path: string, version?: number) {
    const params = new URLSearchParams({ path })
    if (version) params.set("version", String(version))
    return requestJson<{ file: CoworkFileContent }>(
      `/cowork/workspaces/${encodeURIComponent(workspaceId)}/file?${params}`,
    )
  },

  diffFile(workspaceId: string, path: string, from: number, to?: number) {
    const params = new URLSearchParams({ path, from: String(from) })
    if (to) params.set("to", String(to))
    return requestJson<{ path: string; fromVersion: number; toVersion: number; diff: string }>(
      `/cowork/workspaces/${encodeURIComponent(workspaceId)}/file/diff?${params}`,
    )
  },

  downloadFile(workspaceId: string, path: string, version?: number) {
    const params = new URLSearchParams({ path })
    if (version) params.set("version", String(version))
    return download(
      `/cowork/workspaces/${encodeURIComponent(workspaceId)}/file/download?${params}`,
      path.split("/").pop() || "archivo",
    )
  },

  exportWorkspace(workspaceId: string, name: string) {
    return download(
      `/cowork/workspaces/${encodeURIComponent(workspaceId)}/export`,
      `${name || "workspace"}.zip`,
    )
  },

  listRuns(workspaceId: string) {
    const params = new URLSearchParams({ workspaceId, limit: "100" })
    return requestJson<{ runs: CoworkRun[] }>(`/cowork/runs?${params}`)
  },

  controlRun(runId: string, action: "pause" | "resume" | "cancel") {
    return requestJson<{ run: CoworkRun }>(`/cowork/runs/${encodeURIComponent(runId)}/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    })
  },

  steerRun(runId: string, note: string) {
    return requestJson<{ accepted: boolean; steering: { id: string; runId: string; status: string } }>(
      "/ai/steer",
      {
        method: "POST",
        body: JSON.stringify({ runId, note }),
      },
    )
  },

  listApprovals() {
    return requestJson<{ approvals: CoworkApproval[] }>("/cowork/approvals?limit=100")
  },

  decideApproval(approvalId: string, decision: "allow" | "deny") {
    return requestJson<{ ok: boolean }>(
      `/cowork/approvals/${encodeURIComponent(approvalId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ decision }),
      },
    )
  },

  listScheduledTasks(workspaceId: string) {
    const params = new URLSearchParams({ workspaceId })
    return requestJson<{ tasks: ScheduledCoworkTask[] }>(`/cowork/scheduled-tasks?${params}`)
  },

  createScheduledTask(input: {
    workspaceId: string
    prompt: string
    cronExpr: string
    tz: string
    deliver: "chat" | "email" | "telegram"
    maxSteps: number
    maxCostUsd: number
  }) {
    return requestJson<{ task: ScheduledCoworkTask }>("/cowork/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  updateScheduledTask(taskId: string, patch: Partial<ScheduledCoworkTask>) {
    return requestJson<{ task: ScheduledCoworkTask }>(
      `/cowork/scheduled-tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    )
  },

  deleteScheduledTask(taskId: string) {
    return requestJson<{ deleted: boolean }>(
      `/cowork/scheduled-tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE" },
    )
  },

  listConnectors() {
    return requestJson<{ connectors: CoworkConnector[] }>("/cowork/connectors")
  },

  async beginConnectorConnection(connectUrl: string) {
    if (!connectUrl.startsWith("/api/")) {
      window.location.assign(connectUrl)
      return { popup: false }
    }
    const popup = window.open(
      "about:blank",
      "siragpt-cowork-oauth",
      "width=540,height=720,menubar=no,toolbar=no,location=no,status=no",
    )
    if (!popup) throw new Error("El navegador bloqueó la ventana de conexión")
    try {
      const response = await authenticatedFetch(connectUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload?.authUrl) {
        throw new Error(payload?.message || payload?.error || "No se pudo iniciar la conexión")
      }
      popup.location.href = payload.authUrl
      popup.focus()
      return { popup: true }
    } catch (error) {
      popup.close()
      throw error
    }
  },

  disconnectConnector(provider: string) {
    return requestJson<{ disconnected: boolean }>(
      `/cowork/connectors/${encodeURIComponent(provider)}`,
      { method: "DELETE" },
    )
  },

  listAudit(workspaceId: string) {
    const params = new URLSearchParams({ workspaceId, limit: "150" })
    return requestJson<{ logs: CoworkAuditLog[] }>(`/cowork/audit?${params}`)
  },

  getCosts(workspaceId: string) {
    const params = new URLSearchParams({ workspaceId, days: "30" })
    return requestJson<CoworkCostSummary>(`/cowork/costs?${params}`)
  },
}


/** OLA200_WAVE_G FE-098 — cowork progress SSE resumes with Last-Event-ID. */
export function coworkProgressResumeHeaders(lastEventId?: string | null): Record<string, string> {
  const id = String(lastEventId || "").trim()
  if (!id) return {}
  return { "Last-Event-ID": id, "X-Last-Event-Id": id }
}
export function coworkProgressResumeUrl(baseUrl: string, lastEventId?: string | null): string {
  const id = String(lastEventId || "").trim()
  if (!id) return baseUrl
  const join = baseUrl.includes("?") ? "&" : "?"
  return `${baseUrl}${join}lastEventId=${encodeURIComponent(id)}`
}


/** 3H-FE-008 — analyze-stream Last-Event-ID (progress helper already shipped FE-098). */
export function coworkAnalyzeStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return coworkProgressResumeHeaders(lastEventId)
}


/** 3H2-FE-005 leftover: analyze-pro/stream Last-Event-ID (progress+analyze already shipped). */
export function coworkAnalyzeProStreamResumeHeaders(lastEventId?: string | null): Record<string, string> {
  return coworkProgressResumeHeaders(lastEventId)
}


/** 3H3-FE-006 leftover: control/steer mutations never cached. */
export function coworkControlHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" }
}
