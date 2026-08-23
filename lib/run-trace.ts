/**
 * RunTrace — single-run state for the chat stepper.
 *
 * Keyed by step_id / tool_call_id (never by label text). Enforces
 * monotonic phases, human Spanish labels, and semantic colors that
 * are independent of the brand red palette.
 */

export const CANONICAL_PHASES = [
  "analizando",
  "leyendo_documento",
  "sintetizando",
  "redactando",
] as const

export type CanonicalPhase = (typeof CANONICAL_PHASES)[number]

export const PHASE_RANK: Record<CanonicalPhase, number> = {
  analizando: 0,
  leyendo_documento: 1,
  sintetizando: 2,
  redactando: 3,
}

export type RunTraceStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled"

export type RunTraceStepStatus = "pending" | "running" | "done" | "failed" | "cancelled"

export const STEP_STATUS_VARS: Record<RunTraceStepStatus, string> = {
  pending: "var(--step-pending)",
  running: "var(--step-running)",
  done: "var(--step-done)",
  failed: "var(--step-failed)",
  cancelled: "var(--step-pending)",
}

export const STEP_STATUS_CLASS: Record<RunTraceStepStatus, string> = {
  pending: "run-trace-step--pending",
  running: "run-trace-step--running",
  done: "run-trace-step--done",
  failed: "run-trace-step--failed",
  cancelled: "run-trace-step--cancelled",
}

/** SSE heartbeat interval the backend emits. Stale UI waits 3 misses. */
export const RUN_TRACE_HEARTBEAT_MS = 15_000
export const RUN_TRACE_STALE_AFTER_MISSED = 3
export const RUN_TRACE_STALE_MS = RUN_TRACE_HEARTBEAT_MS * RUN_TRACE_STALE_AFTER_MISSED
export const RUN_TRACE_MAX_STEPS = 12
export const RUN_TRACE_MAX_TOOL_CALLS = 16

export const HUMAN_TOOL_LABELS: Record<string, string> = {
  web_search: "Buscando fuentes",
  rag_retrieve: "Consultando documentación",
  self_rag_answer: "Sintetizando evidencia",
  create_document: "Generando documento",
  verify_artifact: "Verificando entrega",
  run_tests: "Ejecutando validaciones",
  python_exec: "Procesando datos",
  python: "Procesando datos",
  code_sandbox: "Procesando datos",
  sandbox_exec: "Procesando datos",
  document_pipeline: "Construyendo archivo",
  spreadsheet: "Preparando hoja de cálculo",
  presentation: "Preparando presentación",
  pdf: "Preparando PDF",
  docintel_analyze: "Leyendo el documento",
  docintel_retrieve: "Consultando el documento",
  docintel_extract_tables: "Extrayendo tablas",
  docintel_compare: "Comparando documentos",
  docintelanalyze: "Leyendo el documento",
  docintelretrieve: "Consultando el documento",
  search_docs: "Consultando documentación",
  document_edit: "Editando el documento",
  read_file: "Leyendo el documento",
  read_url: "Leyendo la página",
  browse_page: "Leyendo la página",
}

const PHASE_HINTS: Array<{ phase: CanonicalPhase; re: RegExp }> = [
  { phase: "redactando", re: /final|redact|respuesta|ready|listo|entrega final|preparando respuesta/i },
  { phase: "sintetizando", re: /sintet|evidenc|self_rag|resum|summar/i },
  { phase: "leyendo_documento", re: /docintel|retrieve|rag|leyend|consultand|documento|archivo|pdf|docx|read_file|extract/i },
  { phase: "analizando", re: /analiz|analy|plan|think|thought|pens|bootstrap|preparand/i },
]

export function normalizeToolKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function humanToolLabel(tool?: string | null, fallback = "Procesando tarea"): string {
  const key = normalizeToolKey(tool)
  if (!key) return fallback
  if (HUMAN_TOOL_LABELS[key]) return HUMAN_TOOL_LABELS[key]
  const compact = key.replace(/_/g, "")
  if (HUMAN_TOOL_LABELS[compact]) return HUMAN_TOOL_LABELS[compact]
  return fallback
}

export function inferPhase(input: { label?: string | null; tool?: string | null; reasoning?: string | null }): CanonicalPhase {
  const hay = [input.tool, input.label, input.reasoning].filter(Boolean).join(" ")
  for (const hint of PHASE_HINTS) {
    if (hint.re.test(hay)) return hint.phase
  }
  return "analizando"
}

export function retryLabel(baseLabel: string, attempt: number, maxAttempts = 3): string {
  const clean = String(baseLabel || "Procesando tarea").replace(/\s*·\s*Reintentando\s*\(\d+\/\d+\)\s*$/i, "").trim()
  if (attempt <= 1) return clean
  return `${clean} · Reintentando (${Math.min(attempt, maxAttempts)}/${maxAttempts})`
}

export function descriptionsDiffer(label: string, description?: string | null): boolean {
  const a = String(label || "").replace(/\s+/g, " ").trim().toLowerCase()
  const b = String(description || "").replace(/\s+/g, " ").trim().toLowerCase()
  if (!b) return false
  return a !== b
}

export function collapseSuccessLabel(elapsedSec: number): string {
  const seconds = Math.max(1, Math.round(Number(elapsedSec) || 0))
  return `Analizado en ${seconds} s ✓`
}

export function shouldRenderRunTrace(opts: {
  role?: string | null
  messageId?: string | null
  assistantMessageId?: string | null
}): boolean {
  const role = String(opts.role || "").toUpperCase()
  if (role !== "ASSISTANT") return false
  const expected = String(opts.assistantMessageId || "").trim()
  const actual = String(opts.messageId || "").trim()
  if (!expected || !actual) return true
  if (actual === expected) return true
  // Persist remaps the optimistic client id to a DB id; keep the trace.
  const looksClient = (id: string) => /^(msg-|client-)/i.test(id)
  if (looksClient(expected) !== looksClient(actual)) return true
  return false
}

export function isStaleRun(lastEventAt?: string | number | null, now = Date.now()): boolean {
  if (lastEventAt == null) return false
  const ts = typeof lastEventAt === "number" ? lastEventAt : Date.parse(String(lastEventAt))
  if (!Number.isFinite(ts)) return false
  return now - ts >= RUN_TRACE_STALE_MS
}

export type RunTraceStep = {
  id: string
  label: string
  status: RunTraceStepStatus
  phase: CanonicalPhase
  retryCount: number
  tool?: string | null
  reasoning?: string | null
  description?: string | null
}

export function projectStepRow(step: {
  id: string
  label?: string | null
  status?: string | null
  reasoning?: string | null
  retryCount?: number | null
  tool?: string | null
  toolCalls?: Array<{ tool?: string | null }>
}): { id: string; label: string; description: string | null; status: RunTraceStepStatus; phase: CanonicalPhase; retryCount: number } {
  const firstTool = step.tool || step.toolCalls?.[0]?.tool || null
  const mapped = firstTool ? humanToolLabel(firstTool, "") : ""
  const label = mapped || humanToolLabel(step.label, String(step.label || "Procesando tarea"))
  const retryCount = Math.max(1, Number(step.retryCount) || 1)
  const status: RunTraceStepStatus =
    step.status === "error" || step.status === "failed" ? "failed"
      : step.status === "cancelled" ? "cancelled"
        : step.status === "running" || step.status === "pending" ? "running"
          : "done"
  const rawDescription = typeof step.reasoning === "string" ? step.reasoning.trim() : ""
  const description = descriptionsDiffer(label, rawDescription) ? rawDescription : null
  return {
    id: step.id,
    label: retryLabel(label, retryCount),
    description,
    status,
    phase: inferPhase({ label: step.label || label, tool: firstTool, reasoning: step.reasoning }),
    retryCount,
  }
}

type UpsertableStep = {
  id: string
  label: string
  status?: string
  icon?: string
  reasoning?: string
  toolCalls?: unknown[]
  retryCount?: number
  phase?: CanonicalPhase
}

export function upsertMonotonicStep<T extends UpsertableStep>(steps: T[], incoming: T): T[] {
  const next = Array.isArray(steps) ? [...steps] : []
  const incomingId = String(incoming.id || "").trim()
  if (!incomingId) return next

  const existingIdx = next.findIndex((step) => String(step.id) === incomingId)
  if (existingIdx >= 0) {
    const prev = next[existingIdx]
    next[existingIdx] = {
      ...prev,
      ...incoming,
      id: incomingId,
      retryCount: Math.max(Number(prev.retryCount) || 1, Number(incoming.retryCount) || 1),
      toolCalls: incoming.toolCalls || prev.toolCalls || [],
    }
    return next
  }

  const incomingPhase = incoming.phase || inferPhase(incoming)
  let maxRank = -1
  let maxIdx = -1
  for (let i = 0; i < next.length; i += 1) {
    const rank = PHASE_RANK[next[i].phase || inferPhase(next[i])]
    if (rank >= maxRank) {
      maxRank = rank
      maxIdx = i
    }
  }

  const incomingRank = PHASE_RANK[incomingPhase]
  if (maxIdx >= 0 && incomingRank < maxRank) {
    const current = next[maxIdx]
    const retryCount = (Number(current.retryCount) || 1) + 1
    next[maxIdx] = {
      ...current,
      retryCount,
      status: incoming.status || current.status,
      reasoning: incoming.reasoning || current.reasoning,
    }
    return next
  }

  const last = next[next.length - 1]
  if (last && (last.phase || inferPhase(last)) === incomingPhase && last.status === "running") {
    const retryCount = (Number(last.retryCount) || 1) + 1
    next[next.length - 1] = {
      ...last,
      id: incomingId,
      label: incoming.label || last.label,
      reasoning: incoming.reasoning || last.reasoning,
      retryCount,
      toolCalls: incoming.toolCalls || last.toolCalls || [],
    }
    return next
  }

  next.push({
    ...incoming,
    id: incomingId,
    phase: incomingPhase,
    retryCount: Number(incoming.retryCount) || 1,
    toolCalls: incoming.toolCalls || [],
  })
  return next
}

export function resolveRunStatus(input: {
  done?: boolean
  error?: string | null
  queueStatus?: string | null
}): RunTraceStatus {
  if (input.error === "aborted" || input.queueStatus === "cancelled") return "cancelled"
  if (input.error) return "failed"
  if (input.done || input.queueStatus === "completed") return "succeeded"
  if (input.queueStatus === "queued") return "idle"
  return "running"
}
