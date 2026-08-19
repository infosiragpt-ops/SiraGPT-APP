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
 *     input), retry a failed stream/quality gate, or stop when the plan is done.
 */

import type { AgentAction, AgentState, AgentTask } from "./types"
import {
  MAX_STREAM_RETRIES,
  type StreamValidationResult,
} from "./stream-validator"
import type { QualityGateResult } from "./quality-gate"
import { advanceIterationBudget, isBudgetExhausted, nextPendingTask } from "./orchestrator"

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

/** Public retry decision used by the panel after a stream/quality failure. */
export interface RetryDecision {
  shouldRetry: boolean
  attempts: number
  instruction?: string
  reason: "stream" | "quality" | "none"
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
  const nextTask = nextPendingTask(state.tasks)
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