"use client"

import { authenticatedFetch } from "./authenticated-fetch"
import { streamSseJson } from "./sse-client"

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
  messages: Array<{ role: "user" | "assistant"; content: string; at: string; htmlChars?: number; quality?: DesignQualityReport }>
}

export interface CreateDesignInput {
  name: string
  kind: DesignKind
  fidelity?: DesignFidelity
  speakerNotes?: boolean
}

export interface DesignQualityReport {
  passed: boolean
  score: number
  issues: Array<{ id: string; message: string }>
  warnings: Array<{ id: string; message: string }>
}

export type DesignEffort = "rapid" | "balanced" | "thorough"

export type GenerateEvent =
  | { type: "start"; model?: string | null }
  | { type: "progress"; chars: number }
  | { type: "review"; quality: DesignQualityReport }
  | { type: "repair"; quality: DesignQualityReport }
  | { type: "final"; html: string; updatedAt: string; quality?: DesignQualityReport | null }
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
    const res = await authenticatedFetch(`${API_ROOT}/design${qs}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
    })
    const json = await handle<{ designs: DesignSummary[] }>(res)
    return json.designs
  },

  async get(id: string): Promise<DesignDetail> {
    const res = await authenticatedFetch(`${API_ROOT}/design/${id}`, {
      credentials: "include",
      headers: authHeader(),
    })
    const json = await handle<{ design: DesignDetail }>(res)
    return json.design
  },

  async create(input: CreateDesignInput): Promise<DesignSummary> {
    const res = await authenticatedFetch(`${API_ROOT}/design`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(input),
    })
    const json = await handle<{ design: DesignSummary }>(res)
    return json.design
  },

  async update(id: string, body: { name?: string; html?: string | null }): Promise<DesignSummary> {
    const res = await authenticatedFetch(`${API_ROOT}/design/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
    })
    const json = await handle<{ design: DesignSummary }>(res)
    return json.design
  },

  async remove(id: string): Promise<void> {
    const res = await authenticatedFetch(`${API_ROOT}/design/${id}`, {
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
   *
   * `model` is threaded to the backend so its provider router
   * picks OpenAI / OpenRouter / Gemini based on the model name.
   * Omitted → backend default (gpt-4o).
   */
  async *generate(
    id: string,
    instruction: string,
    opts: { model?: string; effort?: DesignEffort; signal?: AbortSignal } = {},
  ): AsyncGenerator<GenerateEvent> {
    const { model, effort, signal } = opts
    const res = await authenticatedFetch(`${API_ROOT}/design/${id}/generate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ instruction, model, effort }),
      signal,
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const j = await res.json(); msg = j.error || msg } catch {}
      throw new Error(msg)
    }
    if (!res.body) throw new Error("Stream body missing")

    for await (const event of streamSseJson<GenerateEvent>(res.body, { signal })) {
      yield event
    }
  },
}
