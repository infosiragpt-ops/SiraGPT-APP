"use client"

/**
 * agent-stream-service — async-generator client for /api/agent/run's
 * SSE stream.
 *
 * The route emits events shaped as `{type, ...payload}`. This module
 * yields them as a typed discriminated union so UI code can narrow
 * with exhaustive `switch` instead of hand-rolling shape checks.
 *
 * Uses fetch + ReadableStream (not EventSource) because EventSource
 * can't POST or set Authorization headers, both of which this route
 * needs.
 *
 * Abort: pass a signal to cancel mid-run. The server propagates the
 * disconnect to the orchestrator's AbortController, stopping any
 * in-flight LLM/CrossRef/OpenAlex call so the user doesn't burn
 * tokens after closing the tab.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export type AgentThinking = "low" | "medium" | "high"

export interface PlanStep {
  step: number
  goal: string
  tool_hint: string | null
}

export interface ReactAgentTrace {
  step: number
  thought: string
  actions?: Array<{
    tool: string
    args: string
    observation: unknown
  }>
}

export type AgentEvent =
  | { type: "policy"; hidden: Array<{ id: string; reason: string }>; mode: string }
  | { type: "plan"; phase: "plan"; plan: PlanStep[]; rationale: string }
  | { type: "step"; phase: "step"; plan_step: number; trace: ReactAgentTrace }
  | { type: "replan"; phase: "replan"; plan: PlanStep[]; rationale: string }
  | { type: "synthesis"; phase: "synthesis" }
  | {
      type: "final"
      answer: string
      stoppedReason: string
      plan?: PlanStep[]
      replans?: number
    }
  | { type: "error"; error: string }
  // Legacy low-thinking events (plain ReAct, not planner/executor)
  | { type: "step"; step: ReactAgentTrace }

export interface AgentRunArgs {
  query: string
  thinking?: AgentThinking
  useSkills?: boolean
  skillIds?: string[] | null
  mode?: "main" | "sandbox"
  maxSteps?: number
  model?: string
  collection?: string
  signal?: AbortSignal
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Yields agent events as they arrive. The generator completes when
 * the stream closes or the signal is aborted.
 */
export async function* runAgent(args: AgentRunArgs): AsyncGenerator<AgentEvent> {
  const body = {
    query: args.query,
    thinking: args.thinking || "medium",
    useSkills: args.useSkills !== false,
    skillIds: args.skillIds || undefined,
    mode: args.mode || undefined,
    maxSteps: args.maxSteps || undefined,
    model: args.model || undefined,
    collection: args.collection || undefined,
  }
  const resp = await fetch(`${API_ROOT}/agent/run`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
    signal: args.signal,
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try { const j = await resp.json(); msg = j.error || msg } catch { /* */ }
    throw new Error(msg)
  }
  if (!resp.body) throw new Error("Stream body missing")

  const reader = resp.body.getReader()
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
      const payload = raw
        .split("\n")
        .filter(l => l.startsWith("data: "))
        .map(l => l.slice(6))
        .join("\n")
      if (!payload) continue
      try {
        yield JSON.parse(payload) as AgentEvent
      } catch {
        /* malformed frame — skip */
      }
    }
  }
}
