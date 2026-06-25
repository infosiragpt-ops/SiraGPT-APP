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
  isQuickGreeting,
  mergeOverridesIntoPackageJson,
  nextAgentAction,
  promptFromContext,
  renderFiveSections,
} from "../lib/code-agent/orchestrator"

function state(partial: Partial<AgentState> = {}): AgentState {
  return { ...defaultAgentState(), ...partial }
}

// ---- autonomous build routing ---------------------------------------------

test("app build request generates immediately with an autonomous brief", () => {
  const a = nextAgentAction(state(), "hazme una landing para vender ropa", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "generate")
  if (a.type === "generate") {
    assert.equal(a.tier, "llm")
    assert.equal(a.context.goal, "landing")
    assert.equal(a.context.productType, "hazme una landing para vender ropa")
  }
})

test("legacy intake answer now generates instead of asking another question", () => {
  // step 1 already asked productType; user answers it
  const a1 = nextAgentAction(state({ phase: "intake", intakeStep: 1 }), "ropa streetwear", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a1.type, "generate")
  if (a1.type === "generate") {
    assert.equal(a1.context.productType, "ropa streetwear")
  }
  // step 2: answer brand → generate with accumulated context
  const a2 = nextAgentAction(
    state({ phase: "intake", intakeStep: 2, context: { goal: "landing", productType: "ropa" } }),
    "Farceque",
    { mode: "app", hasModel: true },
  )
  assert.equal(a2.type, "generate")
  if (a2.type === "generate") {
    assert.equal(a2.context.brand, "Farceque")
  }
})

test("noun-only app prompt generates directly", () => {
  const a = nextAgentAction(
    state(),
    "una tienda",
    { mode: "app", hasModel: true },
  )
  assert.equal(a.type, "generate")
  if (a.type === "generate") {
    assert.equal(a.tier, "llm")
    assert.equal(a.context.productType, "una tienda")
  }
})

test("app request sets app goal and generates directly", () => {
  const a = nextAgentAction(
    state(),
    "crea una app de gestión con panel corporativo",
    { mode: "app", hasModel: true },
  )
  assert.equal(a.type, "generate")
  if (a.type === "generate") {
    assert.equal(a.context.goal, "app")
  }
})

test('"genera ya" during legacy intake generates immediately', () => {
  const a = nextAgentAction(state({ phase: "intake", intakeStep: 1 }), "genera ya", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "generate")
})

test("a rich prompt generates immediately", () => {
  const long = "Quiero una landing para mi marca de ropa premium ".repeat(5)
  const a = nextAgentAction(state(), long, { mode: "app", hasModel: true })
  assert.equal(a.type, "generate")
})

test('"propón uno" leaves the brand slot empty', () => {
  const a = nextAgentAction(state({ phase: "intake", intakeStep: 2, context: { goal: "landing" } }), "propón uno", {
    mode: "app",
    hasModel: true,
  })
  assert.equal(a.type, "generate")
  if (a.type === "generate") assert.equal(a.context.brand, undefined)
})

// ---- forced / tiers -------------------------------------------------------

test("forceDeterministic generates immediately in the deterministic tier", () => {
  const a = nextAgentAction(state(), "una tienda", { mode: "app", forceDeterministic: true, hasModel: true })
  assert.equal(a.type, "generate")
  if (a.type === "generate") assert.equal(a.tier, "deterministic")
})

test("no model → generation falls back to the deterministic tier", () => {
  // Legacy intake state still generates without asking another question.
  const a = nextAgentAction(state({ phase: "intake", intakeStep: 5 }), "moderno", { mode: "app", hasModel: false })
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
  // "realiza/realizar/desarrolla" must count as build verbs.
  assert.equal(isBuildRequest("realiza un landing"), true)
  assert.equal(isBuildRequest("realízame una web"), true)
  assert.equal(isBuildRequest("desarrolla una tienda"), true)
  assert.equal(isBuildRequest("hola"), false)
  assert.equal(isQuickGreeting("hola"), true)
  assert.equal(isQuickGreeting("hola, ¿cómo estás?"), true)
  assert.equal(isQuickGreeting("hola hazme una app"), false)
  assert.equal(isBuildLog("npm ERR! code ERESOLVE"), true)
  assert.equal(isBuildLog("buenas tardes"), false)
})

test('"realiza un landing" generates directly (not an intake question)', () => {
  const a = nextAgentAction(state(), "realiza un landing", { mode: "app", hasModel: true })
  assert.equal(a.type, "generate")
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
