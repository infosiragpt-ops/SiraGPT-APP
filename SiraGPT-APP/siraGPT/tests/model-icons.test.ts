import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveModelIconName } from "../lib/model-icons"

/**
 * resolveModelIconName picks the brand glyph for a model card. It
 * walks three signals in priority order:
 *   1. Substring patterns on name + displayName
 *   2. Explicit `icon` field (unless it's OpenRouterLogo, which is a
 *      generic gateway and should yield to a more specific signal)
 *   3. Provider string
 * Last resort: the explicit icon (even OpenRouterLogo) or "Bot".
 */

describe("resolveModelIconName · brand detection by name", () => {
  it("falls back to Bot for null / undefined / empty input", () => {
    assert.equal(resolveModelIconName(null), "Bot")
    assert.equal(resolveModelIconName(undefined), "Bot")
    assert.equal(resolveModelIconName({}), "Bot")
  })

  it("identifies OpenAI GPT / ChatGPT / DALL-E by name", () => {
    assert.equal(resolveModelIconName({ name: "gpt-4o" }), "ChatGPTLogo")
    assert.equal(resolveModelIconName({ name: "chatgpt-pro" }), "ChatGPTLogo")
    assert.equal(resolveModelIconName({ name: "dall-e-3" }), "ChatGPTLogo")
    assert.equal(resolveModelIconName({ name: "dalle 2" }), "ChatGPTLogo")
    // openai/ prefix common in OpenRouter ids.
    assert.equal(resolveModelIconName({ name: "openai/gpt-4-turbo" }), "ChatGPTLogo")
  })

  it("identifies Google models (Gemini, Imagen, Veo)", () => {
    assert.equal(resolveModelIconName({ name: "gemini-1.5-pro" }), "GeminiLogo")
    assert.equal(resolveModelIconName({ name: "imagen-3" }), "GeminiLogo")
    assert.equal(resolveModelIconName({ name: "veo-2" }), "GeminiLogo")
    assert.equal(resolveModelIconName({ name: "google/gemini-2-flash" }), "GeminiLogo")
  })

  it("identifies Anthropic Claude models", () => {
    assert.equal(resolveModelIconName({ name: "claude-3-opus" }), "ClaudeLogo")
    assert.equal(resolveModelIconName({ name: "anthropic/claude-3-5-sonnet" }), "ClaudeLogo")
  })

  it("identifies xAI Grok by both name and slash-prefixed id", () => {
    assert.equal(resolveModelIconName({ name: "grok-2" }), "GrokLogo")
    assert.equal(resolveModelIconName({ name: "x-ai/grok-beta" }), "GrokLogo")
  })

  it("identifies Deepseek, Kimi/Moonshot, Z.AI/GLM, Seedream, Qwen, Llama, Mistral", () => {
    assert.equal(resolveModelIconName({ name: "deepseek-chat" }), "DeepseekLogo")
    assert.equal(resolveModelIconName({ name: "kimi-k2" }), "KimiLogo")
    assert.equal(resolveModelIconName({ name: "moonshot-v1" }), "KimiLogo")
    assert.equal(resolveModelIconName({ name: "z-ai/glm-4" }), "ZaiLogo")
    assert.equal(resolveModelIconName({ name: "chatglm-3" }), "ZaiLogo")
    assert.equal(resolveModelIconName({ name: "doubao-pro" }), "SeedreamLogo")
    assert.equal(resolveModelIconName({ name: "seedream-3" }), "SeedreamLogo")
    assert.equal(resolveModelIconName({ name: "qwen2.5-72b" }), "QwenLogo")
    assert.equal(resolveModelIconName({ name: "meta-llama/llama-3-70b" }), "MetaLogo")
    assert.equal(resolveModelIconName({ name: "mistral-large" }), "MistralLogo")
    assert.equal(resolveModelIconName({ name: "codestral-22b" }), "MistralLogo")
  })

  it("matches on displayName when name is missing", () => {
    assert.equal(resolveModelIconName({ displayName: "GPT-4o (high)" }), "ChatGPTLogo")
    assert.equal(resolveModelIconName({ displayName: "Claude 3 Sonnet" }), "ClaudeLogo")
  })
})

describe("resolveModelIconName · fallback chain", () => {
  it("uses explicit icon when no name pattern matches", () => {
    assert.equal(
      resolveModelIconName({ name: "internal-model", icon: "CustomLogo" }),
      "CustomLogo",
    )
  })

  it("ignores explicit OpenRouterLogo so a more specific signal can win", () => {
    // The model name doesn't match a brand, but the provider does.
    assert.equal(
      resolveModelIconName({
        name: "internal-model",
        icon: "OpenRouterLogo",
        provider: "openai",
      }),
      "ChatGPTLogo",
    )
  })

  it("falls back to provider when neither name nor icon resolves", () => {
    assert.equal(resolveModelIconName({ provider: "anthropic" }), "ClaudeLogo")
    assert.equal(resolveModelIconName({ provider: "google" }), "GeminiLogo")
    assert.equal(resolveModelIconName({ provider: "deepseek" }), "DeepseekLogo")
    assert.equal(resolveModelIconName({ provider: "xai" }), "GrokLogo")
    assert.equal(resolveModelIconName({ provider: "openrouter" }), "OpenRouterLogo")
  })

  it("returns the explicit icon (even OpenRouterLogo) as final fallback", () => {
    assert.equal(
      resolveModelIconName({ name: "internal-model", icon: "OpenRouterLogo" }),
      "OpenRouterLogo",
    )
  })

  it("returns Bot when there is no signal at all", () => {
    assert.equal(resolveModelIconName({ name: "internal-model" }), "Bot")
  })
})
