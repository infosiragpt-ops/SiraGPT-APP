"use client"

/**
 * Frontend client for /api/opencode — siraGPT's bridge to the OpenCode engine
 * (vendor/opencode, run as a Bun sidecar). Mirrors lib/builder/intake-service:
 * localStorage JWT, credentials:include, thin fetch wrappers.
 *
 * The engine is optional: `health()` reports whether it's configured so the UI
 * can show an "engine offline" state instead of erroring.
 */

export interface OpencodeHealth {
  ok: boolean
  configured: boolean
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
    const res = await fetch(`${baseUrl}/health`, { credentials: "include", headers: authHeaders() })
    return handle<OpencodeHealth>(res)
  },

  /** Create an agent session on the engine. */
  async createSession(seed: OpencodeSession = {}): Promise<OpencodeSession> {
    const res = await fetch(`${baseUrl}/session`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ session: seed }),
    })
    const json = await handle<{ session: OpencodeSession }>(res)
    return json.session
  },

  /** Send a text prompt to a session. Returns the engine's response object. */
  async prompt(sessionId: string, text: string): Promise<unknown> {
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
      body: JSON.stringify({ text }),
    })
    const json = await handle<{ result: unknown }>(res)
    return json.result
  },

  /**
   * List + read EVERY file the agent wrote in its workspace (recursive), so the
   * UI can show a real multi-file project. Returns [] on any failure.
   */
  async listProjectFiles(): Promise<Array<{ path: string; content: string }>> {
    try {
      const res = await fetch(`${baseUrl}/files`, { credentials: "include", headers: authHeaders() })
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
      const res = await fetch(`${baseUrl}/run`, { method: "POST", credentials: "include", headers: authHeaders() })
      return (await res.json().catch(() => ({}))) as { ok?: boolean; port?: number; devUrl?: string; error?: string }
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
      const res = await fetch(`${baseUrl}/run/status`, { credentials: "include", headers: authHeaders() })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return (await res.json().catch(() => ({}))) as Awaited<ReturnType<typeof opencodeService.runStatus>>
    } catch (e) {
      return { error: e instanceof Error ? e.message : "runner unreachable" }
    }
  },

  /** Phase B — stop the running dev server. */
  async stopRun(): Promise<void> {
    try {
      await fetch(`${baseUrl}/run/stop`, { method: "POST", credentials: "include", headers: authHeaders() })
    } catch {
      /* ignore */
    }
  },

  /** Read a file the agent wrote in the engine's workspace. "" if absent. */
  async readFile(path: string): Promise<string> {
    const res = await fetch(`${baseUrl}/file?path=${encodeURIComponent(path)}`, {
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
    const res = await fetch(`${baseUrl}/events`, {
      credentials: "include",
      headers: { ...authHeaders(), Accept: "text/event-stream" },
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
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join("\n")
  if (raw === "[DONE]") return { type: "done", data: null }
  try {
    return { type, data: JSON.parse(raw) }
  } catch {
    return { type, data: raw }
  }
}
