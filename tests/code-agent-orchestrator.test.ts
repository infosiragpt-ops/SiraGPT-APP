/**
 * Tests for the pure /code agent orchestrator (FSM) + the SRE tier-0
 * build-error classifier. No React, no network — fully deterministic.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { defaultAgentState, type AgentState } from "../lib/code-agent/types"
import {
  classifyBuildError,
  isBuildLog,
  isBuildRequest,
  mergeOverridesIntoPackageJson,
  nextAgentAction,
  promptFromContext,
  renderFiveSections,
} from "../lib/code-agent/orchestrator"

function state(partial: Partial<AgentState> = {}): AgentState {
  return { ...defaultAgentState(), ...partial }
}

// ---- intake gate ----------------------------------------------------------

test("app build request starts the intake with the product question", () => {
  const a = nextAgentAction(state(), "hazme una landing para vender ropa", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "ask")
  if (a.type === "ask") {
    assert.match(a.question, /producto o servicio/i)
    assert.equal(a.nextStep, 1)
  }
})

test("intake advances through brand then style, filling slots", () => {
  // step 1 already asked productType; user answers it
  const a1 = nextAgentAction(state({ phase: "intake", intakeStep: 1 }), "ropa streetwear", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a1.type, "ask")
  if (a1.type === "ask") {
    assert.match(a1.question, /nombre/i)
    assert.equal(a1.context.productType, "ropa streetwear")
    assert.equal(a1.nextStep, 2)
  }
  // step 2: answer brand → ask style
  const a2 = nextAgentAction(
    state({ phase: "intake", intakeStep: 2, context: { goal: "landing", productType: "ropa" } }),
    "Farceque",
    { mode: "app", hasModel: true },
  )
  assert.equal(a2.type, "ask")
  if (a2.type === "ask") {
    assert.match(a2.question, /estilo/i)
    assert.equal(a2.context.brand, "Farceque")
    assert.equal(a2.nextStep, 3)
  }
})

test("after 3 questions the agent generates (LLM tier when model present)", () => {
  const a = nextAgentAction(
    state({ phase: "intake", intakeStep: 3, context: { goal: "landing", productType: "ropa", brand: "Farceque" } }),
    "streetwear minimalista oscuro",
    { mode: "app", hasModel: true },
  )
  assert.equal(a.type, "generate")
  if (a.type === "generate") {
    assert.equal(a.tier, "llm")
    assert.equal(a.context.styleAudience, "streetwear minimalista oscuro")
  }
})

test('"genera ya" during intake skips remaining questions', () => {
  const a = nextAgentAction(state({ phase: "intake", intakeStep: 1 }), "genera ya", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "generate")
})

test("a rich prompt (>160 chars) skips the intake", () => {
  const long = "Quiero una landing para mi marca de ropa premium ".repeat(5)
  const a = nextAgentAction(state(), long, { mode: "app", hasModel: true })
  assert.equal(a.type, "generate")
})

test('"propón uno" leaves the brand slot empty', () => {
  const a = nextAgentAction(state({ phase: "intake", intakeStep: 2, context: { goal: "landing" } }), "propón uno", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "ask")
  if (a.type === "ask") assert.equal(a.context.brand, undefined)
})

// ---- forced / tiers -------------------------------------------------------

test("forceDeterministic generates immediately in the deterministic tier", () => {
  const a = nextAgentAction(state(), "una tienda", { mode: "app", forceDeterministic: true, hasModel: true })
  assert.equal(a.type, "generate")
  if (a.type === "generate") assert.equal(a.tier, "deterministic")
})

test("no model → generation falls back to the deterministic tier", () => {
  const a = nextAgentAction(state({ phase: "intake", intakeStep: 3 }), "moderno", { mode: "app", hasModel: false })
  assert.equal(a.type, "generate")
  if (a.type === "generate") assert.equal(a.tier, "deterministic")
})

// ---- other transitions ----------------------------------------------------

test("preview + non-build text → patch (iterate)", () => {
  const a = nextAgentAction(state({ phase: "preview" }), "añade una sección de precios", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "patch")
})

test("ask/plan modes pass through to plain chat", () => {
  assert.equal(nextAgentAction(state(), "¿qué hace este archivo?", { mode: "ask", hasModel: true }).type, "passthrough")
  assert.equal(nextAgentAction(state(), "planea la arquitectura", { mode: "plan", hasModel: true }).type, "passthrough")
})

test("debug mode and pasted logs route to the SRE agent", () => {
  assert.equal(nextAgentAction(state(), "algo se rompió", { mode: "debug", hasModel: true }).type, "debug")
  const log = "npm error 404 Not Found - GET https://registry.npmjs.org/@x/y"
  assert.equal(nextAgentAction(state(), log, { mode: "app", hasModel: true }).type, "debug")
})

// ---- helpers --------------------------------------------------------------

test("isBuildRequest / isBuildLog heuristics", () => {
  assert.equal(isBuildRequest("hazme una app"), true)
  assert.equal(isBuildRequest("hola"), false)
  assert.equal(isBuildLog("npm ERR! code ERESOLVE"), true)
  assert.equal(isBuildLog("buenas tardes"), false)
})

test("promptFromContext builds a landing prompt", () => {
  const p = promptFromContext({ goal: "landing", brand: "Farceque", productType: "ropa", styleAudience: "oscuro" })
  assert.match(p, /Landing one-page de Farceque para ropa estilo oscuro/)
})

// ---- SRE tier-0 classifier ------------------------------------------------

test("classifyBuildError detects a 404 tarball and proposes overrides", () => {
  const log =
    "npm error 404 Not Found - GET https://registry.npmjs.org/@opentelemetry/resource-detector-aws/-/resource-detector-aws-1.2.3.tgz\n" +
    "npm error 404 '@opentelemetry/resource-detector-aws@1.2.3' is not in this registry."
  const v = classifyBuildError(log)
  assert.equal(v.matched, true)
  assert.equal(v.category, "registry_404_tarball")
  assert.ok(v.suggestedOverrides)
  assert.equal(v.suggestedOverrides!["@opentelemetry/resource-detector-aws"], "1.2.3")
})

test("classifyBuildError detects ERESOLVE", () => {
  assert.equal(classifyBuildError("npm ERR! ERESOLVE could not resolve dependency").category, "eresolve_peer")
})

test("classifyBuildError falls back to a generic verdict", () => {
  const v = classifyBuildError("something exploded")
  assert.equal(v.matched, false)
  assert.equal(v.category, "generic_build_failure")
})

test("renderFiveSections emits the strict 5-section format", () => {
  const md = renderFiveSections(classifyBuildError("npm error 404 GET @a/b"))
  for (const h of ["**Diagnóstico:**", "**Qué pasaba:**", "**Causa raíz:**", "**Arreglo:**", "**Siguiente paso:**"]) {
    assert.ok(md.includes(h), `missing section ${h}`)
  }
})

test("mergeOverridesIntoPackageJson merges and stays valid JSON", () => {
  const out = mergeOverridesIntoPackageJson('{"name":"x","overrides":{"a":"1"}}', { b: "2" })
  assert.ok(out)
  const parsed = JSON.parse(out!)
  assert.deepEqual(parsed.overrides, { a: "1", b: "2" })
})

test("mergeOverridesIntoPackageJson returns null on invalid JSON", () => {
  assert.equal(mergeOverridesIntoPackageJson("not json", { a: "1" }), null)
})
