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

/** Verdict from the headless-chromium post-boot functional check. */
export interface RuntimeVerdict {
  ok?: boolean
  skipped?: boolean
  reason?: string
  rendered?: boolean
  navStatus?: number
  errors?: string[]
  warnings?: string[]
  findings?: Array<{ severity: string; kind: string; message: string }>
  summary?: string
  error?: string
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

  /**
   * Post-boot functional check: does the app actually RENDER (not blank / 500 /
   * JS-crashed), Replit-style? Runs headless chromium server-side against the
   * live dev server. Never throws and never blocks the app: any hiccup (or a
   * missing browser) returns { ok:true, skipped:true } so a working preview is
   * never held back by a verify problem.
   */
  async verifyRuntime(runId: string): Promise<RuntimeVerdict> {
    try {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(runId)}/verify-runtime`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      })
      if (!res.ok) return { ok: true, skipped: true, reason: `HTTP ${res.status}`, findings: [] }
      return (await res.json().catch(() => ({}))) as RuntimeVerdict
    } catch {
      return { ok: true, skipped: true, reason: "unreachable", findings: [] }
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

  /**
   * Type verification: run `tsc --noEmit` in the run's workspace. Fail-open —
   * network/permission problems come back as skipped so the preview flow never
   * blocks on the verifier.
   */
  async verify(runId: string): Promise<HostRunVerify> {
    try {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(runId)}/verify`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      })
      if (!res.ok) return { ok: true, skipped: true, reason: `HTTP ${res.status}`, errors: [] }
      return (await res.json().catch(() => ({ ok: true, skipped: true, errors: [] }))) as HostRunVerify
    } catch {
      return { ok: true, skipped: true, reason: "runner unreachable", errors: [] }
    }
  },

  /**
   * Run ONE terminal command in the run's live workspace dir (the real Shell).
   * Returns the combined stdout/stderr + exit code. Owner-gated + bounded
   * server-side. `unavailable:true` means there is no running dev server to
   * exec against (the caller should fall back to the client-side pseudo-shell).
   */
  async exec(runId: string, command: string): Promise<HostRunExec> {
    try {
      const res = await fetch(`${baseUrl}/${encodeURIComponent(runId)}/exec`, {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      })
      if (res.status === 404) return { ok: false, unavailable: true, output: "", error: "no hay un servidor activo" }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        return { ok: false, output: "", error: body.error || body.message || `HTTP ${res.status}` }
      }
      return (await res.json().catch(() => ({ ok: false, output: "", error: "respuesta inválida" }))) as HostRunExec
    } catch {
      return { ok: false, unavailable: true, output: "", error: "runner unreachable" }
    }
  },
}

export interface HostRunExec {
  ok: boolean
  /** No running dev server to exec against → caller falls back to the pseudo-shell. */
  unavailable?: boolean
  exitCode?: number
  output: string
  error?: string
  timedOut?: boolean
  truncated?: boolean
}

export interface HostRunVerifyError {
  file: string
  line: number
  col: number
  code: string
  message: string
}

export interface HostRunVerify {
  ok: boolean
  skipped?: boolean
  reason?: string
  timedOut?: boolean
  exitCode?: number
  errors: HostRunVerifyError[]
  errorCount?: number
}
