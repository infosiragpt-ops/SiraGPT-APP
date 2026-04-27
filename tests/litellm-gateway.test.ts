import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const gateway = require(path.join(
  process.cwd(),
  "backend/src/services/ai-product-os/litellm-gateway.js",
))
const modelAdapter = require(path.join(
  process.cwd(),
  "backend/src/services/sira/model-adapter.js",
))

describe("litellm gateway · provider normalization and route contracts", () => {
  it("normalizes known model names into OpenAI-shaped deployment metadata", () => {
    const plan = gateway.createGatewayPlan({
      selectedModel: { provider: "deepseek", modelId: "deepseek-v4-pro", modality: "text" },
      messages: [{ role: "user", content: "hola" }],
      responseFormat: "json_schema",
      tools: [{ type: "function", function: { name: "search" } }],
    })

    assert.equal(plan.schema_version, "sira.litellm_gateway_plan.v1")
    assert.equal(plan.primary.provider, "deepseek")
    assert.equal(plan.primary.request_format, "openai_chat_completions")
    assert.equal(plan.primary.api_key_env, "DEEPSEEK_API_KEY")
    assert.equal(plan.response_format, "json_schema")
    assert.equal(plan.tools_requested, 1)
    assert.equal(plan.release_gate.forbid_silent_model_switch, true)
  })

  it("infers provider from model id when an external caller omits provider", () => {
    const selected = gateway.normalizeSelectedModel({ modelId: "gemini-2.5-flash" })

    assert.equal(selected.provider, "google")
    assert.equal(selected.modelId, "gemini-2.5-flash")
  })

  it("builds DeepSeek V4 payloads with OpenClaw-style thinking controls", () => {
    const built = gateway.buildProviderChatPayload({
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      stream: true,
      thinkingLevel: "xhigh",
      messages: [
        { role: "user", content: "hola" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }] },
      ],
    })

    assert.equal(built.provider, "deepseek")
    assert.equal(built.runtime.contextWindow, 1_000_000)
    assert.equal(built.runtime.maxOutputTokens, 384_000)
    assert.equal(built.payload.thinking.type, "enabled")
    assert.equal(built.payload.reasoning_effort, "max")
    assert.deepEqual(built.payload.stream_options, { include_usage: true })
    assert.equal(built.payload.messages[1].reasoning_content, "")
  })

  it("strips reasoning content when a provider should not receive it", () => {
    const built = gateway.buildProviderChatPayload({
      provider: "OpenAI",
      model: "gpt-4o",
      messages: [{ role: "assistant", content: "ok", reasoning_content: "hidden" }],
    })

    assert.equal("reasoning_content" in built.payload.messages[0], false)
  })

  it("disables DeepSeek V4 thinking explicitly without leaking replayed reasoning", () => {
    const built = gateway.buildProviderChatPayload({
      provider: "DeepSeek",
      model: "deepseek-v4-pro",
      thinkingLevel: "off",
      messages: [{ role: "assistant", content: "ok", reasoning_content: "old trace" }],
    })

    assert.equal(built.payload.thinking.type, "disabled")
    assert.equal("reasoning_effort" in built.payload, false)
    assert.equal("reasoning_content" in built.payload.messages[0], false)
  })

  it("avoids JSON response_format on Gemini OpenAI-compatible calls", () => {
    const built = gateway.buildProviderChatPayload({
      provider: "Gemini",
      model: "gemini-2.5-flash",
      responseFormat: "json",
      messages: [{ role: "user", content: "devuelve json" }],
    })

    assert.equal(built.provider, "google")
    assert.equal("response_format" in built.payload, false)
  })

  it("classifies provider transport failures from SDK and HTTP error shapes", () => {
    const rateLimit = gateway.classifyProviderError({ response: { status: 429 }, message: "too many requests" })
    const network = gateway.classifyProviderError({ code: "ECONNRESET", message: "socket closed" })
    const conflict = gateway.classifyProviderError({ status: 409, message: "model busy" })
    const badRequest = gateway.classifyProviderError({ status: 400, message: "bad request" })

    assert.equal(rateLimit.error_class, "rate_limit")
    assert.equal(rateLimit.retryable, true)
    assert.equal(network.error_class, "provider_unavailable")
    assert.equal(network.retryable, true)
    assert.equal(conflict.error_class, "provider_unavailable")
    assert.equal(conflict.retryable, true)
    assert.equal(badRequest.error_class, "bad_request")
    assert.equal(badRequest.retryable, false)
  })
})
describe("litellm gateway · dispatch policy", () => {
  it("routes through the selected provider and records an auditable trace", async () => {
    const providers = {
      openai: async ({ selectedModel }: any) => ({
        text: `ok:${selectedModel.modelId}`,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }

    const result = await modelAdapter.callUserSelectedModel(
      {
        selectedModel: { provider: "openai", modelId: "gpt-5-mini", modality: "text" },
        systemPrompt: "system",
        messages: [{ role: "user", content: "hola" }],
      },
      { providers },
    )

    assert.equal(result.provider, "openai")
    assert.equal(result.modelId, "gpt-5-mini")
    assert.equal(result.text, "ok:gpt-5-mini")
    assert.equal(result.fallback_used, false)
    assert.equal(result.gateway_trace.final, "openai:gpt-5-mini")
    assert.equal(result.gateway_trace.attempts[0].status, "success")
  })

  it("keeps fallback disabled by default so user-selected models cannot silently switch", async () => {
    const providers = {
      openai: async () => {
        const error: any = new Error("rate limit")
        error.status = 429
        throw error
      },
      google: async () => ({ text: "fallback should not run" }),
    }

    await assert.rejects(
      modelAdapter.callUserSelectedModel(
        {
          selectedModel: { provider: "openai", modelId: "gpt-5-mini", modality: "text" },
          messages: [{ role: "user", content: "hola" }],
        },
        {
          providers,
          gatewayPolicy: {
            fallbacks: [{ provider: "google", modelId: "gemini-2.5-flash", modality: "text" }],
          },
        },
      ),
      /all model gateway deployments failed/,
    )
  })

  it("uses fallback only when policy explicitly authorizes it", async () => {
    let googleCalls = 0
    const providers = {
      openai: async () => {
        const error: any = new Error("rate limit")
        error.status = 429
        throw error
      },
      google: async ({ selectedModel }: any) => {
        googleCalls += 1
        return {
          text: `fallback:${selectedModel.modelId}`,
          usage: { input_tokens: 8, output_tokens: 4 },
        }
      },
    }

    const result = await modelAdapter.callUserSelectedModel(
      {
        selectedModel: { provider: "openai", modelId: "gpt-5-mini", modality: "text" },
        messages: [{ role: "user", content: "hola" }],
      },
      {
        providers,
        gatewayPolicy: {
          allow_fallbacks: true,
          max_retries: 0,
          fallbacks: [{ provider: "google", modelId: "gemini-2.5-flash", modality: "text" }],
        },
      },
    )

    assert.equal(googleCalls, 1)
    assert.equal(result.provider, "google")
    assert.equal(result.modelId, "gemini-2.5-flash")
    assert.equal(result.text, "fallback:gemini-2.5-flash")
    assert.equal(result.fallback_used, true)
    assert.equal(result.gateway_trace.primary, "openai:gpt-5-mini")
    assert.equal(result.gateway_trace.final, "google:gemini-2.5-flash")
  })

  it("blocks calls whose projected route cost exceeds the configured budget", async () => {
    await assert.rejects(
      modelAdapter.callUserSelectedModel(
        {
          selectedModel: { provider: "openai", modelId: "gpt-5", modality: "text" },
          messages: [{ role: "user", content: "x".repeat(2000) }],
        },
        {
          providers: { openai: async () => ({ text: "not reached" }) },
          gatewayPolicy: { max_cost_usd: 0.000001, max_output_tokens: 1000 },
        },
      ),
      /exceeds budget/,
    )
  })
})
