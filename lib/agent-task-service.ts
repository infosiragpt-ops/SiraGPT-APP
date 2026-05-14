"use client"

import { streamSseJson } from "./sse-client"

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
  format?: string | null
  sizeBytes: number
  downloadUrl: string
  previewHtml?: string | null
  validation?: Record<string, unknown> | null
}

export interface DocumentPolicy {
  mode: "chat_only" | "doc_suggested" | "doc_required"
  format: "docx" | "xlsx" | "pptx" | "pdf"
  template: string
  complexity?: string
  reason?: string
  autoGenerate?: boolean
  thresholds?: Record<string, unknown>
  palette?: Record<string, unknown>
}

export interface QueueStatus {
  status: "queued" | "running" | "completed" | "cancelled" | "error" | string
  queue?: string
  jobId?: string
  position?: number | null
  estimatedWaitMs?: number | null
  updatedAt?: string
}

export interface AgentFrameworkStatus {
  version?: string
  active?: Record<string, unknown>
  frameworks?: Record<string, any>
}

export interface AgentApprovalState {
  id: string
  status: string
  decision?: "approve" | "reject" | "edit" | string
  tool?: string | null
  action?: string | null
  reason?: string
  payload?: Record<string, unknown> | null
  resolvedBy?: string | null
  ts?: string
}

export type AgentTaskEvent =
  | { type: "queue_status"; taskId?: string; status: QueueStatus["status"]; queue?: string; jobId?: string; position?: number | null; estimatedWaitMs?: number | null; ts?: string; seq?: number }
  | { type: "framework_status"; taskId?: string; version?: string; active?: Record<string, unknown>; frameworks?: Record<string, any>; observability?: Record<string, unknown> | null; ts?: string; seq?: number }
  | { type: "human_approval_required"; taskId?: string; approvalId?: string; tool?: string; action?: string; reason?: string; payload?: Record<string, unknown> | null; ts?: string; seq?: number }
  | { type: "human_approval_resolved"; taskId?: string; approvalId?: string; decision: "approve" | "reject" | "edit" | string; payload?: Record<string, unknown> | null; resolvedBy?: string | null; ts?: string; seq?: number }
  | { type: "checkpoint"; id?: string; label?: string; message?: string; status?: string; payload?: Record<string, unknown> | null; ts?: string; seq?: number }
  | { type: "quality_gate"; id?: string; gate?: string; label?: string; passed: boolean; score?: number | null; overallScore?: number | null; summary?: string; message?: string; payload?: Record<string, unknown> | null; ts?: string; seq?: number }
  | { type: "repair_attempt"; attempt?: number; status?: string; message?: string; ts?: string; seq?: number }
  | { type: "document_policy"; policy?: DocumentPolicy; documentPolicy?: DocumentPolicy; seq?: number }
  | { type: "document_analysis"; analysisIds?: string[]; evidenceRefs?: Array<Record<string, unknown>>; summary?: string; ts?: string; seq?: number }
  | { type: "meta"; taskId?: string; goal: string; model: string; runtimeModel?: string; runtimeProvider?: string; tools: string[]; executionProfile?: Record<string, unknown>; intentAlignmentProfile?: Record<string, unknown>; taskPlan?: Record<string, unknown>; frameworks?: AgentFrameworkStatus }
  | { type: "step_start"; id: string; label: string; icon?: AgenticIcon }
  | { type: "tool_call"; stepId: string; tool: string; preview?: string; language?: string; codePreview?: string }
  | { type: "tool_output"; stepId: string; tool: string; ok: boolean; preview?: string; partial?: boolean }
  | { type: "step_done"; id: string; ok: boolean; summary?: string }
  | { type: "file_artifact"; stepId?: string; artifact: AgentArtifact }
  | { type: "final_text"; markdown: string }
  | { type: "done"; stoppedReason: string; stats: { steps: number; artifacts: number }; dbMessageId?: string | null }
  | { type: "error"; message: string }

export interface AgentTaskRunArgs {
  goal: string
  displayGoal?: string
  systemContract?: string
  files?: string[]
  fileMetadata?: any[]
  chatId?: string
  model?: string
  maxSteps?: number
  maxRuntimeMs?: number
  signal?: AbortSignal
  /**
   * Abort the SSE stream when the server goes silent for this many
   * milliseconds. Protects the chat composer from hanging forever
   * when a worker stalls upstream of the SSE writer (the failure
   * mode that left the spinner spinning during the contract-resolver
   * outage). Default: 90 s — long enough for a single LLM call to
   * finish even on a slow tool turn, short enough that a stuck task
   * surfaces an error within a reasonable wait.
   */
  idleTimeoutMs?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000

export class AgentTaskIdleTimeoutError extends Error {
  readonly code = "idle_timeout"
  constructor(timeoutMs: number) {
    super(`El asistente no envió actualizaciones por ${Math.round(timeoutMs / 1000)} s.`)
    this.name = "AgentTaskIdleTimeoutError"
  }
}

export class AgentTaskEmptyStreamError extends Error {
  readonly code = "empty_stream"
  constructor() {
    super("El asistente cerró la respuesta sin generar texto. Reintenta.")
    this.name = "AgentTaskEmptyStreamError"
  }
}

export function normalizeAgentTaskErrorMessage(err: unknown): string {
  const raw = String((err as any)?.message || err || "Agent task failed")
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(raw)) {
    return "El backend se reinició o se perdió la conexión durante la tarea. Reintenta."
  }
  if (/redis|redis_url/i.test(raw)) {
    return "Runtime agentico no disponible: Redis no está activo."
  }
  if (/idle_timeout|AgentTaskIdleTimeoutError/i.test(raw)) {
    return "El asistente dejó de enviar actualizaciones. Reintenta el pedido."
  }
  if (/empty_stream|AgentTaskEmptyStreamError/i.test(raw)) {
    return "El asistente cerró la respuesta sin generar texto. Reintenta."
  }
  return raw
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function* runIterator(args: AgentTaskRunArgs): AsyncGenerator<AgentTaskEvent> {
  const { signal, idleTimeoutMs, ...body } = args
  const idleMs = typeof idleTimeoutMs === "number" && idleTimeoutMs > 0
    ? idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS

  // Combine the caller's abort signal with our own idle-timeout
  // controller. Either side can stop the read loop without leaving
  // the response body half-read.
  const internal = new AbortController()
  const onUpstreamAbort = () => internal.abort(signal?.reason ?? new DOMException("aborted", "AbortError"))
  if (signal) {
    if (signal.aborted) internal.abort(signal.reason)
    else signal.addEventListener("abort", onUpstreamAbort, { once: true })
  }

  const resp = await fetch(`${API_ROOT}/agent/task`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
    signal: internal.signal,
  }).finally(() => {
    // The signal listener stays attached for the lifetime of the
    // generator — only remove the abort hook here on a fast failure
    // (the response itself never began streaming).
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

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      // Abort the underlying fetch so reader.read() rejects and we
      // exit the loop instead of waiting on a dead socket.
      internal.abort(new AgentTaskIdleTimeoutError(idleMs))
    }, idleMs)
  }

  try {
    armIdleTimer()
    try {
      for await (const event of streamSseJson<AgentTaskEvent>(resp.body, {
        signal: internal.signal,
        // Reset the idle timer on every successful chunk — even an
        // empty heartbeat keeps the stream alive.
        onChunk: armIdleTimer,
      })) {
        yield event
      }
    } catch (err: any) {
      if (timedOut) throw new AgentTaskIdleTimeoutError(idleMs)
      if (signal?.aborted) throw err
      throw err
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (signal) signal.removeEventListener("abort", onUpstreamAbort)
  }
}

export interface AgentTaskState {
  meta?: { taskId?: string; goal?: string; model?: string; runtimeModel?: string; runtimeProvider?: string; tools?: string[]; executionProfile?: Record<string, unknown>; intentAlignmentProfile?: Record<string, unknown>; taskPlan?: Record<string, unknown>; frameworks?: AgentFrameworkStatus }
  steps: Array<{
    id: string
    label: string
    icon?: AgenticIcon
    status: "running" | "done" | "error"
    toolCalls: Array<{
      tool: string
      preview?: string
      language?: string
      codePreview?: string
      output?: { ok: boolean; preview?: string }
    }>
  }>
  artifacts: AgentArtifact[]
  queue?: QueueStatus
  documentPolicy?: DocumentPolicy | null
  documentAnalysisIds?: string[]
  evidenceRefs?: Array<Record<string, unknown>>
  frameworks?: AgentFrameworkStatus | null
  observability?: Record<string, unknown> | null
  approvals: AgentApprovalState[]
  checkpoints: Array<{ id: string; label: string; status: string; payload?: Record<string, unknown> | null; ts?: string }>
  qualityGates: Array<{ id: string; label: string; passed: boolean; score?: number | null; summary?: string; payload?: Record<string, unknown> | null; ts?: string }>
  repairs: Array<{ attempt: number; status: string; message: string; ts?: string }>
  finalText: string
  done: boolean
  stoppedReason?: string
  error?: string
}

export function reduceEvent(state: AgentTaskState, evt: AgentTaskEvent): AgentTaskState {
  switch (evt.type) {
    case "queue_status":
      return {
        ...state,
        queue: {
          status: evt.status,
          queue: evt.queue,
          jobId: evt.jobId,
          position: evt.position ?? null,
          estimatedWaitMs: evt.estimatedWaitMs ?? null,
          updatedAt: evt.ts || new Date().toISOString(),
        },
      }
    case "document_policy":
      return { ...state, documentPolicy: evt.policy || evt.documentPolicy || null }
    case "document_analysis":
      return {
        ...state,
        documentAnalysisIds: Array.from(new Set([
          ...(state.documentAnalysisIds || []),
          ...((evt.analysisIds || []).map(String).filter(Boolean)),
        ])).slice(-20),
        evidenceRefs: [
          ...(state.evidenceRefs || []),
          ...((evt.evidenceRefs || []).filter(Boolean)),
        ].slice(-40),
      }
    case "framework_status":
      return {
        ...state,
        frameworks: { version: evt.version, active: evt.active, frameworks: evt.frameworks },
        observability: evt.observability || state.observability || null,
      }
    case "human_approval_required":
      return {
        ...state,
        approvals: [...(state.approvals || []), {
          id: evt.approvalId || `approval-${(state.approvals || []).length + 1}`,
          status: "pending",
          tool: evt.tool || null,
          action: evt.action || null,
          reason: evt.reason || "",
          payload: evt.payload || null,
          ts: evt.ts,
        }].slice(-20),
      }
    case "human_approval_resolved": {
      const approvalId = evt.approvalId || `approval-${(state.approvals || []).length + 1}`
      const approvals = state.approvals || []
      const found = approvals.some(a => a.id === approvalId)
      const resolved: AgentApprovalState = {
        id: approvalId,
        status: evt.decision || "resolved",
        decision: evt.decision,
        payload: evt.payload || null,
        resolvedBy: evt.resolvedBy || null,
        ts: evt.ts,
      }
      return {
        ...state,
        approvals: found
          ? approvals.map(a => a.id === approvalId ? { ...a, ...resolved } : a)
          : [...approvals, resolved].slice(-20),
      }
    }
    case "checkpoint":
      return {
        ...state,
        checkpoints: [...(state.checkpoints || []), {
          id: evt.id || `checkpoint-${(state.checkpoints || []).length + 1}`,
          label: evt.label || evt.message || "Checkpoint",
          status: evt.status || "saved",
          ts: evt.ts,
        }].slice(-20),
      }
    case "quality_gate":
      return {
        ...state,
        qualityGates: [...(state.qualityGates || []), {
          id: evt.id || `quality-${(state.qualityGates || []).length + 1}`,
          label: evt.label || evt.gate || "Validación",
          passed: Boolean(evt.passed),
          score: evt.score ?? evt.overallScore ?? null,
          summary: evt.summary || evt.message || "",
          ts: evt.ts,
        }].slice(-20),
      }
    case "repair_attempt":
      return {
        ...state,
        repairs: [...(state.repairs || []), {
          attempt: evt.attempt || (state.repairs || []).length + 1,
          status: evt.status || "running",
          message: evt.message || "Reparación automática",
          ts: evt.ts,
        }].slice(-10),
      }
    case "meta":
      return {
        ...state,
        meta: {
          taskId: evt.taskId,
          goal: evt.goal,
          model: evt.model,
          runtimeModel: evt.runtimeModel,
          runtimeProvider: evt.runtimeProvider,
          tools: evt.tools,
        },
      }
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
            ? { ...s, toolCalls: [...s.toolCalls, { tool: evt.tool }] }
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
          toolCalls: [{ tool: evt.tool }],
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
              calls[i] = { ...calls[i], output: { ok: evt.ok } }
              attached = true
              break
            }
          }
          if (!attached) calls.push({ tool: evt.tool, output: { ok: evt.ok } })
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
  approvals: [],
  checkpoints: [],
  qualityGates: [],
  repairs: [],
  documentAnalysisIds: [],
  evidenceRefs: [],
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
  let state: AgentTaskState = { ...initialAgentState, steps: [], artifacts: [], approvals: [], checkpoints: [], qualityGates: [], repairs: [] }
  try {
    for await (const evt of runIterator(args)) {
      cbs.onEvent?.(evt)
      state = reduceEvent(state, evt)
      cbs.onStateChange?.(state)
    }
    // The SSE socket closed cleanly. Two failure shapes still need
    // to surface to the user instead of leaving the message bubble
    // empty:
    //   1. Stream emitted no terminal `done`/`error` event.
    //   2. Stream emitted `done` but never produced text or files
    //      (the worker decided it was finalized but had nothing to
    //      hand back — the contract-resolver outage hit this path).
    if (!state.done) {
      state = { ...state, done: true, error: state.error || "stream_closed_without_done" }
    }
    if (!state.error && !state.finalText.trim() && state.artifacts.length === 0) {
      state = { ...state, error: "empty_response" }
    }
    cbs.onFinal?.(state)
    return state
  } catch (err: any) {
    if (args.signal?.aborted) {
      state = { ...state, done: true, error: "aborted" }
      cbs.onFinal?.(state)
      return state
    }
    const wrapped = err instanceof Error ? err : new Error(String(err?.message || err))
    state = { ...state, done: true, error: (err as any)?.code || wrapped.message || "stream_error" }
    cbs.onError?.(wrapped)
    cbs.onFinal?.(state)
    return state
  }
}

export async function cancelTask(taskId: string): Promise<{ ok: boolean; taskId?: string; status?: string; error?: string }> {
  const resp = await fetch(`${API_ROOT}/agent/task/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
  })
  let payload: any = null
  try {
    payload = await resp.json()
  } catch {
    payload = null
  }
  if (!resp.ok) {
    return { ok: false, error: payload?.error || `HTTP ${resp.status}` }
  }
  return { ok: true, taskId: payload?.taskId, status: payload?.status }
}

export async function retryTask(taskId: string): Promise<{ ok: boolean; taskId?: string; jobId?: string; status?: string; queue?: string; error?: string }> {
  const resp = await fetch(`${API_ROOT}/agent/task/${encodeURIComponent(taskId)}/retry`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
  })
  let payload: any = null
  try { payload = await resp.json() } catch { payload = null }
  if (!resp.ok) return { ok: false, error: payload?.error || `HTTP ${resp.status}` }
  return { ok: true, taskId: payload?.taskId, jobId: payload?.jobId, status: payload?.status, queue: payload?.queue }
}

export async function resolveApproval(
  taskId: string,
  decision: "approve" | "reject" | "edit",
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; taskId?: string; approvalId?: string; decision?: string; error?: string }> {
  const resp = await fetch(`${API_ROOT}/agent/task/${encodeURIComponent(taskId)}/approval`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ decision, payload }),
  })
  let data: any = null
  try { data = await resp.json() } catch { data = null }
  if (!resp.ok) return { ok: false, error: data?.error || `HTTP ${resp.status}` }
  return { ok: true, taskId: data?.taskId, approvalId: data?.approvalId, decision: data?.decision }
}

export async function getTaskEvents(taskId: string, after = 0): Promise<{ ok: boolean; events: AgentTaskEvent[]; status?: string; streamState?: AgentTaskState; error?: string }> {
  const resp = await fetch(`${API_ROOT}/agent/task/${encodeURIComponent(taskId)}/events?after=${encodeURIComponent(String(after))}`, {
    method: "GET",
    credentials: "include",
    headers: { ...authHeader() },
  })
  let payload: any = null
  try { payload = await resp.json() } catch { payload = null }
  if (!resp.ok) return { ok: false, events: [], error: payload?.error || `HTTP ${resp.status}` }
  return { ok: true, events: payload?.events || [], status: payload?.status, streamState: payload?.streamState }
}

export const agentTaskService = { runIterator, runStream, reduceEvent, initialAgentState, cancelTask, retryTask, resolveApproval, getTaskEvents }
