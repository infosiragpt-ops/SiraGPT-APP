"use client"

/**
 * design-service — client for /api/design.
 *
 * The generate endpoint streams SSE; everything else is normal
 * REST. Pattern matches the other project sub-services so the
 * app's fetch conventions stay uniform.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export type DesignKind = "prototype" | "slide_deck" | "template" | "other"
export type DesignFidelity = "wireframe" | "high"

export interface DesignSummary {
  id: string
  name: string
  kind: DesignKind
  fidelity: DesignFidelity | null
  speakerNotes: boolean | null
  createdAt: string
  updatedAt: string
}

export interface DesignDetail extends DesignSummary {
  html: string | null
  messages: Array<{ role: "user" | "assistant"; content: string; at: string; htmlChars?: number }>
}

export interface CreateDesignInput {
  name: string
  kind: DesignKind
  fidelity?: DesignFidelity
  speakerNotes?: boolean
}

export type GenerateEvent =
  | { type: "start" }
  | { type: "progress"; chars: number }
  | { type: "final"; html: string; updatedAt: string }
  | { type: "error"; error: string }

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j.error || msg } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const designService = {
  async list(search?: string): Promise<DesignSummary[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : ""
    const res = await fetch(`${API_ROOT}/design${qs}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
    })
    const json = await handle<{ designs: DesignSummary[] }>(res)
    return json.designs
  },

  async get(id: string): Promise<DesignDetail> {
    const res = await fetch(`${API_ROOT}/design/${id}`, {
      credentials: "include",
      headers: authHeader(),
    })
    const json = await handle<{ design: DesignDetail }>(res)
    return json.design
  },

  async create(input: CreateDesignInput): Promise<DesignSummary> {
    const res = await fetch(`${API_ROOT}/design`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(input),
    })
    const json = await handle<{ design: DesignSummary }>(res)
    return json.design
  },

  async update(id: string, body: { name?: string; html?: string | null }): Promise<DesignSummary> {
    const res = await fetch(`${API_ROOT}/design/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
    })
    const json = await handle<{ design: DesignSummary }>(res)
    return json.design
  },

  async remove(id: string): Promise<void> {
    const res = await fetch(`${API_ROOT}/design/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeader(),
    })
    await handle<{ deleted: boolean }>(res)
  },

  /**
   * Yields generate events as they arrive. Caller drives the UI;
   * the `final` event carries the complete HTML document, which
   * the iframe then renders.
   */
  async *generate(id: string, instruction: string, signal?: AbortSignal): AsyncGenerator<GenerateEvent> {
    const res = await fetch(`${API_ROOT}/design/${id}/generate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ instruction }),
      signal,
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const j = await res.json(); msg = j.error || msg } catch {}
      throw new Error(msg)
    }
    if (!res.body) throw new Error("Stream body missing")

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const payload = raw.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n")
        if (!payload) continue
        try { yield JSON.parse(payload) as GenerateEvent } catch {}
      }
    }
  },
}
