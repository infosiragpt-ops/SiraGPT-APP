"use client"

/**
 * agent-task-service — SSE adapter for POST /api/agent/task.
 *
 * The endpoint emits a structured "step card" event stream that the
 * UI consumes to render Claude-style collapsible tiles. We expose:
 *   - runIterator: low-level async generator (for any caller that
 *     wants to drive its own state machine)
 *   - runStream:   callback adapter (used by chat-interface to keep
 *     a single message bubble in sync)
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export type AgenticIcon = "python" | "bash" | "search" | "doc" | "verify" | "thought" | "check"

export interface AgentArtifact {
  id: string
  filename: string
  mime: string
  sizeBytes: number
  downloadUrl: string
}

export type AgentTaskEvent =
  | { type: "meta"; goal: string; model: string; tools: string[] }
  | { type: "step_start"; id: string; label: string; icon?: AgenticIcon }
  | { type: "tool_call"; stepId: string; tool: string; preview: string; language?: string; codePreview?: string }
  | { type: "tool_output"; stepId: string; tool: string; ok: boolean; preview: string; partial?: boolean }
  | { type: "step_done"; id: string; ok: boolean; summary?: string }
  | { type: "file_artifact"; stepId?: string; artifact: AgentArtifact }
  | { type: "final_text"; markdown: string }
  | { type: "done"; stoppedReason: string; stats: { steps: number; artifacts: number }; dbMessageId?: string | null }
  | { type: "error"; message: string }

export interface AgentTaskRunArgs {
  goal: string
  chatId?: string
  model?: string
  maxSteps?: number
  maxRuntimeMs?: number
  signal?: AbortSignal
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function* runIterator(args: AgentTaskRunArgs): AsyncGenerator<AgentTaskEvent> {
  const { signal, ...body } = args
  const resp = await fetch(`${API_ROOT}/agent/task`, {
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
      if (j?.error) msg = j.error
      else if (j?.errors?.[0]?.msg) msg = j.errors[0].msg
    } catch { /* non-JSON */ }
    throw new Error(msg)
  }
  if (!resp.body) throw new Error("Stream body missing")

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLine = raw.split("\n").find(l => l.startsWith("data: "))
        if (!dataLine) continue
        try {
          yield JSON.parse(dataLine.slice(6)) as AgentTaskEvent
        } catch { /* malformed frame */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

export interface AgentTaskState {
  meta?: { goal: string; model: string; tools: string[] }
  steps: Array<{
    id: string
    label: string
    icon?: AgenticIcon
    status: "running" | "done" | "error"
    toolCalls: Array<{
      tool: string
      preview: string
      language?: string
      codePreview?: string
      output?: { ok: boolean; preview: string }
    }>
  }>
  artifacts: AgentArtifact[]
  finalText: string
  done: boolean
  stoppedReason?: string
  error?: string
}

export function reduceEvent(state: AgentTaskState, evt: AgentTaskEvent): AgentTaskState {
  switch (evt.type) {
    case "meta":
      return { ...state, meta: { goal: evt.goal, model: evt.model, tools: evt.tools } }
    case "step_start":
      return {
        ...state,
        steps: [...state.steps, {
          id: evt.id,
          label: evt.label,
          icon: evt.icon,
          status: "running",
          toolCalls: [],
        }],
      }
    case "tool_call": {
      const callStepId = evt.stepId || `tool-${state.steps.length + 1}`
      const callSteps = state.steps.some(s => s.id === callStepId)
        ? state.steps
        : [...state.steps, {
          id: callStepId,
          label: evt.tool,
          icon: "thought" as AgenticIcon,
          status: "running" as const,
          toolCalls: [],
        }]
      return {
        ...state,
        steps: callSteps.map(s =>
          s.id === callStepId
            ? { ...s, toolCalls: [...s.toolCalls, { tool: evt.tool, preview: evt.preview, language: evt.language, codePreview: evt.codePreview }] }
            : s
        ),
      }
    }
    case "tool_output": {
      const outputStepId = evt.stepId || `tool-${state.steps.length + 1}`
      const outputSteps = state.steps.some(s => s.id === outputStepId)
        ? state.steps
        : [...state.steps, {
          id: outputStepId,
          label: evt.tool,
          icon: "thought" as AgenticIcon,
          status: "running" as const,
          toolCalls: [{ tool: evt.tool, preview: "" }],
        }]
      return {
        ...state,
        steps: outputSteps.map(s => {
          if (s.id !== outputStepId) return s
          const calls = [...s.toolCalls]
          // Attach the output to the most recent unattached call for this tool.
          let attached = false
          for (let i = calls.length - 1; i >= 0; i--) {
            if (calls[i].tool === evt.tool && !calls[i].output) {
              calls[i] = { ...calls[i], output: { ok: evt.ok, preview: evt.preview } }
              attached = true
              break
            }
          }
          if (!attached) calls.push({ tool: evt.tool, preview: "", output: { ok: evt.ok, preview: evt.preview } })
          return { ...s, toolCalls: calls }
        }),
      }
    }
    case "step_done":
      return {
        ...state,
        steps: state.steps.map(s =>
          s.id === evt.id ? { ...s, status: evt.ok ? "done" : "error" } : s
        ),
      }
    case "file_artifact":
      return { ...state, artifacts: [...state.artifacts, evt.artifact] }
    case "final_text":
      return { ...state, finalText: evt.markdown }
    case "done":
      return { ...state, done: true, stoppedReason: evt.stoppedReason }
    case "error":
      return { ...state, done: true, error: evt.message }
    default:
      return state
  }
}

export const initialAgentState: AgentTaskState = {
  steps: [],
  artifacts: [],
  finalText: "",
  done: false,
}

export interface RunStreamCallbacks {
  onEvent?: (evt: AgentTaskEvent) => void
  onStateChange?: (state: AgentTaskState) => void
  onFinal?: (state: AgentTaskState) => void
  onError?: (err: Error) => void
}

export async function runStream(args: AgentTaskRunArgs, cbs: RunStreamCallbacks = {}): Promise<AgentTaskState> {
  let state: AgentTaskState = { ...initialAgentState, steps: [], artifacts: [] }
  try {
    for await (const evt of runIterator(args)) {
      cbs.onEvent?.(evt)
      state = reduceEvent(state, evt)
      cbs.onStateChange?.(state)
    }
    cbs.onFinal?.(state)
    return state
  } catch (err: any) {
    if (args.signal?.aborted) {
      state = { ...state, done: true, error: "aborted" }
      cbs.onFinal?.(state)
      return state
    }
    cbs.onError?.(err instanceof Error ? err : new Error(String(err?.message || err)))
    throw err
  }
}

export const agentTaskService = { runIterator, runStream, reduceEvent, initialAgentState }
