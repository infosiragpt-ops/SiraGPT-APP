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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // A hung backend must never freeze the composer's busy latch: every JSON
  // call gets a hard timeout (SSE streaming goes through run-stream.ts, not
  // req(), so this is safe globally). Placed AFTER the init spread so a
  // caller-provided signal still wins; absent one, 20s is the ceiling.
  const res = await authenticatedFetch(`${BASE}${path}`, {
    credentials: "include",
    headers: authHeaders(),
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error((body as any)?.error || `codex http ${res.status}`), { status: res.status, body })
  return body as T
}

export interface CodexHealth { ok: boolean; enabled: boolean; previewOrigin?: string | null }
export interface CodexAccess { ok: boolean; enabled: boolean; canRun: boolean; allowlistConfigured: boolean }
export interface CodexProject { id: string; name: string; status: string; workspacePath: string | null; previewUrl: string | null; error: string | null }
export interface CodexRun { id: string; projectId: string; mode: string; status: string; tier: string | null; model: string | null; planRunId: string | null; prompt: string | null; error: string | null; metric?: CodexRunMetric }
export interface CodexRunMetric { timeWorkedMs: number; actionsCount: number; itemsReadLines: number; additions: number; deletions: number; tokensIn: number; tokensOut: number; model: string | null; costUsd: number; costSource: string; costOriginalUsd: number; costAppliedUsd: number; costInputUsd: number; costOutputUsd: number }
export interface CodexCheckpointDiff { ok: boolean; commitSha: string; diff: string; truncated: boolean; additions: number; deletions: number; filesChanged: number }

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

  listProjects: () => req<{ projects: CodexProject[] }>("/projects").then((r) => r.projects),
  createProject: (name: string, brief?: unknown) => req<{ project: CodexProject }>("/projects", { method: "POST", body: JSON.stringify({ name, brief }) }).then((r) => r.project),
  getProject: (id: string) => req<{ project: CodexProject }>(`/projects/${id}`).then((r) => r.project),
  startPreview: (id: string) => req<{ devUrl: string; previewUrl?: string; basePath?: string }>(`/projects/${id}/preview/start`, { method: "POST" }),
  previewStatus: (id: string) => req<any>(`/projects/${id}/preview/status`),
  stopPreview: (id: string) => req<{ ok: boolean }>(`/projects/${id}/preview/stop`, { method: "POST" }),
  exportProject: (id: string) => req<{ ok: boolean; project: string; files: number; hostPath: string }>(`/projects/${id}/export`, { method: "POST" }),
  listFiles: (id: string) => req<{ files: string[] }>(`/projects/${id}/files`).then((r) => r.files),
  // Workspace import (browser → Codex project): push the local files into the
  // project BEFORE an iterate run so the agent edits the tree the user sees.
  importFiles: (id: string, files: Array<{ path: string; content: string }>) =>
    req<{ ok: boolean; written: number }>(`/projects/${id}/files`, { method: "POST", body: JSON.stringify({ files }) }),
  readFileContent: (id: string, path: string) => req<{ ok: boolean; path: string; content: string }>(`/projects/${id}/file?path=${encodeURIComponent(path)}`),

  createRun: (projectId: string, body: { mode: "plan" | "build"; prompt?: string; model?: string; tier?: string; planRunId?: string }) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.run),
  listRuns: (projectId: string) => req<{ runs: CodexRun[] }>(`/projects/${projectId}/runs`).then((r) => r.runs),
  getRun: (projectId: string, runId: string) => req<{ run: CodexRun }>(`/projects/${projectId}/runs/${runId}`).then((r) => r.run),
  cancelRun: (runId: string) => req<{ run: CodexRun }>(`/runs/${runId}/cancel`, { method: "POST" }).then((r) => r.run),

  approvePlan: (projectId: string, planRunId: string, tier?: string) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify({ mode: "build", planRunId, tier }) }).then((r) => r.run),
  rollbackCheckpoint: (checkpointId: string) => req<{ ok: boolean; commitSha: string; restarted: boolean }>(`/checkpoints/${checkpointId}/rollback`, { method: "POST" }),
  getCheckpointDiff: (checkpointId: string) => req<CodexCheckpointDiff>(`/checkpoints/${checkpointId}/diff`),
  listCheckpoints: (projectId: string) => req<{ checkpoints: any[] }>(`/projects/${projectId}/checkpoints`).then((r) => r.checkpoints),
}
