/**
 * code-agent · actionable-error (pure).
 *
 * Frente 4 — errores accionables: when a task genuinely fails (after the
 * bounded retries in autonomy.ts / resilience.ts), the user deserves a message
 * that says WHAT failed and WHAT they can do, plus a deterministic way to
 * RESUME FROM THE BROKEN STEP.
 *
 * Pure module, dependency-free except for the shared AgentTask type, so it is
 * testable with `node --test` like the rest of the orchestrator and safe to
 * import from the React panel. All user-facing text is SPANISH — the /code
 * panel already speaks Spanish to its users.
 *
 * Honesty rule: when the cause cannot be determined from the data at hand
 * (task title/detail/files or an explicit failure category), the fallback says
 * exactly that instead of inventing a plausible-sounding cause.
 */

import type { AgentTask } from "./types"
import { classifyFailure } from "./resilience"

/**
 * Failure categories the panel can attach to a failed task/turn. They map 1:1
 * onto the real failure sources of the agent loop:
 *   - stream/model failures (generateAIStream / OpenRouter) → "model"
 *   - stream-validator / quality-gate rejections → "validation"
 *   - file/tool write failures (workspace sync, apply) → "tool"
 */
export type ActionableErrorCategory =
  | "model" // red / proveedor de IA
  | "validation" // quality-gate / stream-validator / verificación
  | "tool" // herramienta / archivo
  | "unknown"

/** Context the caller may attach; every field is optional and honest-only. */
export interface ActionableErrorContext {
  /** Explicit category from the failing subsystem, when known. */
  category?: ActionableErrorCategory
  /**
   * Raw error object as surfaced by lib/api.ts / OpenRouter (status, message,
   * code). Classified with the EXISTING classifyFailure() so both layers agree
   * on what a network/model failure looks like.
   */
  error?: {
    status?: number
    statusCode?: number
    code?: string
    message?: string
    name?: string
  } | null
  /** File path involved in a tool/file failure, when known. */
  filePath?: string | null
}

/** What the UI shows for a failed task: qué falló + qué puede hacer. */
export interface ActionableError {
  /** Short headline, e.g. "El proveedor de IA no respondió". */
  title: string
  /** One-sentence explanation of what failed, honest about unknowns. */
  whatFailed: string
  /** Concrete actions the user can take right now. */
  userActions: string[]
  /**
   * True when resuming the plan from this broken step makes sense (the step
   * itself is retryable). When false, there is nothing to resume into.
   */
  canRetryFromStep: boolean
}

const MODEL_TITLE = "El proveedor de IA no respondió"
const VALIDATION_TITLE = "El código generado no pasó la verificación"

function cleanText(value: unknown): string {
  return String(value == null ? "" : value).trim()
}

/**
 * Resolve the effective failure category. An explicit `ctx.category` wins;
 * otherwise an attached error object goes through the existing resilience
 * classifier (payment/ratelimit/5xx/timeout → model-side failure); otherwise
 * we honestly do not know.
 */
function resolveCategory(ctx?: ActionableErrorContext): ActionableErrorCategory {
  if (ctx?.category) return ctx.category
  const err = ctx?.error
  if (!err) return "unknown"
  switch (classifyFailure(err)) {
    case "rate_limit":
    case "server":
    case "timeout":
      return "model"
    case "payment_required":
      // Quota/credit exhaustion IS a provider-side condition, but it must NOT
      // be presented as a generic network blip: it has its own action set.
      return "model"
    default:
      return "unknown"
  }
}

/** First sentence of a task detail/title — enough context without walls of text. */
function taskSubject(task: Pick<AgentTask, "title" | "detail">): string {
  const source = cleanText(task.detail) || cleanText(task.title)
  if (!source) return ""
  return source.length > 120 ? `${source.slice(0, 117)}…` : source
}

/**
 * Build the actionable error message for one failed task. Deterministic by
 * category; never invents a cause it cannot see.
 */
export function buildActionableError(
  task: Pick<AgentTask, "title" | "detail" | "files">,
  ctx?: ActionableErrorContext,
): ActionableError {
  const subject = taskSubject(task)
  const where = subject ? `, en el paso "${subject}"` : ""
  const category = resolveCategory(ctx)

  switch (category) {
    case "model": {
      const err = ctx?.error
      const status = Number(err?.status ?? err?.statusCode)
      let why = "el modelo no devolvió respuesta tras varios intentos."
      if (status === 402 || err?.message && /insufficient|payment|quota|no credit|credit limit/i.test(String(err.message))) {
        why = "se agotaron los créditos o la cuota del proveedor de IA."
      } else if (status === 429) {
        why = "se alcanzó el límite de peticiones (rate limit) del proveedor."
      }
      return {
        title: MODEL_TITLE,
        whatFailed: `No se pudo generar el código${where}: ${why}`,
        userActions: [
          "Reintentar el paso con conexión estable",
          "Cambiar a otro modelo de IA y volver a intentarlo",
        ],
        canRetryFromStep: true,
      }
    }
    case "validation": {
      return {
        title: VALIDATION_TITLE,
        whatFailed: `El código producido para este paso no superó las comprobaciones automáticas (sintaxis, estructura o calidad)${where}.`,
        userActions: [
          "Reintentar desde este paso",
          "Ajustar el requisito del paso y volver a generarlo",
        ],
        canRetryFromStep: true,
      }
    }
    case "tool": {
      const path = cleanText(ctx?.filePath) || firstFile(task.files) || ""
      const target = path
        ? `No se pudo completar la operación sobre "${path}"`
        : "Falló una operación del agente sobre los archivos del proyecto"
      return {
        title: "Fallo al trabajar con los archivos del proyecto",
        whatFailed: `${target}${where}.`,
        userActions: [
          "Verificar que el archivo existe y no está bloqueado, y reintentar desde este paso",
          ...(path ? [`Revisar el archivo ${path}`] : []),
        ],
        canRetryFromStep: true,
      }
    }
    default: {
      // Honest fallback: we do NOT know why it failed, and we say so.
      return {
        title: "El agente no pudo completar este paso",
        whatFailed: `El paso no terminó correctamente y no se pudo determinar la causa exacta a partir de los datos disponibles.`,
        userActions: [
          "Reintentar desde este paso",
          "Reformular la instrucción del paso con más detalle",
        ],
        canRetryFromStep: true,
      }
    }
  }
}

function firstFile(files?: string[]): string {
  return files && files.length > 0 ? cleanText(files[0]) : ""
}

/**
 * The FIRST broken task of a plan: the resume point for "reintentar desde el
 * paso roto". A task counts as broken when:
 *   - its status is explicitly "error", or
 *   - it is "in_progress" but orphaned (a later task already reached a terminal
 *     state), meaning the loop died mid-step and never settled the flag.
 *
 * Returns null when the plan has no broken task.
 */
export function findFirstBrokenTask(tasks: AgentTask[] | null | undefined): AgentTask | null {
  const list = Array.isArray(tasks) ? tasks : []
  const ERROR_INDEX = new Set(["error"])
  let orphanedInProgress: AgentTask | null = null
  for (const task of list) {
    if (ERROR_INDEX.has(task.status)) return task
    if (
      !orphanedInProgress &&
      task.status === "in_progress" &&
      list.slice(list.indexOf(task) + 1).some((later) => later.status === "completed" || later.status === "error")
    )
      orphanedInProgress = task
  }
  return orphanedInProgress
}

/**
 * Resume semantics: return a COPY of tasks where `taskId` and every LATER task
 * go back to "pending"; earlier tasks keep their "completed"/"blocked" state.
 * Never mutates the input array — callers persist the copy via updateAgentTask-
 * style flows.
 */
export function resetTasksFrom(tasks: AgentTask[] | null | undefined, taskId: string): AgentTask[] {
  const list = Array.isArray(tasks) ? tasks : []
  const index = list.findIndex((task) => task.id === taskId)
  if (index < 0) return list.map((task) => ({ ...task }))
  const now = Date.now()
  return list.map((task, i) => {
    if (i >= index && task.status !== "pending") {
      return { ...task, status: "pending" as const, updatedAt: now }
    }
    return { ...task }
  })
}
