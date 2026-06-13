// codex/codex-api — typed HTTP client for the Codex Agent V2 backend
// (/api/codex/*). Mirrors lib/builder/intake-service.ts: localStorage JWT
// Bearer + credentials:include. Used by the timeline hook (feature 10) and the
// cards/composer (features 11–12).

const BASE = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")}/codex`

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", headers: authHeaders(), ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error((body as any)?.error || `codex http ${res.status}`), { status: res.status, body })
  return body as T
}

export interface CodexHealth { ok: boolean; enabled: boolean }
export interface CodexProject { id: string; name: string; status: string; workspacePath: string | null; previewUrl: string | null; error: string | null }
export interface CodexRun { id: string; projectId: string; mode: string; status: string; tier: string | null; model: string | null; planRunId: string | null; prompt: string | null; error: string | null; metric?: CodexRunMetric }
export interface CodexRunMetric { timeWorkedMs: number; actionsCount: number; itemsReadLines: number; additions: number; deletions: number; tokensIn: number; tokensOut: number; costUsd: number; costSource: string; costOriginalUsd: number; costAppliedUsd: number }
export interface CodexCheckpointDiff { ok: boolean; commitSha: string; diff: string; truncated: boolean; additions: number; deletions: number; filesChanged: number }

export const codexApi = {
  health: () => req<CodexHealth>("/health"),

  listProjects: () => req<{ projects: CodexProject[] }>("/projects").then((r) => r.projects),
  createProject: (name: string, brief?: unknown) => req<{ project: CodexProject }>("/projects", { method: "POST", body: JSON.stringify({ name, brief }) }).then((r) => r.project),
  getProject: (id: string) => req<{ project: CodexProject }>(`/projects/${id}`).then((r) => r.project),
  startPreview: (id: string) => req<{ devUrl: string }>(`/projects/${id}/preview/start`, { method: "POST" }),
  previewStatus: (id: string) => req<any>(`/projects/${id}/preview/status`),

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
