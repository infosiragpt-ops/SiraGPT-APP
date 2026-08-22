/**
 * Tests for Frente 3 — context recovery (lib/code-agent/context-recovery.ts).
 * Pure, deterministic: token estimation, compaction gate, plan preservation,
 * transcript head/tail keeping, fact extraction and recovery prompt shape.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CODE_CONTEXT_TOKEN_LIMIT,
  DEFAULT_HEAD_MESSAGES,
  DEFAULT_MAX_TASK_DETAIL_CHARS,
  DEFAULT_RECENT_MESSAGES,
  MAX_FACTS_TOTAL,
  TRUNCATION_MARKER,
  buildRecoveryPrompt,
  compactContext,
  estimateContextTokens,
  extractFacts,
  firstUncompletedTask,
  shouldCompactContext,
  snapshotTasks,
  type ContextRecoveryTurn,
  type PlanLike,
} from "../lib/code-agent/context-recovery"

function msg(role: string, content: string): ContextRecoveryTurn {
  return { role, content }
}

function longText(prefix: string, chars: number): string {
  return `${prefix} ${"x".repeat(Math.max(0, chars - prefix.length))}`
}

// ---- estimateContextTokens ---------------------------------------------------

test("estimateContextTokens: ~4 chars per token, rounded up", () => {
  assert.equal(estimateContextTokens([]), 0)
  assert.equal(estimateContextTokens(["abcd"]), 1) // 4 chars → ceil(1)
  assert.equal(estimateContextTokens(["abcde"]), 2) // 5 chars → ceil(1.25)
  assert.equal(estimateContextTokens(["abcdefgh", "ab"]), 3) // 10 chars
})

test("estimateContextTokens: monotonic — more/longer items never yield fewer tokens", () => {
  const small = ["hola mundo"]
  const bigger = ["hola mundo", "y algo más de contexto aquí", "tercer mensaje largo"]
  assert.ok(estimateContextTokens(bigger) > estimateContextTokens(small))
  const grown = [...bigger, "cuarto"]
  assert.ok(estimateContextTokens(grown) >= estimateContextTokens(bigger))
})

test("estimateContextTokens: accepts {role, content} items like real turns", () => {
  const turns = [msg("user", "a".repeat(40))]
  assert.equal(estimateContextTokens(turns), 10)
})

// ---- shouldCompactContext ------------------------------------------------------

test("shouldCompactContext: false under the limit", () => {
  const items = Array.from({ length: 5 }, () => "x".repeat(400)) // 2000 chars → 500 tokens
  assert.equal(shouldCompactContext(items, 1000), false)
})

test("shouldCompactContext: true over the limit", () => {
  const items = Array.from({ length: 20 }, () => "x".repeat(400)) // 8000 chars → 2000 tokens
  assert.equal(shouldCompactContext(items, 1000), true)
})

test("shouldCompactContext: exactly at the limit does NOT compact (conservative)", () => {
  // 4000 chars = exactly 1000 tokens with the chars/4 approximation.
  const items = ["x".repeat(4000)]
  assert.equal(shouldCompactContext(items, 1000), false)
  // One more char tips it over.
  assert.equal(shouldCompactContext(["x".repeat(4001)], 1000), true)
})

test("shouldCompactContext: empty history never compacts; default limit is env-tunable constant", () => {
  assert.equal(shouldCompactContext([]), false)
  assert.ok(CODE_CONTEXT_TOKEN_LIMIT > 0)
  assert.equal(typeof CODE_CONTEXT_TOKEN_LIMIT, "number")
})

// ---- compactContext: plan + tasks ----------------------------------------------

const PLAN: PlanLike = {
  goal: "app",
  productType: "inventario para ferretería",
  brand: "FerreMax",
  features: "auth, panel, búsqueda",
}

test("compactContext: the ORIGINAL plan is preserved INTACT (hard requirement)", () => {
  const original = { ...PLAN }
  const out = compactContext(original, [], [], {})
  assert.deepEqual(out.preservedPlan, PLAN)
  assert.deepEqual(Object.keys(out.preservedPlan), Object.keys(PLAN))
  assert.notEqual(out.preservedPlan, original) // copied, not aliased/mutated
})

test("compactContext: preserves ALL tasks (id/title/status) in order", () => {
  const tasks = [
    { id: "t1", title: "Estructura", status: "completed", detail: "andamio base" },
    { id: "t2", title: "Panel", status: "in_progress", detail: "tabla de productos" },
    { id: "t3", title: "API", status: "pending", detail: "rutas CRUD" },
  ]
  const out = compactContext(PLAN, tasks, [msg("user", "brief")], {})
  assert.equal(out.tasks.length, 3)
  assert.deepEqual(
    out.tasks.map((t) => t.status),
    ["completed", "in_progress", "pending"],
  )
  for (let i = 0; i < tasks.length; i++) {
    assert.equal(out.tasks[i].id, tasks[i].id)
    assert.equal(out.tasks[i].title, tasks[i].title)
  }
  assert.match(out.summaryPromptBlock, /Total: 3 tareas · completadas: 1/)
})

test("compactContext: truncates LONG task details with the explicit marker", () => {
  const longDetail = longText("Detalle enorme:", 800)
  const tasks = [
    { id: "t1", title: "Corta", status: "pending", detail: "breve" },
    { id: "t2", title: "Larga", status: "pending", detail: longDetail },
  ]
  const out = compactContext(PLAN, tasks, [], {})
  assert.equal(out.tasks[0].detail, "breve") // short details untouched
  assert.ok(out.tasks[1].detail.startsWith("Detalle enorme:"))
  assert.ok(out.tasks[1].detail.endsWith(TRUNCATION_MARKER))
  assert.ok(out.tasks[1].detail.length < longDetail.length)
  assert.equal(DEFAULT_MAX_TASK_DETAIL_CHARS, 160)
  assert.match(out.summaryPromptBlock, new RegExp(`${TRUNCATION_MARKER.replace(/[.[\]]/g, "\\$&")}`))
})

// ---- compactContext: transcript head/tail/middle -------------------------------

function bigTranscript(middleCount: number): ContextRecoveryTurn[] {
  const turns: ContextRecoveryTurn[] = [
    msg("user", "BRIEF ORIGINAL: crea una app de inventario con auth"),
    msg("assistant", "Perfecto, planifico y ejecuto por pasos."),
  ]
  for (let i = 0; i < middleCount; i++) {
    turns.push(msg(i % 2 === 0 ? "assistant" : "user", `mensaje intermedio ${i + 1} relleno`))
  }
  turns.push(msg("assistant", "ÚLTIMO mensaje reciente con estado actual."))
  return turns
}

test("compactContext: keeps head (origin of brief) and K most recent; drops only the middle", () => {
  const transcript = bigTranscript(30) // 33 total
  const out = compactContext(PLAN, [], transcript, { recentCount: 10 })
  assert.equal(out.droppedCount, 21) // 33 - 2 head - 10 tail

  const block = out.summaryPromptBlock
  assert.ok(block.includes("MENSAJES CONSERVADOS"))
  assert.ok(block.includes("BRIEF ORIGINAL: crea una app")) // head kept verbatim
  assert.ok(block.includes("ÚLTIMO mensaje reciente")) // newest tail message kept
  assert.ok(!block.includes("mensaje intermedio 15 relleno")) // middle dropped
  assert.ok(block.includes("Mensajes intermedios omitidos: 21"))
  assert.equal(DEFAULT_RECENT_MESSAGES, 10)
  assert.equal(DEFAULT_HEAD_MESSAGES, 2)
})

test("compactContext: small transcript within head+recent → nothing dropped", () => {
  const transcript = bigTranscript(6) // 8 total ≤ 2 head + 10 recent
  const out = compactContext(PLAN, [], transcript, {})
  assert.equal(out.droppedCount, 0)
  assert.ok(out.summaryPromptBlock.includes("Mensajes intermedios omitidos: 0"))
})

test("compactContext: middle collapses into regex-extracted hechos", () => {
  const transcript: ContextRecoveryTurn[] = [
    msg("user", "Brief inicial del proyecto"),
    msg("assistant", "Ok, empiezo."),
    // Middle messages that carry extractable facts:
    msg("assistant", "Creé app/page.tsx con el dashboard inicial."),
    msg("assistant", "npm ERR! ERESOLVE peer dependency conflict en react-dom."),
    msg("assistant", "Corregido el error TS2322 ajustando el tipo del prop."),
    msg("assistant", "jajaja esto no es un hecho estructurado 😄"),
    // Tail:
    msg("user", "sigue"),
    msg("assistant", "Continúo con el siguiente paso."),
  ]
  const out = compactContext(PLAN, [], transcript, { recentCount: 2 })
  assert.equal(out.droppedCount, 4)
  const factsSection = out.summaryPromptBlock.slice(
    out.summaryPromptBlock.indexOf("HECHOS DEL TRAMO OMITIDO"),
    out.summaryPromptBlock.indexOf("MENSAJES CONSERVADOS"),
  )
  assert.match(factsSection, /app\/page\.tsx/)
  assert.match(factsSection, /ERESOLVE/)
  assert.match(factsSection, /error TS2322/i)
  assert.ok(!factsSection.includes("jajaja"))
})

test("extractFacts: capped at MAX_FACTS_TOTAL and deduplicated", () => {
  const middles: ContextRecoveryTurn[] = []
  for (let i = 0; i < 60; i++) middles.push(msg("assistant", `Creé archivo-${i}.ts con la tabla ${i}.`))
  const facts = extractFacts(middles)
  assert.ok(facts.length <= MAX_FACTS_TOTAL)
  assert.equal(new Set(facts).size, facts.length)
})

// ---- nextTask helpers ------------------------------------------------------------

test("firstUncompletedTask: skips completed and returns the first non-completed", () => {
  const snaps = [
    ...snapshotTasks([
      { id: "a", title: "uno", status: "completed" },
      { id: "b", title: "dos", status: "in_progress" },
      { id: "c", title: "tres", status: "pending" },
    ]),
  ]
  const next = firstUncompletedTask(snaps)
  assert.equal(next?.id, "b")
  assert.equal(firstUncompletedTask(snapshotTasks([{ id: "z", title: "ok", status: "completed" }])), null)
  assert.equal(firstUncompletedTask([]), null)
})

// ---- compactContext output shape -------------------------------------------------

test("compactContext: returns summaryPromptBlock, preservedPlan and droppedCount keys", () => {
  const out = compactContext({ goal: "landing" }, [{ id: "t1", title: "X", status: "pending" }], [msg("user", "hi")], {})
  for (const key of ["summaryPromptBlock", "preservedPlan", "droppedCount"] as const) {
    assert.ok(key in out, `missing key ${key}`)
  }
})

// ---- buildRecoveryPrompt ----------------------------------------------------------

test("buildRecoveryPrompt: contains the FULL plan, task state and facts", () => {
  const transcript = bigTranscript(14)
  const compacted = compactContext(PLAN, [
    { id: "p-1", title: "Auth", status: "completed", detail: "login listo" },
    { id: "p-2", title: "Panel productos", status: "pending", detail: "CRUD con Prisma" },
  ], transcript, { recentCount: 4 })
  const prompt = buildRecoveryPrompt("App de inventario para FerreMax con control de stock", compacted)

  // Original brief present verbatim:
  assert.ok(prompt.includes("App de inventario para FerreMax con control de stock"))
  // FULL plan (every key/value pair):
  for (const [key, value] of Object.entries(PLAN)) {
    assert.ok(prompt.includes(`${key}: ${value}`), `plan key missing: ${key}`)
  }
  // Task state:
  assert.ok(prompt.includes("[completed] p-1 — Auth"))
  assert.ok(prompt.includes("[pending] p-2 — Panel productos"))
})

test("buildRecoveryPrompt: names the FIRST non-done task and orders continuation", () => {
  const compacted = compactContext(PLAN, [
    { id: "p-1", title: "Auth", status: "completed" },
    { id: "p-2", title: "Panel productos", status: "pending" },
    { id: "p-3", title: "Reportes", status: "pending" },
  ], [], {})
  const prompt = buildRecoveryPrompt("brief", compacted)
  assert.match(prompt, /primer task cuyo estado NO sea "completed"/)
  assert.ok(prompt.includes('p-2 — "Panel productos" (pending)'))
  assert.match(prompt, /No repitas tareas ya completadas/)
  assert.match(prompt, /Progreso actual: 1\/3 tareas completadas/)
})

test("buildRecoveryPrompt: all-done plan switches to a verify-and-wrap instruction", () => {
  const compacted = compactContext(
    PLAN,
    [
      { id: "p-1", title: "Unica", status: "completed" },
      { id: "p-2", title: "Doble", status: "completed" },
    ],
    [],
    {},
  )
  const prompt = buildRecoveryPrompt("brief", compacted)
  assert.match(prompt, /Todos los tasks están "completed"/)
  assert.match(prompt, /Progreso actual: 2\/2 tareas completadas/)
})

test("buildRecoveryPrompt: end-to-end recovery keeps the brief origin through compaction", () => {
  // Long session where ONLY the very first user turn carries the brief.
  const transcript: ContextRecoveryTurn[] = [msg("user", "CREA UNA APP DE PEDIDOS PARA MI CAFETERÍA")]
  for (let i = 0; i < 25; i++) transcript.push(msg("assistant", `tramo intermedio ${i}, sin brief.`))
  transcript.push(msg("user", "continúa"))

  const gate = shouldCompactContext(transcript, 200) // tiny limit to force it (~224 estimated tokens)
  assert.equal(gate, true)

  const compacted = compactContext({ goal: "app", productType: "pedidos cafetería" }, [
    { id: "plan-a", title: "Modelo Pedido + API", status: "completed" },
    { id: "plan-b", title: "UI de pedidos", status: "in_progress" },
  ], transcript, { recentCount: 5 })

  const prompt = buildRecoveryPrompt(transcript[0].content, compacted)
  assert.ok(prompt.includes("CREA UNA APP DE PEDIDOS PARA MI CAFETERÍA"))
  assert.ok(prompt.includes("productType: pedidos cafetería"))
  assert.ok(prompt.includes('plan-b — "UI de pedidos" (in_progress)'))
  assert.ok(prompt.includes("INSTRUCCIÓN DE CONTINUACIÓN"))
})
