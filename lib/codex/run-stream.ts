// codex/run-stream — client for GET /api/codex/runs/:id/stream (feature 10).
// Uses a fetch ReadableStream (not EventSource) so we control reconnection with
// the last-seen seq and exponential backoff. The frame parser is a pure,
// testable unit; the open loop wires it to fetch + the timeline reducer.

import type { CodexEventEnvelope } from './timeline-reducer'
import { createAuthenticatedFetch } from '../authenticated-fetch'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api').replace(/\/+$/, '')
const TERMINAL = new Set(['done', 'error', 'cancelled'])

/**
 * Is an HTTP status worth reconnecting for? Transient (network/5xx/429/503) →
 * yes, retry with backoff. Permanent client errors (404 run-not-found, 401/403
 * auth) → no: reconnecting forever would hammer the server. Mirrors the repo
 * convention in lib/api.ts (4xx hard-fail except 429/503).
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** Stateful SSE frame parser: feed raw chunks, get parsed envelopes. */
export function createSSEParser() {
  let buffer = ''
  return {
    push(chunk: string): CodexEventEnvelope[] {
      // Normalise CRLF → LF up front so the blank-line frame separator is always
      // "\n\n" regardless of how the server/proxy framed it.
      buffer += chunk.replace(/\r\n/g, '\n')
      const out: CodexEventEnvelope[] = []
      let idx: number
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (!json) continue
          try { out.push(JSON.parse(json)) } catch { /* skip malformed frame */ }
        }
      }
      return out
    },
  }
}

export interface RunStreamOptions {
  runId: string
  afterSeq?: number
  onEvent: (e: CodexEventEnvelope) => void
  onStatus?: (status: string) => void
  onError?: (err: unknown) => void
  fetchImpl?: typeof fetch
  token?: string | null
  baseUrl?: string
  maxBackoffMs?: number
  /** Statuses that end the stream (resolve `done`). Defaults to the run's hard
   *  terminal states. A PLAN run parks forever at `waiting_approval` (approval
   *  spawns a NEW build run), so auto-approving consumers like the /code chat
   *  engine add it here; the human-gated Codex panel keeps the default. */
  terminalStatuses?: readonly string[]
}

export interface RunStreamHandle {
  close: () => void
  /** Resolves when the stream ends (terminal or closed). */
  done: Promise<void>
}

function getToken(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit
  if (typeof window !== 'undefined') return localStorage.getItem('auth-token')
  return null
}

/**
 * Open a resumable run stream. Reconnects with backoff from the last seq until
 * a terminal run_status arrives or close() is called.
 */
export function openRunStream(opts: RunStreamOptions): RunStreamHandle {
  const { runId, onEvent, onStatus, onError } = opts
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : undefined)
  const baseUrl = (opts.baseUrl || API_BASE).replace(/\/+$/, '')
  const token = getToken(opts.token)
  const transport = fetchImpl
    ? createAuthenticatedFetch({ apiBaseUrl: baseUrl, fetchImpl, getBearerToken: () => token })
    : null
  const maxBackoff = opts.maxBackoffMs ?? 10_000

  let closed = false
  let lastSeq = opts.afterSeq ?? 0
  let attempt = 0
  let controller: AbortController | null = null
  const terminalSet = opts.terminalStatuses ? new Set(opts.terminalStatuses) : TERMINAL

  const done = (async () => {
    if (!fetchImpl) { onError?.(new Error('fetch unavailable')); return }
    while (!closed) {
      controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      try {
        // Auth travels ONLY in the Authorization header — we always stream via
        // fetch (never native EventSource), so the JWT must not leak into the
        // query string (proxy/server logs). The backend keeps a `?token=`
        // fallback for clients that can't set headers; we don't use it.
        const qs = new URLSearchParams({ afterSeq: String(lastSeq) })
        const res = await transport!(`${baseUrl}/codex/runs/${encodeURIComponent(runId)}/stream?${qs.toString()}`, {
          signal: controller.signal,
        }, {
          bearerToken: token,
        })
        if (!res.ok || !res.body) {
          // Permanent client error (404 not-found, 401/403 auth) — surface once
          // and stop, instead of an unbounded reconnect storm against a dead URL.
          if (!isRetryableStatus(res.status)) {
            if (!closed) onError?.(new Error(`stream http ${res.status}`))
            return
          }
          throw new Error(`stream http ${res.status}`)
        }
        attempt = 0
        reader = (res.body as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()
        const parser = createSSEParser()
        let terminal = false
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done: rdone, value } = await reader.read()
          if (rdone) break
          for (const e of parser.push(decoder.decode(value, { stream: true }))) {
            if (typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq
            if (e.type === 'run_status' && onStatus) onStatus(e.data?.status)
            if (e.type !== 'heartbeat') onEvent(e)
            if (e.type === 'run_status' && terminalSet.has(e.data?.status)) terminal = true
          }
          // Exit as soon as a terminal status is SEEN — the server only closes
          // the socket on its own hard-terminal set, so a custom status like
          // waiting_approval would otherwise park this read() on heartbeats
          // forever (the connection stays open server-side).
          if (terminal) break
        }
        if (terminal || closed) {
          try { controller?.abort() } catch { /* already closed */ }
          return
        }
      } catch (err) {
        if (closed) return
        onError?.(err)
      } finally {
        // Release the lock so a reconnect can re-read; abort cancels the body.
        try { reader?.releaseLock() } catch { /* already released */ }
      }
      // Backoff before reconnecting.
      attempt += 1
      const delay = Math.min(maxBackoff, 250 * 2 ** Math.min(attempt, 6))
      await new Promise((r) => setTimeout(r, delay))
    }
  })()

  return {
    close() { closed = true; controller?.abort() },
    done,
  }
}
