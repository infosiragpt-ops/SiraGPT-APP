"use client"

import { streamSseJson } from "./sse-client"

/**
 * marco-teorico-service — client for the SSE generation pipeline.
 *
 * Exposes an async generator so the page can `for await` over events
 * as they arrive, and an AbortController hook so the user can cancel
 * mid-run (closes the fetch, the server propagates to OpenAlex +
 * OpenAI calls).
 *
 * Uses the Fetch + Readable Stream APIs to parse SSE frames directly.
 * We intentionally don't use EventSource because EventSource cannot
 * send request bodies or custom headers (both of which we need for
 * POST + Authorization).
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export type MarcoPhase = "search" | "validate" | "synthesize" | "format"
export type PhaseStatus = "running" | "done" | "error"

export interface MarcoSource {
  id?: string
  doi: string | null
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  abstract?: string | null
  type?: string | null
  citedByCount?: number
  openAccessUrl?: string | null
  landingUrl?: string | null
}

export interface MarcoValidation {
  index: number
  doi: string | null
  ok: boolean | "nodoi"
  meta?: any
}

export type MarcoEvent =
  | { type: "phase"; phase: MarcoPhase; status: PhaseStatus; [k: string]: any }
  | { type: "source"; source: MarcoSource }
  | { type: "validation"; index: number; doi: string | null; ok: boolean | "nodoi"; meta?: any }
  | { type: "synthesis_chunk"; delta: string; full: string }
  | { type: "final"; markdown: string; sources: MarcoSource[]; stats: { total: number; validated: number; noDoi: number; invalid: number } }
  | { type: "error"; message: string; phase?: MarcoPhase }

export interface GenerateArgs {
  projectId: string
  topic?: string
  limit?: number
  yearFrom?: number
  yearTo?: number
  lang?: "es" | "en" | "pt" | "fr"
  model?: string
  signal?: AbortSignal
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Yields events from the server. Consumes response chunks and
 * parses the `data: {...}\n\n` framing.
 */
export async function* generate({ projectId, signal, ...body }: GenerateArgs): AsyncGenerator<MarcoEvent> {
  const resp = await fetch(`${API_ROOT}/projects/${projectId}/marco-teorico/generate`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try {
      const j = await resp.json()
      msg = j.error || msg
    } catch {
      /* non-JSON */
    }
    throw new Error(msg)
  }
  if (!resp.body) throw new Error("Stream body missing")

  for await (const event of streamSseJson<MarcoEvent>(resp.body, { signal })) {
    yield event
  }
}

/**
 * Persist a generated marco teórico as a chat inside the project.
 * Returns the chat id so the caller can deep-link the user into
 * /chat?id=<id> to continue iterating.
 */
export async function save({
  projectId, title, topic, markdown, sources,
}: {
  projectId: string
  title?: string
  topic?: string
  markdown: string
  sources?: MarcoSource[]
}): Promise<{ id: string; title: string; projectId: string | null }> {
  const resp = await fetch(`${API_ROOT}/projects/${projectId}/marco-teorico/save`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ title, topic, markdown, sources }),
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try { const j = await resp.json(); msg = j.error || msg } catch {}
    throw new Error(msg)
  }
  const json = await resp.json()
  return json.chat
}
