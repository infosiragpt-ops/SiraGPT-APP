/**
 * Tests for the /code model policy: slow-model detection + fail-closed
 * Flash/Pro recommendation.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { isSlowModel, listDeepSeekGenerationModels, recommendFastModel } from "../lib/code-agent/model-policy"

test("isSlowModel flags reasoning/heavy models", () => {
  for (const id of ["openai/gpt-5.5", "gpt-5", "o1-preview", "o3-mini", "claude-opus-4", "deepseek-r1"]) {
    assert.equal(isSlowModel(id), true, `${id} should be slow`)
  }
})

test("isSlowModel does not flag fast models", () => {
  for (const id of ["deepseek-v4-flash", "deepseek-v4", "openai/gpt-4o-mini", "gemini-2.5-flash", "llama-3.1-8b", "claude-haiku-4-5"]) {
    assert.equal(isSlowModel(id), false, `${id} should be fast`)
  }
})

test("isSlowModel handles empty/nullish", () => {
  assert.equal(isSlowModel(""), false)
  assert.equal(isSlowModel(null), false)
  assert.equal(isSlowModel(undefined), false)
})

test("recommendFastModel prefers DeepSeek V4 Flash over everything else", () => {
  const models = [
    { name: "openai/gpt-5.5" },
    { name: "openai/gpt-4o-mini", provider: "OpenRouter" },
    { name: "llama-3.1-8b", provider: "Cerebras" },
    { name: "deepseek-v4-flash", provider: "DeepSeek" },
  ]
  const pick = recommendFastModel(models)
  assert.equal(pick?.name, "deepseek-v4-flash")
})

test("recommendFastModel is fail-closed when no Flash/Pro is present", () => {
  const pick = recommendFastModel([{ name: "openai/gpt-5.5" }, { name: "openai/gpt-4o-mini" }])
  assert.equal(pick, null)
})

test("recommendFastModel returns null when only slow models exist", () => {
  assert.equal(recommendFastModel([{ name: "gpt-5.5" }, { name: "o1" }]), null)
})

test("recommendFastModel returns null on empty input", () => {
  assert.equal(recommendFastModel([]), null)
})

test("recommendFastModel can pick Pro when Flash is absent", () => {
  const pick = recommendFastModel([{ name: "deepseek-v4-pro", provider: "DeepSeek" }, { name: "openai/gpt-4o-mini" }])
  assert.equal(pick?.name, "deepseek-v4-pro")
})

test("listDeepSeekGenerationModels drops OpenRouter and other providers", () => {
  const listed = listDeepSeekGenerationModels([
    { name: "deepseek-v4-flash", provider: "DeepSeek" },
    { name: "deepseek-v4-pro", provider: "OpenRouter" },
    { name: "gpt-4o-mini", provider: "OpenAI" },
  ])
  assert.deepEqual(listed.map((model) => model.name), ["deepseek-v4-flash"])
})
