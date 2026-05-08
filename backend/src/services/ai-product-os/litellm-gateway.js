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

const MAX_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 30_000;

const PROVIDER_ALIASES = Object.freeze({
  gemini: "google",
  google: "google",
  "google-gemini": "google",
  "x-ai": "xai",
  grok: "xai",
  deepseek: "deepseek",
  openrouter: "openrouter",
  openai: "openai",
  anthropic: "anthropic",
  custom: "custom",
});

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

let listManifestModels = () => [];
try {
  ({ listManifestModels } = require("../model-catalog-manifest"));
} catch {
  // The gateway is intentionally usable in isolated tests without the catalog module.
}

function normalizeProvider(provider, modelId = "") {
  const raw = String(provider || "").trim().toLowerCase();
  if (raw && PROVIDER_ALIASES[raw]) return PROVIDER_ALIASES[raw];
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
      attempt_timeout_ms: clampInt(
        policy.attempt_timeout_ms ?? policy.attemptTimeoutMs ?? 0,
        0,
        MAX_ATTEMPT_TIMEOUT_MS,
      ),
      base_delay_ms: clampInt(
        policy.retry_delay_ms ?? policy.retryDelayMs ?? 0,
        0,
        MAX_RETRY_DELAY_MS,
      ),
      max_delay_ms: clampInt(
        policy.max_retry_delay_ms ?? policy.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS,
        0,
        MAX_RETRY_DELAY_MS,
      ),
      respect_retry_after: policy.respect_retry_after !== false && policy.respectRetryAfter !== false,
    },
    release_gate: {
      forbid_unregistered_provider: true,
      forbid_silent_model_switch: !allowFallbacks,
      require_openai_shaped_response: true,
    },
  };
}

function getCatalogModel(provider, modelId) {
  const normalizedProvider = normalizeProvider(provider, modelId);
  const providerName = {
    openai: "OpenAI",
    google: "Gemini",
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
  }[normalizedProvider];
  if (!providerName || !modelId) return null;
  return listManifestModels({ provider: providerName }).find((model) => model.name === modelId) || null;
}

function getProviderRuntimeProfile({ provider, modelId, baseUrl } = {}) {
  const normalizedProvider = normalizeProvider(provider, modelId);
  const manifest = PROVIDER_MANIFESTS[normalizedProvider] || PROVIDER_MANIFESTS.custom;
  const catalogModel = getCatalogModel(normalizedProvider, modelId);
  const compat = catalogModel?.compat || {};
  const isDeepSeek = normalizedProvider === "deepseek";
  const isGoogle = normalizedProvider === "google";
  const isOpenRouter = normalizedProvider === "openrouter";
  const usesConfiguredEndpoint = Boolean(baseUrl && baseUrl !== manifest.base_url);

  return {
    schema_version: "sira.provider_runtime_profile.v1",
    provider: normalizedProvider,
    model_id: modelId,
    display_name: manifest.display_name,
    base_url: baseUrl || manifest.base_url,
    request_format: manifest.request_format,
    supports: { ...manifest.supports },
    supportsStore: !isDeepSeek && !isGoogle && !isOpenRouter && !usesConfiguredEndpoint,
    supportsDeveloperRole: !isDeepSeek && !isGoogle && !usesConfiguredEndpoint,
    supportsReasoningEffort: compat.supportsReasoningEffort === true || (!isGoogle && !isOpenRouter),
    supportsUsageInStreaming: compat.supportsUsageInStreaming === true || normalizedProvider === "openai" || isOpenRouter,
    maxTokensField: compat.maxTokensField || (normalizedProvider === "openai" ? "max_completion_tokens" : "max_tokens"),
    maxOutputTokens: catalogModel?.maxTokens || null,
    contextWindow: catalogModel?.contextLength || null,
    thinkingFormat: isDeepSeek ? "deepseek" : isOpenRouter ? "openrouter" : "openai",
    supportsStrictMode: !isGoogle && !isDeepSeek && !usesConfiguredEndpoint,
    catalog: catalogModel
      ? {
          source: catalogModel.syncSource,
          reasoning: catalogModel.reasoning === true,
          input: catalogModel.input || ["text"],
        }
      : null,
  };
}

function buildProviderChatPayload({
  provider,
  model,
  modelId,
  messages = [],
  stream = false,
  responseFormat = "text",
  tools = [],
  toolChoice,
  maxOutputTokens,
  thinkingLevel,
  baseUrl,
  extra = {},
} = {}) {
  const resolvedModel = String(model || modelId || "").trim();
  if (!resolvedModel) throw gatewayError("missing_model_id", "model is required to build provider payload");
  const runtime = getProviderRuntimeProfile({ provider, modelId: resolvedModel, baseUrl });
  const sanitizedMessages = sanitizeMessagesForProvider(messages, runtime, thinkingLevel);
  const payload = {
    model: resolvedModel,
    messages: sanitizedMessages,
    stream: Boolean(stream),
    ...extra,
  };

  if (Array.isArray(tools) && tools.length > 0 && runtime.supports.tools) {
    payload.tools = tools;
    if (toolChoice) payload.tool_choice = toolChoice;
  }

  applyResponseFormat(payload, responseFormat, runtime, extra);
  applyMaxTokens(payload, maxOutputTokens, runtime);
  applyStreamingUsage(payload, runtime);
  applyThinkingControls(payload, runtime, thinkingLevel);

  return {
    schema_version: "sira.provider_chat_payload.v1",
    provider: runtime.provider,
    model: resolvedModel,
    payload,
    runtime,
  };
}

function applyResponseFormat(payload, responseFormat, runtime, extra) {
  if (!runtime.supports.structured_outputs || runtime.provider === "google") {
    delete payload.response_format;
    return;
  }
  if (!responseFormat || responseFormat === "text") return;

  if (responseFormat === "json_schema" && extra?.json_schema && runtime.supportsStrictMode) {
    payload.response_format = {
      type: "json_schema",
      json_schema: extra.json_schema,
    };
    return;
  }

  if (responseFormat === "json" || responseFormat === "json_schema") {
    payload.response_format = { type: "json_object" };
  }
}

function applyMaxTokens(payload, maxOutputTokens, runtime) {
  const requested = Number(maxOutputTokens || 0);
  if (!Number.isFinite(requested) || requested <= 0) return;
  const capped = runtime.maxOutputTokens ? Math.min(requested, runtime.maxOutputTokens) : requested;
  payload[runtime.maxTokensField] = Math.trunc(capped);
}

function applyStreamingUsage(payload, runtime) {
  if (!payload.stream || !runtime.supportsUsageInStreaming) return;
  payload.stream_options = {
    ...(payload.stream_options || {}),
    include_usage: true,
  };
}

function applyThinkingControls(payload, runtime, thinkingLevel) {
  if (runtime.thinkingFormat !== "deepseek" || !isDeepSeekV4ModelId(runtime.model_id)) return;
  if (isDisabledThinkingLevel(thinkingLevel)) {
    payload.thinking = { type: "disabled" };
    delete payload.reasoning_effort;
    delete payload.reasoning;
    return;
  }
  payload.thinking = { type: "enabled" };
  payload.reasoning_effort = resolveDeepSeekReasoningEffort(thinkingLevel);
}

function sanitizeMessagesForProvider(messages = [], runtime, thinkingLevel) {
  const cloned = cloneJson(Array.isArray(messages) ? messages : []);
  if (runtime.thinkingFormat !== "deepseek" || !isDeepSeekV4ModelId(runtime.model_id)) {
    stripReasoningContent(cloned);
    return cloned;
  }
  if (isDisabledThinkingLevel(thinkingLevel)) {
    stripReasoningContent(cloned);
    return cloned;
  }
  ensureDeepSeekToolCallReasoningContent(cloned);
  return cloned;
}

function isDeepSeekV4ModelId(modelId) {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

function isDisabledThinkingLevel(thinkingLevel) {
  const normalized = String(thinkingLevel || "").trim().toLowerCase();
  return normalized === "off" || normalized === "none" || normalized === "disabled";
}

function resolveDeepSeekReasoningEffort(thinkingLevel) {
  const normalized = String(thinkingLevel || "").trim().toLowerCase();
  return normalized === "xhigh" || normalized === "max" ? "max" : "high";
}

function stripReasoningContent(messages) {
  for (const message of messages || []) {
    if (message && typeof message === "object") {
      delete message.reasoning_content;
    }
  }
}

function ensureDeepSeekToolCallReasoningContent(messages) {
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && !("reasoning_content" in message)) {
      message.reasoning_content = "";
    }
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || []));
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
  sleep = delay,
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
        const attemptGuard = createAttemptGuard(plan.retry_policy.attempt_timeout_ms, deployment, attempt);
        let output;
        try {
          output = await raceWithAttemptSignal(
            adapter({
              ...payload,
              selectedModel: deployment.selected_model,
              gateway: {
                plan,
                deployment,
                attempt,
                signal: attemptGuard.signal,
                deadline_ms: attemptGuard.deadlineMs,
              },
            }),
            attemptGuard.signal,
          );
        } finally {
          attemptGuard.cleanup();
        }
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
        emit(telemetry, "model_gateway.attempt_failed", {
          deployment: deployment.id,
          attempt,
          error_class: classified.error_class,
          retry_after_ms: classified.retry_after_ms ?? null,
        });
        lastError = classified;
        if (!shouldRetry(classified, plan.retry_policy) || attempt >= maxAttempts) break;
        const retryDelayMs = resolveRetryDelayMs(classified, plan.retry_policy, attempt);
        if (retryDelayMs > 0) {
          emit(telemetry, "model_gateway.retry_scheduled", {
            deployment: deployment.id,
            attempt,
            retry_delay_ms: retryDelayMs,
            error_class: classified.error_class,
          });
          await sleep(retryDelayMs);
        }
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
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const code = String(error?.code || error?.cause?.code || "").toLowerCase();
  const retryAfterMs = readRetryAfterMs(error);
  let errorClass = "unknown";
  if (status === 401 || status === 403 || code.includes("auth") || message.match(/api key|unauthori[sz]ed|forbidden/i)) {
    errorClass = "auth";
  } else if (status === 429 || code.includes("rate") || message.match(/rate limit|too many requests/i)) {
    errorClass = "rate_limit";
  } else if (status === 408 || code.includes("timeout") || code === "etimedout" || message.match(/timeout|timed out|aborted/i)) {
    errorClass = "timeout";
  } else if (status === 400 || status === 422 || message.match(/invalid request|bad request|schema/i)) {
    errorClass = "bad_request";
  } else if (
    status === 409 ||
    status >= 500 ||
    ["econnreset", "econnrefused", "eai_again", "epipe", "enotfound", "und_err_socket"].includes(code) ||
    message.match(/overloaded|unavailable|econnreset|socket hang up|fetch failed|network error/i)
  ) {
    errorClass = "provider_unavailable";
  }
  const retryable = DEFAULT_RETRY_ON.includes(errorClass);
  const classified = gatewayError(errorClass, message || errorClass);
  classified.original = error;
  classified.status = status || null;
  classified.retryable = retryable;
  classified.error_class = errorClass;
  classified.retry_after_ms = retryAfterMs;
  return classified;
}

function createAttemptGuard(timeoutMs, deployment, attempt) {
  const ms = Number(timeoutMs) || 0;
  if (ms <= 0) {
    return {
      signal: undefined,
      deadlineMs: null,
      cleanup() {},
    };
  }

  const controller = new AbortController();
  const deadlineMs = Date.now() + ms;
  const timer = setTimeout(() => {
    const err = gatewayError(
      "attempt_timeout",
      `provider ${deployment.id} attempt ${attempt} timed out after ${ms}ms`,
    );
    err.status = 408;
    try { controller.abort(err); } catch {}
  }, ms);

  return {
    signal: controller.signal,
    deadlineMs,
    cleanup() { clearTimeout(timer); },
  };
}

function raceWithAttemptSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason || gatewayError("attempt_aborted", "provider attempt aborted"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || gatewayError("attempt_aborted", "provider attempt aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function resolveRetryDelayMs(error, retryPolicy = {}, attempt = 1) {
  const maxDelay = clampInt(retryPolicy.max_delay_ms ?? MAX_RETRY_DELAY_MS, 0, MAX_RETRY_DELAY_MS);
  if (maxDelay <= 0) return 0;

  if (
    retryPolicy.respect_retry_after !== false &&
    Number.isFinite(error?.retry_after_ms) &&
    error.retry_after_ms > 0
  ) {
    return Math.min(Math.ceil(error.retry_after_ms), maxDelay);
  }

  const baseDelay = clampInt(retryPolicy.base_delay_ms ?? 0, 0, maxDelay);
  if (baseDelay <= 0) return 0;
  return Math.min(baseDelay * (2 ** Math.max(0, Number(attempt) - 1)), maxDelay);
}

function readRetryAfterMs(error) {
  const directMs = normalizeRetryAfterMs(error?.retryAfterMs ?? error?.retry_after_ms, true);
  if (directMs != null) return directMs;

  const directSeconds = normalizeRetryAfterMs(error?.retryAfter ?? error?.retry_after, false);
  if (directSeconds != null) return directSeconds;

  const headerSources = [error?.headers, error?.response?.headers, error?.cause?.headers];
  for (const headers of headerSources) {
    const retryAfter = getHeader(headers, "retry-after");
    const parsed = normalizeRetryAfterMs(retryAfter, false);
    if (parsed != null) return parsed;
  }
  return null;
}

function getHeader(headers, name) {
  if (!headers) return null;
  const lower = String(name).toLowerCase();
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(lower);
  if (typeof headers.forEach === "function") {
    let found = null;
    headers.forEach((value, key) => {
      if (String(key).toLowerCase() === lower) found = value;
    });
    return found;
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === lower) return headers[key];
    }
  }
  return null;
}

function normalizeRetryAfterMs(value, alreadyMs = false) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const ms = alreadyMs ? numeric : numeric * 1000;
    return Math.max(0, Math.ceil(ms));
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    retry_after_ms: error?.retry_after_ms ?? null,
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
  getProviderRuntimeProfile,
  buildProviderChatPayload,
  sanitizeMessagesForProvider,
  createGatewayPlan,
  dispatchGatewayCall,
  createLiteLLMGateway,
  classifyProviderError,
  resolveRetryDelayMs,
  readRetryAfterMs,
};
