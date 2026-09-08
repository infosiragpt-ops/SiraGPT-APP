/**
 * Client for /api/agentes-coding (AGENTES_CODING_V2).
 *
 * The UI never hardcodes the flag ON. Only GET /health `{ enabled: true }`
 * mounts the IDE. Errors and failed probes stay disabled.
 */

import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"

export type AgentesCodingHealth = {
  ok: true
  enabled: boolean
}

export type CodingSession = {
  id: string
  userId?: string | null
  driver?: string
  createdAt?: number
  expiresAt?: number
}

export type CodingFileEntry = {
  path: string
  size?: number
}

export type CodingExecResult = {
  ok: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  timedOut?: boolean
}

export type CodingRepoMapHint = {
  name: string
  path: string
  kind: string
  score: number
}

export type CodingRepoMap = {
  ok: true
  hints: CodingRepoMapHint[]
  omitted?: number
  scanned?: number
  headerBytes?: number
  query?: string
}

export type CodingStructMatch = {
  path: string
  text: string
  replacement?: string
  start?: number
  end?: number
}

export type CodingStructDiff = {
  path: string
  original: string
  proposed: string
  matchCount?: number
  changed?: boolean
}

export type CodingStructPreview = {
  ok: true
  matches: CodingStructMatch[]
  diffs: CodingStructDiff[]
  scanned?: number
  lang?: string
  pattern?: string
  rewrite?: string
}

export type CodingStructApply = {
  ok: true
  applied: Array<{ path: string; bytes?: number }>
  skipped: Array<{ path: string; reason?: string }>
}

export class AgentesCodingApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, opts: { status: number; code: string }) {
    super(message)
    this.name = "AgentesCodingApiError"
    this.status = opts.status
    this.code = opts.code
  }
}

export type AgentesCodingApiOptions = {
  fetchImpl?: typeof fetch
  request?: typeof authenticatedFetch
  apiBase?: string
}

/** Only an explicit JSON `enabled: true` turns the IDE on. */
export function parseHealthEnabled(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  return (body as { enabled?: unknown }).enabled === true
}

export function shouldMountAgentesCodingIde(
  health: { enabled?: unknown } | null | undefined,
): boolean {
  return health?.enabled === true
}

function flagOffError(status = 404): AgentesCodingApiError {
  return new AgentesCodingApiError("El editor de código no está activo.", {
    status,
    code: "E_FLAG_OFF",
  })
}

function readError(body: unknown, status: number): AgentesCodingApiError {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  if (status === 404 || rec.error === "not_found") return flagOffError(status)
  const code = typeof rec.error === "string" && rec.error.startsWith("E_")
    ? rec.error
    : typeof rec.code === "string" && rec.code.startsWith("E_")
      ? rec.code
      : "E_PROVIDER"
  const message = typeof rec.message === "string" && rec.message.trim()
    ? rec.message.trim()
    : "No se pudo completar la operación del editor."
  return new AgentesCodingApiError(message, { status, code })
}

export function createAgentesCodingApi(opts: AgentesCodingApiOptions = {}) {
  const fetchImpl = opts.fetchImpl || fetch
  const request = opts.request || authenticatedFetch
  const resolveBase = () =>
    `${(opts.apiBase || getSameOriginApiBaseUrl()).replace(/\/+$/, "")}/agentes-coding`

  async function readJson(res: Response): Promise<unknown> {
    return res.json().catch(() => ({}))
  }

  async function health(): Promise<AgentesCodingHealth> {
    try {
      const res = await fetchImpl(`${resolveBase()}/health`, {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" },
      })
      const body = await readJson(res)
      return { ok: true, enabled: res.ok && parseHealthEnabled(body) }
    } catch {
      return { ok: true, enabled: false }
    }
  }

  async function authed<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await request(`${resolveBase()}${path}`, {
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      ...init,
    })
    const body = await readJson(res)
    if (!res.ok) throw readError(body, res.status)
    return body as T
  }

  return {
    health,

    async createSession(): Promise<CodingSession> {
      const body = await authed<{ ok?: boolean; session?: CodingSession }>("/sessions", {
        method: "POST",
        body: "{}",
      })
      if (!body.session?.id) {
        throw new AgentesCodingApiError("No se pudo crear la sesión.", {
          status: 500,
          code: "E_PROVIDER",
        })
      }
      return body.session
    },

    async listFiles(sessionId: string, relPath = "."): Promise<CodingFileEntry[]> {
      const q = new URLSearchParams({ path: relPath || "." })
      const body = await authed<{ files?: CodingFileEntry[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/files?${q.toString()}`,
      )
      return Array.isArray(body.files) ? body.files : []
    },

    async readFile(sessionId: string, filePath: string): Promise<string> {
      const body = await authed<{ content?: string }>(
        `/sessions/${encodeURIComponent(sessionId)}/read`,
        { method: "POST", body: JSON.stringify({ path: filePath }) },
      )
      return typeof body.content === "string" ? body.content : ""
    },

    async writeFile(sessionId: string, filePath: string, content: string): Promise<{ path: string; bytes?: number }> {
      const body = await authed<{ file?: { path: string; bytes?: number } }>(
        `/sessions/${encodeURIComponent(sessionId)}/files`,
        { method: "PUT", body: JSON.stringify({ path: filePath, content }) },
      )
      return body.file || { path: filePath }
    },

    async repoMap(
      sessionId: string,
      opts: { query?: string; limit?: number } = {},
    ): Promise<CodingRepoMap> {
      const q = new URLSearchParams()
      if (opts.query) q.set("query", opts.query)
      if (opts.limit) q.set("limit", String(opts.limit))
      const suffix = q.toString() ? `?${q.toString()}` : ""
      const body = await authed<CodingRepoMap>(
        `/sessions/${encodeURIComponent(sessionId)}/map${suffix}`,
      )
      return {
        ok: true,
        hints: Array.isArray(body.hints) ? body.hints : [],
        omitted: body.omitted,
        scanned: body.scanned,
        headerBytes: body.headerBytes,
        query: body.query,
      }
    },

    async structEditPreview(
      sessionId: string,
      opts: { pattern: string; rewrite?: string; lang?: string; path?: string },
    ): Promise<CodingStructPreview> {
      const body = await authed<CodingStructPreview>(
        `/sessions/${encodeURIComponent(sessionId)}/struct-edit`,
        { method: "POST", body: JSON.stringify(opts) },
      )
      return {
        ok: true,
        matches: Array.isArray(body.matches) ? body.matches : [],
        diffs: Array.isArray(body.diffs) ? body.diffs : [],
        scanned: body.scanned,
        lang: body.lang,
        pattern: body.pattern,
        rewrite: body.rewrite,
      }
    },

    async structEditApply(
      sessionId: string,
      opts: { diffs?: CodingStructDiff[]; pattern?: string; rewrite?: string; lang?: string },
    ): Promise<CodingStructApply> {
      const body = await authed<CodingStructApply>(
        `/sessions/${encodeURIComponent(sessionId)}/struct-edit/apply`,
        { method: "POST", body: JSON.stringify(opts) },
      )
      return {
        ok: true,
        applied: Array.isArray(body.applied) ? body.applied : [],
        skipped: Array.isArray(body.skipped) ? body.skipped : [],
      }
    },

    async exec(sessionId: string, command: string): Promise<CodingExecResult> {
      const body = await authed<{ ok?: boolean; result?: CodingExecResult }>(
        `/sessions/${encodeURIComponent(sessionId)}/exec`,
        { method: "POST", body: JSON.stringify({ command }) },
      )
      return body.result || { ok: Boolean(body.ok), stdout: "", stderr: "" }
    },

    async destroy(sessionId: string): Promise<void> {
      await authed(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
    },
  }
}

export const agentesCodingApi = createAgentesCodingApi()
