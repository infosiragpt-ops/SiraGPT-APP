/**
 * Admin → Logs → «Registros en vivo» client.
 *
 *   GET /api/admin/logs/live            SSE (fetch stream + Bearer; never EventSource,
 *                                        a JWT must never travel in a URL)
 *   GET /api/admin/logs/search          history, newest first
 *   GET /api/admin/logs/request/:reqId  every line of one request/turn
 */

import { authenticatedFetch } from "../authenticated-fetch"
import { getNormalizedApiBaseUrl } from "../api-base-url"

export type LiveLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export type LiveLogLine = {
  id: string
  ts: number
  level: LiveLogLevel
  source: string
  tag?: string
  msg: string
  body?: string
  status?: number
  reqId?: string
  userId?: string
  email?: string
  chatId?: string
  route?: string
  queue?: string
  jobId?: string
  commit?: string
  via?: string
  repeat?: number
  lastTs?: number
}

export type LiveLogLevelFilter = "all" | "info" | "warn" | "error"

export type LiveLogFilter = {
  level?: LiveLogLevelFilter
  source?: string
  q?: string
  user?: string
  reqId?: string
  chatId?: string
}

export type LiveLogStats = {
  ringSize?: number
  pending?: number
  redis?: string
  paused?: boolean
  captured?: number
  collapsed?: number
  dropped?: number
}

export type LiveLogStreamEvent =
  | { event: "hello"; data: { now: number; stats?: LiveLogStats } }
  | { event: "backfill"; data: LiveLogLine[] }
  | { event: "ready"; data: { count: number } }
  | { event: "lines"; data: LiveLogLine[] }
  | { event: "repeat"; data: Array<{ id: string; repeat: number; lastTs: number }> }
  | { event: "ping"; data: { now: number; dropped?: number; stats?: LiveLogStats } }

export type RequestLogsSummary = {
  count: number
  firstTs: number | null
  lastTs: number | null
  durationMs: number | null
  levels: Record<string, number>
  errors: number
  users: string[]
  routes: string[]
  chatIds: string[]
}

export const LEVEL_RANK: Record<LiveLogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

export function isErrorLevel(level: LiveLogLevel | string | undefined): boolean {
  return level === "error" || level === "fatal"
}

function apiBase(): string {
  return getNormalizedApiBaseUrl().replace(/\/+$/, "")
}

export function buildLogsQuery(filter: LiveLogFilter = {}, extra: Record<string, string | number | undefined | null> = {}): string {
  const params = new URLSearchParams()
  if (filter.level && filter.level !== "all") params.set("level", filter.level)
  for (const key of ["source", "q", "user", "reqId", "chatId"] as const) {
    const value = filter[key]
    if (typeof value === "string" && value.trim()) params.set(key, value.trim())
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value) !== "") params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

/** Stateful SSE frame parser (event + data lines, blank-line separated). */
export function createLogStreamParser() {
  let buffer = ""
  return {
    push(chunk: string): LiveLogStreamEvent[] {
      buffer += chunk.replace(/\r\n/g, "\n")
      const out: LiveLogStreamEvent[] = []
      let idx = buffer.indexOf("\n\n")
      while (idx >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        let event = "message"
        const dataLines: string[] = []
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length) {
          try {
            out.push({ event, data: JSON.parse(dataLines.join("\n")) } as LiveLogStreamEvent)
          } catch {
            /* skip malformed frame */
          }
        }
        idx = buffer.indexOf("\n\n")
      }
      return out
    },
  }
}

export class LiveLogsHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "LiveLogsHttpError"
    this.status = status
  }
}

/**
 * Open the live stream and dispatch events until it ends or `signal` aborts.
 * Resolves when the server closes the stream; rejects on HTTP/network errors.
 */
export async function openLiveLogStream(options: {
  filter: LiveLogFilter
  after?: string | null
  backfill?: number
  signal: AbortSignal
  onEvent: (event: LiveLogStreamEvent) => void
}): Promise<void> {
  const url = `${apiBase()}/admin/logs/live${buildLogsQuery(options.filter, {
    after: options.after || undefined,
    backfill: options.backfill ?? 300,
  })}`
  const response = await authenticatedFetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    cache: "no-store",
    signal: options.signal,
  })
  if (!response.ok || !response.body) {
    let message = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body && typeof body.message === "string") message = body.message
      else if (body && typeof body.error === "string") message = body.error
    } catch {
      /* ignore */
    }
    throw new LiveLogsHttpError(response.status, message)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createLogStreamParser()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) for (const event of parser.push(decoder.decode(value, { stream: true }))) options.onEvent(event)
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

export async function searchLiveLogs(filter: LiveLogFilter, opts: { limit?: number; before?: string | null } = {}): Promise<{
  lines: LiveLogLine[]
  nextBefore: string | null
  scanned: number
  stream: string
}> {
  const url = `${apiBase()}/admin/logs/search${buildLogsQuery(filter, { limit: opts.limit ?? 200, before: opts.before || undefined })}`
  const response = await authenticatedFetch(url, { method: "GET", cache: "no-store" })
  if (!response.ok) throw new LiveLogsHttpError(response.status, `HTTP ${response.status}`)
  return response.json()
}

export async function fetchRequestLogs(reqId: string): Promise<{ reqId: string; summary: RequestLogsSummary; lines: LiveLogLine[] }> {
  const url = `${apiBase()}/admin/logs/request/${encodeURIComponent(reqId)}`
  const response = await authenticatedFetch(url, { method: "GET", cache: "no-store" })
  if (!response.ok) throw new LiveLogsHttpError(response.status, `HTTP ${response.status}`)
  return response.json()
}

/** Plain-text export (one line per event, body indented) for «Copiar» / download. */
export function formatLinesAsText(lines: LiveLogLine[]): string {
  return lines
    .map((line) => {
      const when = new Date(line.ts).toISOString()
      const who = line.email || line.userId || "-"
      const head = `${when} ${line.level.toUpperCase().padEnd(5)} [${line.source}] ${who} ${line.reqId ? `req=${line.reqId} ` : ""}${line.msg}${line.repeat && line.repeat > 1 ? ` (×${line.repeat})` : ""}`
      return line.body && line.body !== line.msg ? `${head}\n${line.body.replace(/^/gm, "    ")}` : head
    })
    .join("\n")
}
