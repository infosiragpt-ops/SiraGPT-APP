/**
 * Tests for Frente 4 — actionable agent errors (lib/code-agent/actionable-error.ts).
 * Pure: no React, no network. All user-facing text must be Spanish.
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import type { AgentTask } from "../lib/code-agent/types"
import {
  buildActionableError,
  findFirstBrokenTask,
  resetTasksFrom,
} from "../lib/code-agent/actionable-error"

function makeTask(
  id: string,
  status: AgentTask["status"],
  extras: Partial<AgentTask> = {},
): AgentTask {
  const now = Date.now()
  return {
    id,
    title: `Tarea ${id}`,
    status,
    detail: `detalle de ${id}`,
    createdAt: now,
    updatedAt: now,
    ...extras,
  }
}

// ---- buildActionableError ----------------------------------------------------

describe("buildActionableError · mensajes en español con qué falló + acciones", () => {
  test("model failure: provider title + retry/change-model actions", () => {
    const task = makeTask("t1", "error")
    const out = buildActionableError(task, {
      category: "model",
      error: { status: 502 },
    })
    assert.equal(out.title, "El proveedor de IA no respondió")
    assert.ok(out.whatFailed.length > 0)
    assert.ok(out.userActions.length >= 1)
    assert.ok(out.userActions.some((a) => /reintent/i.test(a)))
    assert.ok(out.userActions.some((a) => /modelo/i.test(a)))
    assert.equal(out.canRetryFromStep, true)
  })

  test("validation failure (quality gate): verification title + resume/adjust actions", () => {
    const task = makeTask("t2", "error")
    const out = buildActionableError(task, {
      category: "validation",
      error: null,
    })
    assert.equal(out.title, "El código generado no pasó la verificación")
    assert.ok(out.whatFailed.length > 0)
    assert.ok(out.userActions.some((a) => /reintentar desde este paso/i.test(a)))
    assert.ok(out.userActions.some((a) => /ajustar el requisito/i.test(a)))
    assert.equal(out.canRetryFromStep, true)
  })

  test("tool/file failure: names the file path when provided", () => {
    const task = makeTask("t3", "error", { files: ["app/page.tsx"] })
    const out = buildActionableError(task, {
      category: "tool",
      filePath: "prisma/schema.prisma",
    })
    assert.match(out.title, /archivos del proyecto/)
    assert.match(out.whatFailed, /prisma\/schema\.prisma/)
    assert.ok(out.userActions.length >= 1)
    assert.ok(out.canRetryFromStep)
  })

  test("every message is Spanish and states what failed + at least one action", () => {
    const task = makeTask("t4", "error", { title: "Añadir carrito" })
    for (const ctx of [
      undefined,
      { category: "model" as const },
      { category: "validation" as const },
      { category: "tool" as const },
      { category: "unknown" as const },
    ]) {
      const out = buildActionableError(task, ctx)
      assert.ok(out.title.trim().length > 0, `title empty for ${JSON.stringify(ctx)}`)
      assert.ok(
        out.whatFailed.includes("paso") || out.whatFailed.includes("No se pudo"),
        `whatFailed lacks substance for ${JSON.stringify(ctx)}: ${out.whatFailed}`,
      )
      assert.ok(
        !/[a-z]{4,}ly\b|\bfailed to\b|\bunknown error\b/i.test(`${out.title} ${out.whatFailed}`),
        "user-facing text leaked English",
      )
      assert.ok(out.userActions.length >= 1)
    }
  })
})

describe("buildActionableError · categorías distintas → textos distintos", () => {
  test("model vs validation vs tool produce different titles", () => {
    const task = makeTask("t5", "error")
    const model = buildActionableError(task, { category: "model" })
    const validation = buildActionableError(task, { category: "validation" })
    const tool = buildActionableError(task, { category: "tool" })
    const unknown = buildActionableError(task)
    const titles = new Set([model.title, validation.title, tool.title, unknown.title])
    assert.equal(titles.size, 4)
    assert.notDeepEqual(model.userActions, validation.userActions)
    assert.notDeepEqual(validation.userActions, tool.userActions)
    assert.notDeepEqual(model.userActions, tool.userActions)
  })

  test("classifyFailure integration: 502/timeout errors route to the model branch", () => {
    const task = makeTask("t6", "error")
    const fromServer = buildActionableError(task, { error: { status: 500 } })
    const fromTimeout = buildActionableError(task, { error: { statusCode: 408 } })
    const fromRateLimit = buildActionableError(task, { error: { code: "rate_limit" } })
    assert.equal(fromServer.title, "El proveedor de IA no respondió")
    assert.equal(fromTimeout.title, "El proveedor de IA no respondió")
    assert.equal(fromRateLimit.title, "El proveedor de IA no respondió")
  })

  test("payment_required (402): still provider-side, with its own explanation", () => {
    const task = makeTask("t6b", "error")
    const out = buildActionableError(task, { error: { status: 402 } })
    assert.equal(out.title, "El proveedor de IA no respondió")
    assert.match(out.whatFailed, /créditos|cuota/i)
  })
})

describe("buildActionableError · fallback honesto sin inventar causa", () => {
  test("no category/error: says the cause could not be determined", () => {
    const task = makeTask("t7", "error")
    const out = buildActionableError(task)
    assert.doesNotMatch(out.title, /proveedor de IA|verificación|archivos/)
    assert.match(out.whatFailed, /no se pudo determinar la causa exacta/)
    // It never fabricates a specific cause.
    assert.doesNotMatch(out.whatFailed, /rate limit|créditos|sintaxis|permiso/i)
    assert.ok(out.userActions.length >= 1)
  })

  test("non-provider raw error (400/other) also falls back honestly", () => {
    const task = makeTask("t8", "error")
    const out = buildActionableError(task, { error: { status: 400, message: "bad request" } })
    assert.match(out.whatFailed, /no se pudo determinar la causa exacta/)
  })
})

describe("buildActionableError · contexto del paso", () => {
  test("mentions the broken step subject when available", () => {
    const task = makeTask("t9", "error", { detail: "construye el panel de pagos" })
    const out = buildActionableError(task, { category: "validation" })
    assert.match(out.whatFailed, /panel de pagos/)
  })
})

// ---- findFirstBrokenTask -----------------------------------------------------

describe("findFirstBrokenTask", () => {
  test("finds the first 'error' among done/error/pending mix", () => {
    const tasks = [
      makeTask("a", "completed"),
      makeTask("b", "pending"),
      makeTask("c", "error"),
      makeTask("d", "pending"),
    ]
    assert.equal(findFirstBrokenTask(tasks)?.id, "c")
  })

  test("returns the earliest error when several exist", () => {
    const tasks = [makeTask("a", "error"), makeTask("b", "error")]
    assert.equal(findFirstBrokenTask(tasks)?.id, "a")
  })

  test("detects an orphaned in_progress before later completed work", () => {
    const tasks = [
      makeTask("a", "completed"),
      makeTask("b", "in_progress"), // loop died mid-step
      makeTask("c", "completed"),
    ]
    assert.equal(findFirstBrokenTask(tasks)?.id, "b")
  })

  test("plain in_progress without later terminal work is NOT broken", () => {
    const tasks = [makeTask("a", "completed"), makeTask("b", "in_progress")]
    assert.equal(findFirstBrokenTask(tasks), null)
  })

  test("healthy plan returns null; empty/null input returns null", () => {
    assert.equal(findFirstBrokenTask([makeTask("a", "completed"), makeTask("b", "pending")]), null)
    assert.equal(findFirstBrokenTask([]), null)
    assert.equal(findFirstBrokenTask(null), null)
    assert.equal(findFirstBrokenTask(undefined), null)
  })
})

// ---- resetTasksFrom ----------------------------------------------------------

describe("resetTasksFrom", () => {
  test("keeps earlier completed tasks and resets the broken one plus successors", () => {
    const tasks = [
      makeTask("a", "completed"),
      makeTask("b", "completed"),
      makeTask("c", "error"),
      makeTask("d", "in_progress"),
      makeTask("e", "pending"),
    ]
    const nowBefore = Date.now()
    const next = resetTasksFrom(tasks, "c")
    assert.deepEqual(
      next.map((task) => task.status),
      ["completed", "completed", "pending", "pending", "pending"],
    )
    // The broken task itself ("c") was reset too.
    assert.equal(next.find((task) => task.id === "c")?.status, "pending")
    // Timestamps refreshed only on reset tasks.
    assert.ok(next.find((task) => task.id === "c")!.updatedAt >= nowBefore)
  })

  test("does not mutate the input array or share task objects it changed", () => {
    const tasks: AgentTask[] = [makeTask("a", "completed"), makeTask("b", "blocked"), makeTask("c", "error")]
    const frozen = Object.freeze(tasks.slice()) as unknown as AgentTask[]
    const next = resetTasksFrom(frozen, "b")
    assert.equal(tasks[1].status, "blocked")
    assert.equal(next.find((task) => task.id === "b")?.status, "pending")
    assert.notEqual(next[1], tasks[1])
    // Unchanged tasks keep identity-safe copies but same values.
    assert.equal(next[0].status, "completed")
  })

  test("resetting from an unknown id leaves statuses untouched", () => {
    const tasks = [makeTask("a", "completed"), makeTask("b", "error")]
    const next = resetTasksFrom(tasks, "nope")
    assert.deepEqual(next.map((task) => task.status), ["completed", "error"])
  })

  test("null/undefined input yields an empty plan", () => {
    assert.deepEqual(resetTasksFrom(null, "x"), [])
    assert.deepEqual(resetTasksFrom(undefined, "x"), [])
  })

  test("resume round-trip: findFirstBrokenTask then resetTasksFrom clears breakage", () => {
    const tasks = [
      makeTask("a", "completed"),
      makeTask("b", "in_progress"),
      makeTask("c", "completed"),
    ]
    const broken = findFirstBrokenTask(tasks)
    assert.ok(broken)
    const next = resetTasksFrom(tasks, broken.id)
    assert.equal(findFirstBrokenTask(next), null)
    assert.deepEqual(next.map((task) => task.status), ["completed", "pending", "pending"])
  })
})
