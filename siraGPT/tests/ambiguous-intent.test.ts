import test from "node:test"
import assert from "node:assert/strict"

import {
  buildProfessionalCapabilityPrompt,
  classifyIntentFastPath,
  isAmbiguousPrompt,
  PROFESSIONAL_CAPABILITY_CONTRACTS,
  PROFESSIONAL_EXECUTION_SKELETON,
  VALID_CHAT_INTENTS,
} from "../lib/ai-service"

test("ambiguous intent is registered alongside the other chat intents", () => {
  assert.equal(VALID_CHAT_INTENTS.includes("ambiguous"), true)
  assert.equal(typeof PROFESSIONAL_CAPABILITY_CONTRACTS.ambiguous, "string")
  assert.match(PROFESSIONAL_CAPABILITY_CONTRACTS.ambiguous!, /one short clarifying question|EXACTLY ONE/i)
})

test("isAmbiguousPrompt flags bare lead verbs", () => {
  assert.equal(isAmbiguousPrompt("ayúdame"), true)
  assert.equal(isAmbiguousPrompt("hazme algo"), true)
  assert.equal(isAmbiguousPrompt("necesito ayuda"), true)
  assert.equal(isAmbiguousPrompt("dame uno"), true)
})

test("isAmbiguousPrompt flags bare deliverable nouns", () => {
  assert.equal(isAmbiguousPrompt("informe"), true)
  assert.equal(isAmbiguousPrompt("excel"), true)
  assert.equal(isAmbiguousPrompt("presentacion"), true)
})

test("isAmbiguousPrompt does not flag greetings or complete requests", () => {
  assert.equal(isAmbiguousPrompt("hola"), false, "greetings stay conversational")
  assert.equal(isAmbiguousPrompt("buenos dias"), false)
  assert.equal(isAmbiguousPrompt("ayúdame con la tesis"), false, "concrete object resolves the ambiguity")
  assert.equal(isAmbiguousPrompt("genera un informe en Word"), false)
  assert.equal(isAmbiguousPrompt("dime sobre Python"), false)
  assert.equal(isAmbiguousPrompt("¿qué es Cronbach alpha?"), false, "questions are never ambiguous")
})

test("classifyIntentFastPath routes ambiguous prompts to the clarifier contract", () => {
  assert.equal(classifyIntentFastPath("ayúdame"), "ambiguous")
  assert.equal(classifyIntentFastPath("informe"), "ambiguous")
  assert.equal(classifyIntentFastPath("necesito ayuda"), "ambiguous")
})

test("classifyIntentFastPath does not regress greetings or work prompts", () => {
  assert.equal(classifyIntentFastPath("hola"), "text")
  assert.equal(classifyIntentFastPath("buenos dias"), "text")
  // 'plan' lives in routing patterns; the work-intent path should win
  // before ambiguity is checked when the request is concrete enough.
  assert.notEqual(classifyIntentFastPath("genera un informe en Word"), "ambiguous")
})

test("buildProfessionalCapabilityPrompt injects the 5-step skeleton for executing intents", () => {
  const wrapped = buildProfessionalCapabilityPrompt("doc", "genera un informe en Word")
  assert.match(wrapped, /execution skeleton/)
  assert.match(wrapped, /1\. Analyze intent/)
  assert.match(wrapped, /5\. Cite sources/)
  assert.match(wrapped, /professional execution contract for doc/)
})

test("buildProfessionalCapabilityPrompt skips the skeleton for ambiguous", () => {
  const wrapped = buildProfessionalCapabilityPrompt("ambiguous", "ayúdame")
  // Ambiguous contract's job is to ask one question — wrapping it in the
  // 5-step skeleton would push the model to fabricate a plan first.
  assert.equal(wrapped.includes(PROFESSIONAL_EXECUTION_SKELETON), false)
  assert.match(wrapped, /professional execution contract for ambiguous/)
  assert.match(wrapped, /one short clarifying question/i)
})

test("buildProfessionalCapabilityPrompt is a no-op when no contract exists", () => {
  // 'gmail' is in PROFESSIONAL_CAPABILITY_CONTRACTS as undefined; it
  // should pass through untouched without throwing.
  const original = "lee mis correos"
  const wrapped = buildProfessionalCapabilityPrompt("gmail", original)
  assert.equal(wrapped, original)
})
