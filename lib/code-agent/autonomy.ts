/**
 * code-agent · autonomy (pure).
 *
 * Decision helpers for the autonomous agent loop, kept framework-free so they
 * are testable with `node --test` like the rest of the orchestrator.
 *
 * Covers the round-2 wiring:
 *   - planAgentTasks(): decompose a build/patch instruction into an ordered
 *     AgentTask[] plan that the panel persists into state.tasks.
 *   - nextWorkTaskAction(): decide the next agent action after a generate/patch
 *     completed — auto-continue to the next pending task (proactive, no user
 *     input), retry a failed stream/quality/tool-output gate, or stop when the
 *     plan is done.
 *
 * Frente 2: every tool-call RESULT is validated (tool-output-validator) before
 * the loop chains the next step, so corrupt/truncated/empty tool output stops
 * the chain early instead of poisoning later steps.
 */

import type { AgentAction, AgentState, AgentTask } from "./types"
import { pickResumableTask } from "./task-retry"
import {
  MAX_STREAM_RETRIES,
  type StreamValidationResult,
} from "./stream-validator"
import type { QualityGateResult } from "./quality-gate"
import {
  DEFAULT_EMPTY_OK_TOOLS,
  validateToolOutput,
  type ToolOutputValidation,
} from "./tool-output-validator"
import { advanceIterationBudget, isBudgetExhausted, nextPendingTask } from "./orchestrator"

/**
 * Default allowEmpty set for chained /code steps: search/list tools may
 * legitimately return nothing. File reads/writes/builds stay strict.
 */
export const DEFAULT_CHAIN_EMPTY_OK_TOOLS: readonly string[] = DEFAULT_EMPTY_OK_TOOLS

/** Build an ordered task plan from a natural-language instruction. */
export function planAgentTasks(
  instruction: string,
  tasks?: AgentTask[] | null,
): AgentTask[] {
  const existing = tasks || []
  const plan = existing.length > 0
    ? existing
    : splitInstructionIntoSteps(instruction).map((step, index) => ({
        id: `plan-${Date.now().toString(36)}-${index}`,
        title: step.title,
        status: "pending" as const,
        detail: step.detail,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }))
  return plan
}

type PlannedStep = { title: string; detail: string }

/**
 * Split a build/patch instruction into up to 3 ordered steps. Fast heuristic:
 * "y luego", "después", "además", "también", "primero... luego", commas with
 * verbs, or plain enumeration. A single instruction stays one task.
 */
export function splitInstructionIntoSteps(instruction: string): PlannedStep[] {
  const text = String(instruction == null ? "" : instruction).trim()
  if (!text) return [{ title: "Implementar la solicitud", detail: "Implementa la solicitud del usuario." }]

  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")

  const connectors =
    /\b(?:y luego|despues|despues de eso|a continuacion|seguidamente|ademas|tambien|por otro lado)\b|(?:primero|en primer lugar)\b.*\b(?:luego|despues)\b/
  const hasConnectors = connectors.test(normalized)

  if (!hasConnectors) {
    return [{ title: text.slice(0, 80) || "Implementar la solicitud", detail: text }]
  }

  // Split on the connectors, keeping the original (accented) text in each part.
  const parts = text
    .split(
      /\s*(?:y luego|después de eso|despues de eso|a continuación|a continuacion|seguidamente|además|ademas|también|tambien|por otro lado|y después|y despues|después|despues|y a continuación|y a continuacion)\s+/i,
    )
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 3)

  if (parts.length <= 1) {
    return [{ title: text.slice(0, 80) || "Implementar la solicitud", detail: text }]
  }

  return parts.map((part, index) => ({
    title: `Paso ${index + 1}: ${part.slice(0, 60)}`,
    detail: part,
  }))
}

/** Public retry decision used by the panel after a stream/quality/tool-output failure. */
export interface RetryDecision {
  shouldRetry: boolean
  attempts: number
  instruction?: string
  reason: "stream" | "quality" | "tool_output" | "none"
}

/** True when a retry is still allowed (attempts < MAX_STREAM_RETRIES). */
export function canRetry(attempts: number): boolean {
  return attempts < MAX_STREAM_RETRIES
}

export interface WorkTaskState {
  /** Turn count of the current autonomous run (drives the budget). */
  iterationCount: number
  /** How many retries of stream/quality validation already ran. */
  retryAttempts: number
}

/**
 * Decide what the agent should do after a generate/patch completed, before any
 * user input. Returns:
 *   - work_task when there are still pending tasks and the budget allows it
 *   - a passthrough action when the plan is exhausted or the budget is spent
 */
export function nextWorkTaskAction(
  state: AgentState,
  now = Date.now(),
): AgentAction {
  // Structured per-task retries: a requeued task sits in "pending" with a
  // notBefore backoff gate — skip it (and the plan keeps moving) until its
  // cooldown elapses, so a transient failure retries with backoff instead of
  // hammering immediately or abandoning the whole plan.
  const nextTask = pickResumableTask(state.tasks, now)
  if (!nextTask) {
    return { type: "passthrough" }
  }
  if (isBudgetExhausted(state.budget, now)) {
    return { type: "passthrough" }
  }
  return {
    type: "work_task",
    taskId: nextTask.id,
    instruction: nextTask.detail || nextTask.title,
  }
}

/**
 * Advance the budget when a new autonomous turn starts. Returns the next
 * budget object or the spent one when the cap is hit.
 */
export function stepIterationBudget(state: AgentState, now = Date.now()): AgentState["budget"] {
  return advanceIterationBudget(state.budget, now)
}

/** Drive a stream-validation failure toward the next retry instruction. */
export function buildStreamRetry(
  validation: StreamValidationResult | null,
  attempts: number,
): RetryDecision {
  if (!validation || validation.valid) return { shouldRetry: false, attempts, reason: "none" }
  if (!canRetry(attempts)) return { shouldRetry: false, attempts, reason: "stream" }
  return {
    shouldRetry: true,
    attempts: attempts + 1,
    instruction: validation.retryInstruction,
    reason: "stream",
  }
}

/** Drive a quality-gate failure toward the next retry instruction. */
export function buildQualityRetry(
  gate: QualityGateResult | null,
  attempts: number,
): RetryDecision {
  if (!gate || gate.passed) return { shouldRetry: false, attempts, reason: "none" }
  if (!canRetry(attempts)) return { shouldRetry: false, attempts, reason: "quality" }
  return {
    shouldRetry: true,
    attempts: attempts + 1,
    instruction: gate.retryInstruction,
    reason: "quality",
  }
}

// ---- Frente 2 · tool-output validation before chaining ----------------------

/**
 * Validate every tool-call result of a chained step sequence BEFORE the next
 * step consumes it. Returns the first failed step's verdict plus its index, or
 * null when the whole chain is safe to continue. Pure — no side effects.
 *
 * The executor (panel / engine loop) calls this at the chaining point; a
 * non-null verdict must stop the chain and feed `verdict.retryInstruction`
 * into the bounded retry machinery instead of advancing the plan.
 */
export function validateStepChain(
  steps: ReadonlyArray<{ toolName: string; output?: unknown }>,
): ToolOutputValidation & { index?: number } | null {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (!step) continue
    const verdict = validateToolOutput(step.toolName, step.output)
    if (!verdict.ok) return { ...verdict, index }
  }
  return null
}

/**
 * Drive a tool-output failure toward the next retry instruction, mirroring
 * buildStreamRetry/buildQualityRetry so all three gates share one retry
 * contract and budget.
 */
export function buildToolOutputRetry(
  verdict: ToolOutputValidation | null,
  attempts: number,
): RetryDecision {
  if (!verdict || verdict.ok) return { shouldRetry: false, attempts, reason: "none" }
  if (!canRetry(attempts)) return { shouldRetry: false, attempts, reason: "tool_output" }
  return {
    shouldRetry: true,
    attempts: attempts + 1,
    instruction: verdict.retryInstruction,
    reason: "tool_output",
  }
}

/** Convenience wrapper: validate one tool result against the default allowEmpty set. */
export function isToolOutputChainable(toolName: string, output: unknown): boolean {
  const verdict = validateToolOutput(toolName, output, {
    allowEmptyTools: [...DEFAULT_CHAIN_EMPTY_OK_TOOLS],
  })
  return verdict.ok
}