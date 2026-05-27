import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  compareModelProviders,
  resolveModelIconName,
  resolveModelProviderName,
  resolveProviderIconName,
} from "../lib/model-icons"

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

  it("identifies provider brands hidden behind OpenRouter", () => {
    assert.equal(resolveModelIconName({ name: "nvidia/nemotron-3-super-120b-a12b", provider: "OpenRouter", icon: "OpenRouterLogo" }), "NvidiaLogo")
    assert.equal(resolveModelIconName({ name: "poolside/laguna-m.1:free", provider: "OpenRouter", icon: "OpenRouterLogo" }), "PoolsideLogo")
    assert.equal(resolveModelIconName({ name: "ollama/llama3.2", provider: "OpenRouter", icon: "OpenRouterLogo" }), "OllamaLogo")
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
    assert.equal(resolveModelIconName({ provider: "nvidia" }), "NvidiaLogo")
    assert.equal(resolveModelIconName({ provider: "poolside" }), "PoolsideLogo")
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

describe("resolveModelProviderName", () => {
  it("groups OpenRouter-routed models by their real model brand", () => {
    assert.equal(resolveModelProviderName({ name: "openai/gpt-5.5", provider: "OpenRouter" }), "OpenAI")
    assert.equal(resolveModelProviderName({ name: "anthropic/claude-opus-4.7", provider: "OpenRouter" }), "Anthropic")
    assert.equal(resolveModelProviderName({ name: "google/gemini-3.1-flash-lite", provider: "OpenRouter" }), "Google")
    assert.equal(resolveModelProviderName({ name: "moonshotai/kimi-k2.6", provider: "OpenRouter" }), "Moonshot AI")
    assert.equal(resolveModelProviderName({ name: "qwen/qwen3.7-max", provider: "OpenRouter" }), "Qwen")
    assert.equal(resolveModelProviderName({ name: "meta-llama/llama-3.1-70b-instruct", provider: "OpenRouter" }), "Meta")
    assert.equal(resolveModelProviderName({ name: "mistralai/mistral-medium-3-5", provider: "OpenRouter" }), "Mistral AI")
    assert.equal(resolveModelProviderName({ name: "nvidia/nemotron-3-super-120b-a12b", provider: "OpenRouter" }), "NVIDIA")
    assert.equal(resolveModelProviderName({ name: "poolside/laguna-xs.2:free", provider: "OpenRouter" }), "Poolside")
    assert.equal(resolveModelProviderName({ name: "z-ai/glm-5.1", provider: "OpenRouter" }), "Z.ai")
  })

  it("keeps unknown routed models under their configured provider", () => {
    assert.equal(resolveModelProviderName({ name: "openrouter/free", provider: "OpenRouter" }), "OpenRouter")
    assert.equal(resolveModelProviderName({ name: "internal-model", provider: "Internal" }), "Internal")
    assert.equal(resolveModelProviderName({}), "Otros")
  })

  it("sorts premium providers before unknown providers", () => {
    assert.deepEqual(
      ["Poolside", "Internal", "OpenAI", "Qwen"].sort(compareModelProviders),
      ["OpenAI", "Qwen", "Poolside", "Internal"],
    )
  })

  it("resolves provider header icons", () => {
    assert.equal(resolveProviderIconName("NVIDIA"), "NvidiaLogo")
    assert.equal(resolveProviderIconName("Poolside"), "PoolsideLogo")
    assert.equal(resolveProviderIconName("Moonshot AI"), "KimiLogo")
  })
})
