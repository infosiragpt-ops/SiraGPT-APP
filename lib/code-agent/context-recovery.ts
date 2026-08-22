/**
 * code-agent · context recovery (pure).
 *
 * Frente 3 — Recuperación de contexto: when a long /code session exceeds the
 * model context window (long runs are the norm: DEFAULT_MAX_ITERATIONS = 20,
 * timeout 60 min), the next iteration must resume coherently WITHOUT losing
 * the original plan.
 *
 * Everything here is DETERMINISTIC and conservative — regex/passes only, no
 * tokenizer, no network, no React — mirroring the house style of the rest of
 * lib/code-agent (orchestrator/autonomy/quality-gate) so it stays fully
 * testable with `node --test`.
 *
 * Hard rules:
 *   1. The ORIGINAL plan is NEVER dropped: compactContext() preserves it
 *      whole (all keys, untouched values) and buildRecoveryPrompt() prints it
 *      complete in every recovery prompt.
 *   2. Tasks are never dropped either: every task keeps id/title/status; only
 *      long `detail` texts are shortened with an explicit "…[truncated]"
 *      marker.
 *   3. Transcript: the most recent messages (default K = 10) and the first
 *      ones (origin of the brief) are kept verbatim; the middle collapses
 *      into a deterministic list of "hechos" (facts) extracted by simple
 *      regex (action lines, created/edited file paths, resolved errors).
 *
 * Integration point: the /code panel builds the next-iteration context in
 * sendPrompt() (ai-code-chat-panel.tsx). There, shouldCompactContext() gates
 * the swap from the naive "last 12 messages" slice to
 * buildRecoveryPrompt(originalBrief, compactContext(...)).
 */

// ---- public shapes ----------------------------------------------------------

/** Minimal transcript turn the recovery helpers understand. */
export interface ContextRecoveryTurn {
  role: string
  content: string
}

/** Loose plan shape (AgentBuildContext and anything richer) preserved whole. */
export type PlanLike = Record<string, unknown>

export interface RecoveryTaskSnapshot {
  id: string
  title: string
  status: string
  /** Short description; long values end with the TRUNCATION_MARKER. */
  detail: string
  files?: string[]
}

export interface CompactionOptions {
  /** Recent messages kept verbatim at the tail (default 10). */
  recentCount?: number
  /** First messages kept verbatim (origin of the brief, default 2). */
  headCount?: number
  /** Max chars of a task `detail` before truncation (default 160). */
  maxTaskDetailChars?: number
}

export interface CompactedContext {
  /**
   * Self-contained Markdown block: dropped-count, extracted facts, full task
   * state and the verbatim head+tail messages. Ready to inject as-is.
   */
  summaryPromptBlock: string
  /** The original plan, preserved INTACT (hard requirement). */
  preservedPlan: PlanLike
  /** How many middle messages were summarized away. */
  droppedCount: number
  /** Snapshot of ALL tasks (id/title/status/detail) in original order. */
  tasks: RecoveryTaskSnapshot[]
  /** Human-readable line of the first task that is NOT completed, if any. */
  nextTaskLine: string | null
}

// ---- tunables ---------------------------------------------------------------

/** Tail messages kept verbatim (the "K most recent" rule). */
export const DEFAULT_RECENT_MESSAGES = 10

/** Head messages kept verbatim (origin of the brief/user request). */
export const DEFAULT_HEAD_MESSAGES = 2

/** Task details longer than this get cut with the truncation marker. */
export const DEFAULT_MAX_TASK_DETAIL_CHARS = 160

/** Explicit marker appended to every shortened text. Never silent cuts. */
export const TRUNCATION_MARKER = "…[truncated]"

/**
 * Approximate context-window budget (tokens) for the /code conversation
 * history. Deliberately conservative vs typical 128k windows because the
 * system prompt, workspace context and generated files ride in the same
 * request. Env-overridable like the rest of the chain (subagent.ts style).
 */
export const CODE_CONTEXT_TOKEN_LIMIT = Number(process.env.CODE_CONTEXT_TOKEN_LIMIT || 24_000)

/** Global cap on extracted facts so the summary cannot grow unbounded. */
export const MAX_FACTS_TOTAL = 40

/** Per-message cap on extracted facts. */
export const MAX_FACTS_PER_MESSAGE = 3

/** Max chars of a single extracted fact line. */
export const FACT_MAX_CHARS = 200

/** Safety cap per KEPT (head/tail) message; oversized bubbles get the marker. */
export const KEPT_MESSAGE_MAX_CHARS = 2400

// ---- token estimation -------------------------------------------------------

function contentOf(item: string | { content?: unknown }): string {
  if (typeof item === "string") return item
  const content = item?.content
  return typeof content === "string" ? content : ""
}

/**
 * Deterministic token approximation: ~4 characters per token, rounded up.
 * Monotonic (more/longer items never yield fewer tokens) and dependency-free
 * — good enough to gate compaction without shipping a tokenizer.
 */
export function estimateContextTokens(items: ReadonlyArray<string | { content?: unknown }>): number {
  let chars = 0
  for (const item of items || []) chars += contentOf(item).length
  return Math.ceil(chars / 4)
}

/**
 * True when the estimated history size crosses the token limit. Strictly
 * greater: AT the limit there is still room (conservative = compact late,
 * never waste a good window).
 */
export function shouldCompactContext(
  items: ReadonlyArray<string | { content?: unknown }>,
  limitTokens: number = CODE_CONTEXT_TOKEN_LIMIT,
): boolean {
  const limit = Number.isFinite(limitTokens) && limitTokens > 0 ? limitTokens : CODE_CONTEXT_TOKEN_LIMIT
  return (items?.length || 0) > 0 && estimateContextTokens(items) > limit
}

// ---- deterministic fact extraction -----------------------------------------

/** Lines that START with a build/edit action stem ("crea…", "añadí…"). */
const ACTION_LINE_RE =
  /^\s*(?:[-*•]\s*)?(?:cre\w*|modifi\w*|agreg\w*|a[nñ]ad\w*|edit\w*|corr\w*|arregl\w*|implement\w*|gener\w*|actuali\w*|elimin\w*|borr\w*|instal\w*|configur\w*|cambi\w*|escrib\w*|constru\w*|dise[nñ]\w*|refactor\w*|migr\w*)\b/i

/** Workspace file paths worth remembering (created, edited or promised). */
const FILE_PATH_RE =
  /(?:[\w.@/-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json|prisma|md|html|sql|ya?ml|env)\b/

/** Error signals and their resolutions ("arreglado", "resuelto", fixed…). */
const ERROR_SIGNAL_RE =
  /\b(?:error|fallo|fall[óo]|exception|traceback|ERESOLVE|EINTEGRITY|ENOENT|Module not found|Cannot find module|exit code|timeout|resuelt[oa]|corregid[oa]|arreglad[oa]|fixed)\b/i

function truncateWithMarker(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= maxChars) return flat
  return flat.slice(0, Math.max(0, maxChars)) + TRUNCATION_MARKER
}

function isNoiseLine(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (/^(```|```[\w.]*\s*[\w./-]*$)/.test(t)) return true // fences / fence headers
  if (/^[¡!¿?.,;:\s]+$/.test(t)) return true
  return false
}

/**
 * Extract up to MAX_FACTS_PER_MESSAGE deterministic "hechos" from one middle
 * message: lines starting with an action verb, carrying a workspace file
 * path, or carrying an error/resolution signal.
 */
function extractFactsFromMessage(content: string, out: string[]): void {
  if (!content || out.length >= MAX_FACTS_TOTAL) return
  let taken = 0
  for (const rawLine of content.split("\n")) {
    if (taken >= MAX_FACTS_PER_MESSAGE || out.length >= MAX_FACTS_TOTAL) break
    if (isNoiseLine(rawLine)) continue
    const line = rawLine.trim()
    if (!(ACTION_LINE_RE.test(line) || FILE_PATH_RE.test(line) || ERROR_SIGNAL_RE.test(line))) continue
    const fact = truncateWithMarker(line, FACT_MAX_CHARS)
    const bullet = `- ${fact}`
    if (out.includes(bullet)) continue
    out.push(bullet)
    taken += 1
  }
}

/**
 * Collapse the dropped MIDDLE of the transcript into a deterministic list of
 * "hechos" (oldest first, capped).
 */
export function extractFacts(middleMessages: ReadonlyArray<ContextRecoveryTurn>): string[] {
  const facts: string[] = []
  for (const msg of middleMessages || []) {
    if (!msg || facts.length >= MAX_FACTS_TOTAL) continue
    extractFactsFromMessage(String(msg.content || ""), facts)
  }
  return facts
}

// ---- plan / task rendering ---------------------------------------------------

/** Render the plan as stable "key: value" lines (insertion order). */
function renderPlan(plan: PlanLike): string[] {
  const entries = Object.entries(plan || {})
  if (entries.length === 0) return ["(plan vacío — usa el BRIEF ORIGINAL como fuente de verdad)"]
  const lines: string[] = []
  for (const [key, value] of entries) {
    if (value == null) {
      lines.push(`- ${key}: (sin definir)`)
      continue
    }
    if (typeof value === "string") {
      lines.push(`- ${key}: ${truncateWithMarker(value, 300)}`)
      continue
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`- ${key}: ${String(value)}`)
      continue
    }
    try {
      lines.push(`- ${key}: ${truncateWithMarker(JSON.stringify(value), 300)}`)
    } catch {
      lines.push(`- ${key}: (valor no serializable)`)
    }
  }
  return lines
}

/**
 * Snapshot ALL tasks preserving id/title/status; long details are shortened
 * WITH the explicit marker (never silently). Order is preserved.
 */
export function snapshotTasks(
  tasks: ReadonlyArray<{ id?: unknown; title?: unknown; status?: unknown; detail?: unknown; files?: unknown }> | undefined,
  maxDetailChars: number = DEFAULT_MAX_TASK_DETAIL_CHARS,
): RecoveryTaskSnapshot[] {
  return (tasks || []).map((task, index) => ({
    id: String(task?.id ?? `task-${index}`),
    title: truncateWithMarker(String(task?.title ?? "(sin título)"), 120),
    status: String(task?.status ?? "pending"),
    detail: truncateWithMarker(String(task?.detail ?? ""), maxDetailChars),
    ...(Array.isArray(task?.files) ? { files: task.files.map((f) => String(f)) } : {}),
  }))
}

/** "primer task no-done": first task whose status is NOT "completed". */
export function firstUncompletedTask(tasks: ReadonlyArray<RecoveryTaskSnapshot>): RecoveryTaskSnapshot | null {
  return (tasks || []).find((task) => task.status !== "completed") || null
}

function renderTaskLines(tasks: ReadonlyArray<RecoveryTaskSnapshot>): string[] {
  return tasks.map((task, index) => {
    const files = task.files && task.files.length > 0 ? ` · archivos: ${task.files.join(", ")}` : ""
    const detail = task.detail ? ` — ${task.detail}` : ""
    return `${index + 1}. [${task.status}] ${task.id} — ${task.title}${detail}${files}`
  })
}

// ---- compaction --------------------------------------------------------------

function renderKeptMessage(role: string, content: string): string {
  const who = role === "user" ? "Usuario" : "Asistente"
  const body = truncateWithMarker(content, KEPT_MESSAGE_MAX_CHARS)
  return `${who}: ${body}`
}

/**
 * Compact a long session into a self-contained recovery block.
 *
 * Deterministic rules:
 *   - plan: preserved WHOLE (same keys and values, copied — never mutated).
 *   - tasks: ALL preserved (id/title/status); long details truncated with
 *     "…[truncated]".
 *   - transcript: head (origin of the brief) + K most recent kept verbatim;
 *     the middle becomes regex-extracted facts.
 */
export function compactContext(
  plan: PlanLike | undefined,
  tasks: ReadonlyArray<Record<string, unknown>> | undefined,
  transcript: ReadonlyArray<ContextRecoveryTurn>,
  opts?: CompactionOptions,
): CompactedContext {
  const recentCount = Math.max(0, opts?.recentCount ?? DEFAULT_RECENT_MESSAGES)
  const headCount = Math.max(0, opts?.headCount ?? DEFAULT_HEAD_MESSAGES)

  const cleanTranscript = (transcript || []).filter(
    (t) => !!t && typeof t.content === "string" && t.content.trim().length > 0,
  )

  // Nothing to drop when head + recent already cover the whole transcript.
  const keepTail = Math.min(recentCount, cleanTranscript.length)
  const tailStart = Math.max(headCount, cleanTranscript.length - keepTail)
  const head = cleanTranscript.slice(0, Math.min(headCount, tailStart))
  const tail = cleanTranscript.slice(tailStart)
  const middle = cleanTranscript.slice(head.length, tailStart)
  const droppedCount = middle.length

  // Hard requirement: the original plan survives INTACT (copied, not mutated).
  const preservedPlan: PlanLike = { ...(plan || {}) }

  const taskSnapshots = snapshotTasks(tasks, opts?.maxTaskDetailChars)
  const taskLines = renderTaskLines(taskSnapshots)
  const facts = extractFacts(middle)
  const nextTask = firstUncompletedTask(taskSnapshots)
  const nextTaskLine = nextTask
    ? `[${nextTask.status}] ${nextTask.id} — ${nextTask.title}`
    : null

  const completedCount = taskSnapshots.filter((t) => t.status === "completed").length
  const block: string[] = [
    "[CONTEXTO RECUPERADO · SESIÓN LARGA COMPACTADA]",
    `Se compactó el historial para caber en la ventana de contexto. Mensajes intermedios omitidos: ${droppedCount}.`,
    "",
    "ESTADO DE LAS TAREAS (NUNCA se omite ninguna):",
    `Total: ${taskSnapshots.length} tareas · completadas: ${completedCount}`,
    ...(taskLines.length > 0 ? taskLines : ["(sin tareas registradas)"]),
    "",
    "PLAN PRESERVADO (COMPLETO):",
    ...renderPlan(preservedPlan),
    "",
    "HECHOS DEL TRAMO OMITIDO:",
    ...(facts.length > 0 ? facts : ["(sin hechos extraídos del tramo omitido)"]),
    "",
    "MENSAJES CONSERVADOS (inicio y fin del historial, verbatim):",
    ...[...head, ...tail].map((t) => renderKeptMessage(t.role, t.content)),
  ]

  return {
    summaryPromptBlock: block.join("\n"),
    preservedPlan,
    droppedCount,
    tasks: taskSnapshots,
    nextTaskLine,
  }
}

// ---- recovery prompt -----------------------------------------------------------

/**
 * Build the ready-to-inject prompt for the next iteration after compaction:
 * original brief + FULL preserved plan + task state + recovered facts + an
 * explicit "continue from the first non-completed task" instruction.
 */
export function buildRecoveryPrompt(originalBrief: string, compacted: CompactedContext): string {
  const tasks = compacted.tasks || []
  const nextTask = firstUncompletedTask(tasks)
  const completedCount = tasks.filter((t) => t.status === "completed").length

  return [
    "[REANUDACIÓN DE SESIÓN LARGA — CONTEXTO COMPACTADO]",
    "La conversación anterior superó la ventana de contexto. Este bloque restaura tu memoria de trabajo de forma DETERMINISTA: nada del objetivo se pierde.",
    "",
    "BRIEF ORIGINAL (fuente de verdad — no lo reinterpretes ni lo re-preguntes):",
    originalBrief && originalBrief.trim()
      ? `"""${originalBrief.trim()}"""`
      : "(el brief vive íntegro en el PLAN PRESERVADO de abajo)",
    "",
    compacted.summaryPromptBlock,
    "",
    "INSTRUCCIÓN DE CONTINUACIÓN:",
    nextTask
      ? `Continúa EXACTAMENTE desde el primer task cuyo estado NO sea "completed": ${nextTask.id} — "${nextTask.title}" (${nextTask.status}).`
      : 'Todos los tasks están "completed": verifica el resultado y entrega el resumen final.',
    "No repitas tareas ya completadas. No regeneres archivos que ya existen y son correctos. Al terminar cada tarea, márcala completada y avanza con la siguiente en orden.",
    `(Progreso actual: ${completedCount}/${tasks.length} tareas completadas.)`,
  ].join("\n")
}
