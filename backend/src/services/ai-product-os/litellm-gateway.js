"use strict";

/**
 * litellm-gateway — internal LiteLLM-inspired model gateway.
 *
 * This module does not vendor LiteLLM. It brings the same operating
 * principles into Sira's Node backend: one OpenAI-shaped request
 * contract, deterministic provider normalization, retry/fallback
 * policies, cost estimates, and an auditable route trace.
 *
 * Default policy is conservative: no fallback model switch happens
 * unless the caller explicitly opts in with allow_fallbacks=true.
 */

const DEFAULT_RETRY_ON = Object.freeze([
  "rate_limit",
  "timeout",
  "provider_unavailable",
  "server_error",
]);

const PROVIDER_MANIFESTS = Object.freeze({
  openai: {
    provider: "openai",
    display_name: "OpenAI",
    api_key_env: "OPENAI_API_KEY",
    base_url: "https://api.openai.com/v1",
    request_format: "openai_chat_completions",
    supports: { text: true, multimodal: true, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: 2.5, output: 10 },
  },
  anthropic: {
    provider: "anthropic",
    display_name: "Anthropic",
    api_key_env: "ANTHROPIC_API_KEY",
    base_url: "https://api.anthropic.com",
    request_format: "adapter_to_openai_chat_completions",
    supports: { text: true, multimodal: true, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: 3, output: 15 },
  },
  google: {
    provider: "google",
    display_name: "Google Gemini",
    api_key_env: "GEMINI_API_KEY",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    request_format: "openai_chat_completions",
    supports: { text: true, multimodal: true, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: 1.25, output: 10 },
  },
  deepseek: {
    provider: "deepseek",
    display_name: "DeepSeek",
    api_key_env: "DEEPSEEK_API_KEY",
    base_url: "https://api.deepseek.com",
    request_format: "openai_chat_completions",
    supports: { text: true, multimodal: false, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: 0.27, output: 1.1 },
  },
  xai: {
    provider: "xai",
    display_name: "xAI",
    api_key_env: "XAI_API_KEY",
    base_url: "https://api.x.ai/v1",
    request_format: "openai_chat_completions",
    supports: { text: true, multimodal: true, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: 3, output: 15 },
  },
  openrouter: {
    provider: "openrouter",
    display_name: "OpenRouter",
    api_key_env: "OPENROUTER_API_KEY",
    base_url: "https://openrouter.ai/api/v1",
    request_format: "openai_chat_completions",
    supports: { text: true, multimodal: true, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: 0.6, output: 2.4 },
  },
  custom: {
    provider: "custom",
    display_name: "Custom OpenAI-compatible provider",
    api_key_env: "CUSTOM_LLM_API_KEY",
    base_url: null,
    request_format: "openai_chat_completions",
    supports: { text: true, multimodal: true, tools: true, structured_outputs: true, streaming: true },
    cost_per_1m_tokens_usd: { input: null, output: null },
  },
});

const MODEL_PROVIDER_HINTS = Object.freeze([
  { test: /^gpt-|^o\d|^chatgpt/i, provider: "openai" },
  { test: /^claude|anthropic\//i, provider: "anthropic" },
  { test: /^gemini|google\//i, provider: "google" },
  { test: /^deepseek|deepseek\//i, provider: "deepseek" },
  { test: /^grok|xai\//i, provider: "xai" },
  { test: /\//, provider: "openrouter" },
]);

function normalizeProvider(provider, modelId = "") {
  const raw = String(provider || "").trim().toLowerCase();
  if (raw && PROVIDER_MANIFESTS[raw]) return raw;
  const model = String(modelId || "").trim();
  const inferred = MODEL_PROVIDER_HINTS.find((hint) => hint.test.test(model));
  return inferred?.provider || "custom";
}

function normalizeSelectedModel(selection = {}) {
  const modelId = String(selection.modelId || selection.model_id || selection.id || "").trim();
  if (!modelId) throw gatewayError("missing_model_id", "selectedModel.modelId is required");
  const provider = normalizeProvider(selection.provider, modelId);
  return {
    provider,
    modelId,
    modality: selection.modality || "text",
  };
}

function estimateMessageTokens(messages = []) {
  const chars = JSON.stringify(messages || []).length;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateCostUsd({ deployment, inputTokens = 0, outputTokens = 0 }) {
  const pricing = PROVIDER_MANIFESTS[deployment.provider]?.cost_per_1m_tokens_usd;
  if (!pricing || pricing.input == null || pricing.output == null) return null;
  const input = (Number(inputTokens) / 1_000_000) * pricing.input;
  const output = (Number(outputTokens) / 1_000_000) * pricing.output;
  return roundMoney(input + output);
}

function createDeployment(selection, role = "primary") {
  const selectedModel = normalizeSelectedModel(selection);
  const manifest = PROVIDER_MANIFESTS[selectedModel.provider] || PROVIDER_MANIFESTS.custom;
  return {
    id: `${selectedModel.provider}:${selectedModel.modelId}`,
    role,
    provider: selectedModel.provider,
    model_id: selectedModel.modelId,
    modality: selectedModel.modality,
    request_format: manifest.request_format,
    base_url: selection.baseURL || selection.base_url || manifest.base_url,
    api_key_env: selection.apiKeyEnv || selection.api_key_env || manifest.api_key_env,
    supports: { ...manifest.supports },
    selected_model: selectedModel,
  };
}

function createGatewayPlan({
  selectedModel,
  messages = [],
  responseFormat = "text",
  tools = [],
  policy = {},
  fallbacks = [],
} = {}) {
  const primary = createDeployment(selectedModel, "primary");
  const allowFallbacks = policy.allow_fallbacks === true || policy.allowFallbacks === true;
  const fallbackDeployments = allowFallbacks
    ? normalizeFallbacks(fallbacks.length ? fallbacks : policy.fallbacks || [], primary)
    : [];
  const inputTokens = estimateMessageTokens(messages);
  const maxOutputTokens = Number(policy.max_output_tokens || policy.maxOutputTokens || 0);
  const projectedCost = estimateCostUsd({
    deployment: primary,
    inputTokens,
    outputTokens: maxOutputTokens,
  });

  return {
    schema_version: "sira.litellm_gateway_plan.v1",
    gateway: "sira_internal_litellm_style_gateway",
    request_format: "openai_chat_completions",
    primary,
    fallbacks: fallbackDeployments,
    response_format: responseFormat,
    tools_requested: Array.isArray(tools) ? tools.length : 0,
    estimated_input_tokens: inputTokens,
    projected_cost_usd: projectedCost,
    budget: {
      max_cost_usd: numberOrNull(policy.max_cost_usd ?? policy.maxCostUsd),
      latency_budget_ms: numberOrNull(policy.latency_budget_ms ?? policy.latencyBudgetMs),
    },
    retry_policy: {
      max_retries: clampInt(policy.max_retries ?? policy.maxRetries ?? 1, 0, 5),
      retry_on: Array.isArray(policy.retry_on) ? [...policy.retry_on] : [...DEFAULT_RETRY_ON],
    },
    release_gate: {
      forbid_unregistered_provider: true,
      forbid_silent_model_switch: !allowFallbacks,
      require_openai_shaped_response: true,
    },
  };
}

function normalizeFallbacks(fallbacks, primary) {
  const seen = new Set([primary.id]);
  const deployments = [];
  for (const fallback of fallbacks || []) {
    const deployment = createDeployment(fallback, "fallback");
    if (seen.has(deployment.id)) continue;
    seen.add(deployment.id);
    deployments.push(deployment);
  }
  return deployments;
}

async function dispatchGatewayCall({
  plan,
  payload,
  providers,
  telemetry,
} = {}) {
  if (!plan || typeof plan !== "object") throw gatewayError("missing_gateway_plan", "gateway plan is required");
  if (!payload || typeof payload !== "object") throw gatewayError("missing_payload", "gateway payload is required");
  if (!providers || typeof providers !== "object") throw gatewayError("missing_providers", "providers map is required");
  enforceBudget(plan);

  const attempts = [];
  const candidates = [plan.primary, ...(plan.fallbacks || [])];
  let lastError = null;

  for (const deployment of candidates) {
    const adapter = providers[deployment.provider];
    if (typeof adapter !== "function") {
      const missing = gatewayError("provider_adapter_missing", `provider "${deployment.provider}" has no adapter registered`);
      attempts.push(traceAttempt({ deployment, status: "skipped", error: missing }));
      lastError = missing;
      continue;
    }

    const maxAttempts = 1 + (deployment.role === "primary" ? plan.retry_policy.max_retries : 0);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        emit(telemetry, "model_gateway.attempt_started", { deployment: deployment.id, attempt });
        const output = await adapter({
          ...payload,
          selectedModel: deployment.selected_model,
          gateway: {
            plan,
            deployment,
            attempt,
          },
        });
        const latencyMs = Date.now() - startedAt;
        const usage = normalizeUsage(output?.usage);
        const cost = estimateCostUsd({
          deployment,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        });
        attempts.push(traceAttempt({ deployment, status: "success", attempt, latencyMs, usage, cost }));
        emit(telemetry, "model_gateway.attempt_succeeded", { deployment: deployment.id, attempt, latency_ms: latencyMs, cost_usd: cost });
        return {
          ok: true,
          output,
          selectedModel: deployment.selected_model,
          fallback_used: deployment.role === "fallback",
          cost,
          trace: {
            gateway: plan.gateway,
            request_format: plan.request_format,
            attempts,
            primary: plan.primary.id,
            final: deployment.id,
            fallback_used: deployment.role === "fallback",
          },
        };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const classified = classifyProviderError(error);
        attempts.push(traceAttempt({ deployment, status: "failed", attempt, latencyMs, error: classified }));
        emit(telemetry, "model_gateway.attempt_failed", { deployment: deployment.id, attempt, error_class: classified.error_class });
        lastError = classified;
        if (!shouldRetry(classified, plan.retry_policy) || attempt >= maxAttempts) break;
      }
    }
  }

  const error = gatewayError(
    "gateway_exhausted",
    `all model gateway deployments failed: ${lastError?.message || "unknown error"}`,
  );
  error.cause = lastError;
  error.gateway_trace = {
    gateway: plan.gateway,
    request_format: plan.request_format,
    attempts,
    primary: plan.primary.id,
    final: null,
    fallback_used: false,
  };
  throw error;
}

function createLiteLLMGateway({ providers, telemetry } = {}) {
  return {
    createGatewayPlan,
    async dispatch({ plan, payload }) {
      return dispatchGatewayCall({ plan, payload, providers, telemetry });
    },
  };
}

function enforceBudget(plan) {
  const max = plan?.budget?.max_cost_usd;
  if (typeof max !== "number" || max <= 0 || plan.projected_cost_usd == null) return;
  if (plan.projected_cost_usd > max) {
    const err = gatewayError(
      "budget_exceeded",
      `projected model cost ${plan.projected_cost_usd} exceeds budget ${max}`,
    );
    err.projected_cost_usd = plan.projected_cost_usd;
    err.max_cost_usd = max;
    throw err;
  }
}

function classifyProviderError(error) {
  const message = String(error?.message || error || "");
  const status = Number(error?.status || error?.statusCode || error?.code || 0);
  const code = String(error?.code || "").toLowerCase();
  let errorClass = "unknown";
  if (status === 401 || status === 403 || code.includes("auth") || message.match(/api key|unauthori[sz]ed|forbidden/i)) {
    errorClass = "auth";
  } else if (status === 429 || code.includes("rate") || message.match(/rate limit|too many requests/i)) {
    errorClass = "rate_limit";
  } else if (status === 408 || code.includes("timeout") || message.match(/timeout|timed out|aborted/i)) {
    errorClass = "timeout";
  } else if (status === 400 || status === 422 || message.match(/invalid request|bad request|schema/i)) {
    errorClass = "bad_request";
  } else if (status >= 500 || message.match(/overloaded|unavailable|econnreset|socket hang up/i)) {
    errorClass = "provider_unavailable";
  }
  const retryable = DEFAULT_RETRY_ON.includes(errorClass);
  const classified = gatewayError(errorClass, message || errorClass);
  classified.original = error;
  classified.status = status || null;
  classified.retryable = retryable;
  classified.error_class = errorClass;
  return classified;
}

function shouldRetry(error, retryPolicy) {
  const retryOn = retryPolicy?.retry_on || DEFAULT_RETRY_ON;
  return error?.retryable === true && retryOn.includes(error.error_class);
}

function normalizeUsage(usage = {}) {
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0;
  return {
    input_tokens: Number(input) || 0,
    output_tokens: Number(output) || 0,
  };
}

function traceAttempt({ deployment, status, attempt = 0, latencyMs = 0, usage = null, cost = null, error = null }) {
  return {
    deployment: deployment.id,
    role: deployment.role,
    provider: deployment.provider,
    model_id: deployment.model_id,
    attempt,
    status,
    latency_ms: latencyMs,
    usage,
    cost_usd: cost,
    error_class: error?.error_class || error?.code || null,
    error_message: error?.message || null,
  };
}

function emit(telemetry, event, payload) {
  if (typeof telemetry === "function") telemetry(event, payload);
  else if (telemetry && typeof telemetry.emit === "function") telemetry.emit(event, payload);
}

function gatewayError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

module.exports = {
  PROVIDER_MANIFESTS,
  DEFAULT_RETRY_ON,
  normalizeProvider,
  normalizeSelectedModel,
  estimateMessageTokens,
  estimateCostUsd,
  createDeployment,
  createGatewayPlan,
  dispatchGatewayCall,
  createLiteLLMGateway,
  classifyProviderError,
};
