/**
 * Tests for the /code model policy: slow-model detection + fast-model
 * recommendation used by the "switch to a fast model" consent alert.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { isSlowModel, recommendFastModel } from "../lib/code-agent/model-policy"

test("isSlowModel flags reasoning/heavy models", () => {
  for (const id of ["openai/gpt-5.5", "gpt-5", "o1-preview", "o3-mini", "claude-opus-4", "deepseek-r1"]) {
    assert.equal(isSlowModel(id), true, `${id} should be slow`)
  }
})

test("isSlowModel does not flag fast models", () => {
  for (const id of ["openai/gpt-4o-mini", "gemini-2.5-flash", "llama-3.1-8b", "claude-haiku-4-5"]) {
    assert.equal(isSlowModel(id), false, `${id} should be fast`)
  }
})

test("isSlowModel handles empty/nullish", () => {
  assert.equal(isSlowModel(""), false)
  assert.equal(isSlowModel(null), false)
  assert.equal(isSlowModel(undefined), false)
})

test("recommendFastModel prefers the fastest available, never a slow one", () => {
  const models = [
    { name: "openai/gpt-5.5" },
    { name: "openai/gpt-4o-mini", provider: "OpenRouter" },
    { name: "llama-3.1-8b", provider: "Cerebras" },
  ]
  const pick = recommendFastModel(models)
  assert.equal(pick?.name, "llama-3.1-8b") // Cerebras/llama is top priority
})

test("recommendFastModel falls back to gpt-4o-mini when no flash model", () => {
  const pick = recommendFastModel([{ name: "openai/gpt-5.5" }, { name: "openai/gpt-4o-mini" }])
  assert.equal(pick?.name, "openai/gpt-4o-mini")
})

test("recommendFastModel returns null when only slow models exist", () => {
  assert.equal(recommendFastModel([{ name: "gpt-5.5" }, { name: "o1" }]), null)
})

test("recommendFastModel returns null on empty input", () => {
  assert.equal(recommendFastModel([]), null)
})
