/**
 * Tests for the round-2 autonomy helpers (planAgentTasks, nextWorkTaskAction,
 * retry decisions, iteration budget). Pure, no React, no network.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { defaultAgentState, type AgentState } from "../lib/code-agent/types"
import {
  planAgentTasks,
  splitInstructionIntoSteps,
  nextWorkTaskAction,
  buildStreamRetry,
  buildQualityRetry,
} from "../lib/code-agent/autonomy"
import {
  advanceIterationBudget,
  isBudgetExhausted,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_ITERATION_TIMEOUT_MS,
  createAgentTask,
} from "../lib/code-agent/orchestrator"

function previewState(overrides: Partial<AgentState> = {}): AgentState {
  return { ...defaultAgentState(), phase: "preview", ...overrides }
}

// ---- Mejora 1: planAgentTasks / splitInstructionIntoSteps -------------------

test("splitInstructionIntoSteps: single instruction stays one task", () => {
  const steps = splitInstructionIntoSteps("Crea un formulario de contacto")
  assert.equal(steps.length, 1)
  assert.match(steps[0].title, /Crea un formulario/)
})

test("splitInstructionIntoSteps: chained instruction splits into ordered steps", () => {
  const steps = splitInstructionIntoSteps("Añade un navbar y luego un footer y después un carrito")
  assert.equal(steps.length, 3)
  assert.match(steps[0].detail, /navbar/i)
  assert.match(steps[1].detail, /footer/i)
  assert.match(steps[2].detail, /carrito/i)
})

test("splitInstructionIntoSteps: empty input falls back to a single generic task", () => {
  const steps = splitInstructionIntoSteps("   ")
  assert.equal(steps.length, 1)
  assert.ok(steps[0].detail.length > 0)
})

test("planAgentTasks: creates a pending plan from a chained instruction", () => {
  const plan = planAgentTasks("Crea la landing y luego añade productos")
  assert.ok(plan.length >= 2)
  for (const task of plan) {
    assert.equal(task.status, "pending")
    assert.ok(task.id)
    assert.ok(task.title)
  }
})

test("planAgentTasks: keeps an existing task list untouched", () => {
  const existing = [
    createAgentTask("Tarea existente", "detalle"),
  ]
  const plan = planAgentTasks("cualquier cos", existing)
  assert.equal(plan, existing)
  assert.equal(plan.length, 1)
})

// ---- Mejora 2: nextWorkTaskAction -------------------------------------------

test("nextWorkTaskAction: picks the next pending task as work_task", () => {
  const done = createAgentTask("Lista", "detalle")
  const doneCompleted = { ...done, status: "completed" as const }
  const next = createAgentTask("Siguiente", "construye el panel")
  const state = previewState({ tasks: [doneCompleted, next] })
  const action = nextWorkTaskAction(state)
  assert.deepEqual(action, { type: "work_task", taskId: next.id, instruction: "construye el panel" })
})

test("nextWorkTaskAction: prefers an in_progress task over pending", () => {
  const inProgress = { ...createAgentTask("En curso", "termina esto"), status: "in_progress" as const }
  const pending = createAgentTask("Pendiente", "después")
  const state = previewState({ tasks: [pending, inProgress] })
  const action = nextWorkTaskAction(state)
  assert.equal(action.type, "work_task")
  if (action.type === "work_task") assert.equal(action.taskId, inProgress.id)
})

test("nextWorkTaskAction: returns passthrough when the plan is empty", () => {
  const state = previewState({ tasks: [] })
  assert.deepEqual(nextWorkTaskAction(state), { type: "passthrough" })
})

test("nextWorkTaskAction: returns passthrough when all tasks are completed", () => {
  const done = { ...createAgentTask("Hecho", "detalle"), status: "completed" as const }
  const state = previewState({ tasks: [done] })
  assert.deepEqual(nextWorkTaskAction(state), { type: "passthrough" })
})

// ---- Mejora 4: iteration budget ---------------------------------------------

test("advanceIterationBudget: first call creates a fresh budget", () => {
  const budget = advanceIterationBudget(undefined, 1000)
  assert.equal(budget.count, 1)
  assert.equal(budget.max, DEFAULT_MAX_ITERATIONS)
  assert.equal(budget.timeoutMs, DEFAULT_ITERATION_TIMEOUT_MS)
  assert.equal(budget.startedAt, 1000)
  assert.equal(budget.exhausted, false)
})

test("advanceIterationBudget: increments the counter", () => {
  const first = advanceIterationBudget(undefined, 1000)
  const second = advanceIterationBudget(first, 1001)
  assert.equal(second.count, 2)
})

test("advanceIterationBudget: flags exhausted once the max is passed", () => {
  const budget = advanceIterationBudget(undefined, 1000)
  const exhausted = advanceIterationBudget({ ...budget, count: budget.max }, 2000)
  assert.equal(exhausted.exhausted, true)
})

test("isBudgetExhausted: false under the cap", () => {
  const budget = advanceIterationBudget(undefined, 1000)
  assert.equal(isBudgetExhausted(budget, 2000), false)
})

test("isBudgetExhausted: true at the cap", () => {
  const budget = { count: DEFAULT_MAX_ITERATIONS, max: DEFAULT_MAX_ITERATIONS, startedAt: 1000, timeoutMs: 60_000 }
  assert.equal(isBudgetExhausted(budget, 2000), true)
})

test("isBudgetExhausted: true past the timeout", () => {
  const budget = { count: 1, max: DEFAULT_MAX_ITERATIONS, startedAt: 1000, timeoutMs: 60_000 }
  assert.equal(isBudgetExhausted(budget, 1000 + 60_001), true)
})

test("isBudgetExhausted: timeoutMs 0 disables the time limit", () => {
  const budget = { count: 1, max: DEFAULT_MAX_ITERATIONS, startedAt: 1000, timeoutMs: 0 }
  assert.equal(isBudgetExhausted(budget, 1000 + 10_000_000), false)
})

test("isBudgetExhausted: no budget means never exhausted", () => {
  assert.equal(isBudgetExhausted(undefined), false)
})

test("nextWorkTaskAction: respects the exhausted budget (M4 gate)", () => {
  const pending = createAgentTask("Tarea", "detalle")
  const exhaustedBudget = { count: DEFAULT_MAX_ITERATIONS, max: DEFAULT_MAX_ITERATIONS, startedAt: 1000, timeoutMs: 60_000, exhausted: true }
  const state = previewState({ tasks: [pending], budget: exhaustedBudget })
  assert.deepEqual(nextWorkTaskAction(state, 2000), { type: "passthrough" })
})

// ---- Mejora 3: retry decisions ----------------------------------------------

test("buildStreamRetry: valid result never retries", () => {
  const decision = buildStreamRetry({ valid: true }, 0)
  assert.deepEqual(decision, { shouldRetry: false, attempts: 0, reason: "none" })
})

test("buildStreamRetry: invalid result under cap retries with instruction", () => {
  const decision = buildStreamRetry(
    { valid: false, issue: "JSON inválido", retryInstruction: "Corrige el JSON" },
    0,
  )
  assert.equal(decision.shouldRetry, true)
  assert.equal(decision.attempts, 1)
  assert.equal(decision.instruction, "Corrige el JSON")
  assert.equal(decision.reason, "stream")
})

test("buildStreamRetry: stops retrying at the cap", () => {
  const decision = buildStreamRetry(
    { valid: false, issue: "rotura", retryInstruction: "arregla" },
    2,
  )
  assert.equal(decision.shouldRetry, false)
  assert.equal(decision.reason, "stream")
})

test("buildQualityRetry: passing gate never retries", () => {
  const gate = { passed: true, issues: [] }
  const decision = buildQualityRetry(gate, 0)
  assert.deepEqual(decision, { shouldRetry: false, attempts: 0, reason: "none" })
})

test("buildQualityRetry: failing gate under cap retries with instruction", () => {
  const gate = {
    passed: false,
    issues: [{ severity: "error" as const, rule: "x", filePath: "a.ts", message: "m", fixInstruction: "f" }],
    retryInstruction: "Corrige los errores",
  }
  const decision = buildQualityRetry(gate, 0)
  assert.equal(decision.shouldRetry, true)
  assert.equal(decision.attempts, 1)
  assert.equal(decision.instruction, "Corrige los errores")
  assert.equal(decision.reason, "quality")
})

test("buildQualityRetry: stops retrying at the cap", () => {
  const gate = {
    passed: false,
    issues: [{ severity: "error" as const, rule: "x", filePath: "a.ts", message: "m", fixInstruction: "f" }],
    retryInstruction: "Corrige",
  }
  const decision = buildQualityRetry(gate, 2)
  assert.equal(decision.shouldRetry, false)
  assert.equal(decision.reason, "quality")
})