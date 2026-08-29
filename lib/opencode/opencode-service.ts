"use client"

import { authenticatedFetch } from "../authenticated-fetch"
import { fetchResumeHeaders, persistLastEventId, readLastEventId } from "../sse-client"

/**
 * Frontend client for /api/opencode — SiraCode native engine.
 * Independent rewrite inspired by OpenCode; not a Bun sidecar.
 */

export interface OpencodeHealth {
  ok: boolean
  configured: boolean
  native?: boolean
  engine?: string
  sidecar?: boolean
  baseUrl: string | null
}

export interface OpencodeSession {
  id?: string
  [key: string]: unknown
}

/** A parsed SSE event from the engine stream. */
export interface OpencodeEvent {
  type: string
  data: unknown
}

const baseUrl = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/opencode`

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
      message = body.message || body.error || message
    } catch {
      // non-JSON error — use the status line
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export const opencodeService = {
  /** Is the engine configured/reachable? Safe to call without auth. */
  async health(): Promise<OpencodeHealth> {
    const res = await fetch(`${baseUrl}/health`)
    return handle<OpencodeHealth>(res)
  },

  /** Create a SiraCode session (construir | planificar). */
  async createSession(seed: OpencodeSession = {}): Promise<OpencodeSession> {
    const res = await authenticatedFetch(`${baseUrl}/session`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ session: seed }),
    })
    const json = await handle<{ session: OpencodeSession }>(res)
    return json.session
  },

  /** Send a text prompt to a session. The picker model is forwarded, not displayed. */
  async prompt(sessionId: string, text: string, opts: { model?: string; agent?: string } = {}): Promise<unknown> {
    const res = await authenticatedFetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ text, model: opts.model, agent: opts.agent }),
    })
    const json = await handle<{ result: unknown }>(res)
    return json.result
  }

  /** Switch Construir / Planificar on an existing session. */
  async switchAgent(sessionId: string, agent: string): Promise<OpencodeSession> {
    const res = await authenticatedFetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/agent`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ agent }),
    })
    const json = await handle<{ session: OpencodeSession }>(res)
    return json.session
  },

  /** Stop an in-flight OpenCode session so Detener actually halts engine writes. */
  async abortSession(sessionId: string): Promise<void> {
    try {
      await authenticatedFetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
      })
    } catch {
      /* engine offline or already idle */
    }
  },

  /**
   * List + read EVERY file the agent wrote in its workspace (recursive), so the
   * UI can show a real multi-file project. Returns [] on any failure.
   */
  async listProjectFiles(): Promise<Array<{ path: string; content: string }>> {
    try {
      const res = await authenticatedFetch(`${baseUrl}/files`, { credentials: "include", headers: authHeaders() })
      if (!res.ok) return []
      const json = (await res.json().catch(() => ({}))) as {
        files?: Array<{ path: string; content: string }>
      }
      return Array.isArray(json.files)
        ? json.files.filter((f) => f && typeof f.path === "string" && typeof f.content === "string")
        : []
    } catch {
      return []
    }
  },

  /** Phase B — install deps + start the project's dev server. → { ok, port, devUrl }. */
  async runProject(): Promise<{ ok?: boolean; port?: number; devUrl?: string; error?: string }> {
    try {
      const res = await authenticatedFetch(`${baseUrl}/run`, { method: "POST", credentials: "include", headers: authHeaders() })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        port?: number
        devUrl?: string
        error?: string
        message?: string
      }
      if (!res.ok) {
        // Surface a friendly message instead of a raw error code (503 = feature
        // not configured; 502 = runner sidecar unreachable).
        const friendly =
          body.error === "opencode_not_configured"
            ? "El motor de código no está disponible ahora. Inténtalo de nuevo."
            : body.message || body.error || `HTTP ${res.status}`
        return { error: friendly }
      }
      return body
    } catch (e) {
      return { error: e instanceof Error ? e.message : "runner unreachable" }
    }
  },

  /** Phase B — dev-server status: { running, ready, framework, error, tail, devUrl }. */
  async runStatus(): Promise<{
    running?: boolean
    ready?: boolean
    framework?: string | null
    error?: string | null
    tail?: string[]
    devUrl?: string
  }> {
    try {
      const res = await authenticatedFetch(`${baseUrl}/run/status`, { credentials: "include", headers: authHeaders() })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return (await res.json().catch(() => ({}))) as Awaited<ReturnType<typeof opencodeService.runStatus>>
    } catch (e) {
      return { error: e instanceof Error ? e.message : "runner unreachable" }
    }
  },

  /** Phase B — stop the running dev server. */
  async stopRun(): Promise<void> {
    try {
      await authenticatedFetch(`${baseUrl}/run/stop`, { method: "POST", credentials: "include", headers: authHeaders() })
    } catch {
      /* ignore */
    }
  },

  /** Read a file the agent wrote in the engine's workspace. "" if absent. */
  async readFile(path: string): Promise<string> {
    const res = await authenticatedFetch(`${baseUrl}/file?path=${encodeURIComponent(path)}`, {
      credentials: "include",
      headers: authHeaders(),
    })
    if (!res.ok) return ""
    const json = (await res.json().catch(() => ({}))) as { content?: string }
    return typeof json.content === "string" ? json.content : ""
  },

  /**
   * Stream the engine's SSE events. Calls `onEvent` per frame; resolves when the
   * stream ends. Pass an AbortSignal to stop. Uses fetch (not EventSource) so the
   * JWT can ride in the Authorization header.
   */
  async streamEvents(
    onEvent: (event: OpencodeEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const storageKey = "siragpt:lastEventId:opencode"
    const lastId = readLastEventId(storageKey)
    const res = await authenticatedFetch(`${baseUrl}/events`, {
      credentials: "include",
      headers: { ...authHeaders(), Accept: "text/event-stream", ...fetchResumeHeaders(lastId) },
      signal,
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder("utf-8")
    let buffer = ""

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Consume complete SSE frames (separated by a blank line).
      let sep: number
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const event = parseFrame(frame)
        if (event) onEvent(event)
      }
    }
  },
}

/** Parse one SSE frame ("event: x\ndata: {...}") into {type, data}. */
function parseFrame(frame: string): OpencodeEvent | null {
  let type = "message"
  const dataLines: string[] = []
  let id = ""
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    else if (line.startsWith("id:")) id = line.slice(3).trim()
  }
  if (id) persistLastEventId("siragpt:lastEventId:opencode", id)
  if (dataLines.length === 0) return null
  const raw = dataLines.join("\n")
  if (raw === "[DONE]") return { type: "done", data: null }
  try {
    return { type, data: JSON.parse(raw) }
  } catch {
    return { type, data: raw }
  }
}
