"use client"

/**
 * Frontend client for /api/code-runner — the no-Docker host runner that boots a
 * generated project as a real dev server (vite/next dev) on a localhost port.
 * The /code preview iframes `devUrl` directly, so HMR works natively.
 *
 * Mirrors opencode-service: localStorage JWT, credentials:include, thin fetch
 * wrappers, never throws (returns {error}/{disabled} so the UI can degrade).
 */

export interface HostRunStatus {
  running?: boolean
  ready?: boolean
  phase?: string
  framework?: string | null
  error?: string | null
  tail?: string[]
  devUrl?: string
  port?: number
}

const baseUrl = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/code-runner`

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export const hostRunnerService = {
  /** Is the local host runner enabled in this environment? */
  async health(): Promise<{ ok: boolean; enabled: boolean }> {
    try {
      const res = await fetch(`${baseUrl}/health`, { credentials: "include", headers: authHeaders() })
      if (!res.ok) return { ok: false, enabled: false }
      return (await res.json()) as { ok: boolean; enabled: boolean }
    } catch {
      return { ok: false, enabled: false }
    }
  },

  /** Write the workspace files + install deps + boot the dev server. */
  async start(
    files: Record<string, string>,
    runId: string,
    env?: Record<string, string>,
  ): Promise<{ runId?: string; phase?: string; devUrl?: string; error?: string; disabled?: boolean }> {
    try {
      const res = await fetch(`${baseUrl}/start`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ runId, files, env }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        runId?: string
        phase?: string
        devUrl?: string
        error?: string
        message?: string
      }
      if (!res.ok) {
        // 503 host_runner_disabled → caller falls back to the opencode/Docker path.
        if (body.error === "host_runner_disabled") return { disabled: true }
        return { error: body.message || body.error || `HTTP ${res.status}` }
      }
      return body
    } catch (e) {
      return { error: e instanceof Error ? e.message : "runner unreachable" }
    }
  },

  /** Dev-server status: { running, ready, framework, error, tail, devUrl }. */
  async status(runId: string): Promise<HostRunStatus> {
    try {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(runId)}/status`, {
        credentials: "include",
        headers: authHeaders(),
      })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return (await res.json().catch(() => ({}))) as HostRunStatus
    } catch (e) {
      return { error: e instanceof Error ? e.message : "runner unreachable" }
    }
  },

  /** Stop the running dev server. */
  async stop(runId: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/${encodeURIComponent(runId)}/stop`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      })
    } catch {
      /* ignore */
    }
  },
}
