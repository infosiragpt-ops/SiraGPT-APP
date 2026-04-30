/**
 * model-adapter — Sira's manual user-selected model dispatcher
 * (MASTER_SPEC §14).
 *
 * The hard rule: NEVER auto-route the model. The user picks the
 * provider + model_id manually; this adapter only dispatches the
 * call to the correct vendor adapter.
 *
 * Public API:
 *
 *   callUserSelectedModel({
 *     selectedModel: { provider, modelId, modality },
 *     systemPrompt, messages, responseFormat?, tools?,
 *   }, { providers })  → { text, parsed?, usage, raw }
 *
 *   listSupportedProviders()
 *   guardAgainstAutoRouting(originalSelection, actualSelection)
 *
 * Default `providers` is a deterministic stub map so the platform
 * works zero-deps. Production injects concrete vendor clients.
 */

const liteLLMGateway = require("../ai-product-os/litellm-gateway");
const llmInstrumentation = require("./llm-instrumentation");

const SUPPORTED_PROVIDERS = Object.freeze([
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "openrouter",
  "image_provider",
  "video_provider",
  "audio_provider",
  "custom",
]);

const SUPPORTED_MODALITIES = Object.freeze([
  "text", "image", "video", "audio", "multimodal",
]);

/**
 * @param {object} args
 * @param {{provider:string, modelId:string, modality:string}} args.selectedModel
 * @param {string} args.systemPrompt
 * @param {Array<{role:string, content:any}>} args.messages
 * @param {"json"|"text"|"json_schema"} [args.responseFormat]
 * @param {Array<object>} [args.tools]
 * @param {object} [opts.providers]  — { openai({...}), anthropic({...}), ... }
 * @param {object} [opts.gatewayPolicy] LiteLLM-style retry/fallback/budget policy
 * @param {object} [opts.gateway] Optional injected gateway with dispatch({plan,payload})
 * @returns {Promise<{ text, parsed?, usage, raw, provider, modelId }>}
 */
async function callUserSelectedModel(
  { selectedModel, systemPrompt, messages, responseFormat = "text", tools = [] } = {},
  {
    providers = createDefaultProviders(),
    gatewayPolicy = {},
    gateway = null,
    telemetry = null,
    // When true (default), pre-check the per-provider circuit and
    // record the call into the cost ledger + Prometheus. Tests can
    // disable to keep their assertions clean from instrumentation
    // side-effects.
    instrument = true,
    // Caller plan + user id — surfaced into the cost ledger so
    // dashboards can slice spend by tier or user without leaving
    // the existing audit/log surface. Optional.
    userPlan = null,
    userId = null,
  } = {},
) {
  validateSelection(selectedModel);
  validateMessages(messages);

  // Circuit-breaker pre-check: refuse to dispatch when a provider
  // has tripped. The recorder maintains the state machine; here we
  // just consult it. `half_open` returns true (one trial allowed),
  // so this only blocks fully open circuits.
  if (instrument && !llmInstrumentation.isProviderAvailable(selectedModel.provider)) {
    // mkErr already returns a `ToolError({code:"provider_circuit_open",
    // retryable:true})` — see _MODEL_ADAPTER_TOOL_CODES below.
    throw mkErr(
      "provider_circuit_open",
      `provider "${selectedModel.provider}" circuit is open; refusing dispatch`,
    );
  }

  const plan = liteLLMGateway.createGatewayPlan({
    selectedModel,
    messages,
    responseFormat,
    tools,
    policy: gatewayPolicy,
  });

  const payload = {
    selectedModel,
    systemPrompt,
    messages,
    responseFormat,
    tools,
  };

  const startedAt = Date.now();
  let result;
  try {
    result = gateway && typeof gateway.dispatch === "function"
      ? await gateway.dispatch({ plan, payload })
      : await liteLLMGateway.dispatchGatewayCall({ plan, payload, providers, telemetry });
  } catch (err) {
    // Best-effort failure recording before re-throwing. Counts the
    // failure on the breaker so consecutive provider outages trip
    // the circuit; emits the call counter labelled "error".
    if (instrument) {
      try {
        llmInstrumentation.recordLlmCall({
          selectedModel,
          durationMs: Date.now() - startedAt,
          status: "error",
          errorCode: err && err.code ? String(err.code) : "dispatch_failed",
          userPlan, userId,
        });
      } catch (_e) { /* never let instrumentation hide the real error */ }
    }
    throw err;
  }

  const actualSelection = result.selectedModel || selectedModel;
  if (!gatewayPolicy.allow_fallbacks && !gatewayPolicy.allowFallbacks) {
    guardAgainstAutoRouting(selectedModel, actualSelection);
  }

  const shaped = shape(result.output, actualSelection, {
    gateway_trace: result.trace,
    gateway_cost_usd: result.cost,
    fallback_used: result.fallback_used,
  });

  if (instrument) {
    try {
      llmInstrumentation.recordLlmCall({
        // Always attribute to the *original* selection so a fallback
        // doesn't silently re-credit a different provider's metrics.
        // The fallback path is captured separately via the
        // `fallback_used` flag on the shaped response.
        selectedModel,
        durationMs: Date.now() - startedAt,
        usage: shaped.usage,
        costUsd: shaped.gateway_cost_usd,
        status: "success",
        userPlan, userId,
      });
    } catch (_e) { /* metrics must never poison user responses */ }
  }

  return shaped;
}

function validateSelection(s) {
  if (!s || typeof s !== "object") throw mkErr("missing_selected_model", "selectedModel is required");
  if (!SUPPORTED_PROVIDERS.includes(s.provider)) {
    throw mkErr("provider_unsupported", `provider "${s.provider}" not in ${SUPPORTED_PROVIDERS.join(", ")}`);
  }
  if (typeof s.modelId !== "string" || s.modelId.trim().length === 0) {
    throw mkErr("missing_model_id", "selectedModel.modelId required");
  }
  if (s.modality && !SUPPORTED_MODALITIES.includes(s.modality)) {
    throw mkErr("modality_unsupported", `modality "${s.modality}" not supported`);
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw mkErr("missing_messages", "messages (non-empty array) required");
  }
  for (const m of messages) {
    if (!m || typeof m !== "object") throw mkErr("bad_message", "every message must be an object");
    if (!["system", "user", "assistant", "tool"].includes(m.role)) {
      throw mkErr("bad_message_role", `unknown role "${m.role}"`);
    }
  }
}

function shape(out, selectedModel, gatewayMeta = {}) {
  if (!out || typeof out !== "object") throw mkErr("provider_returned_non_object", "provider must return an object");
  return {
    provider: selectedModel.provider,
    modelId: selectedModel.modelId,
    text: typeof out.text === "string" ? out.text : "",
    parsed: out.parsed ?? null,
    usage: out.usage || { input_tokens: 0, output_tokens: 0 },
    raw: out.raw ?? null,
    gateway_trace: gatewayMeta.gateway_trace || out.gateway_trace || null,
    gateway_cost_usd: gatewayMeta.gateway_cost_usd ?? out.gateway_cost_usd ?? null,
    fallback_used: Boolean(gatewayMeta.fallback_used || out.fallback_used),
  };
}

/**
 * Hard guard against auto-routing. Call this after every model
 * dispatch to make sure NOTHING upstream silently swapped the
 * provider or model_id.
 */
function guardAgainstAutoRouting(originalSelection, actualSelection) {
  if (!originalSelection || !actualSelection) {
    throw mkErr("missing_selection_for_guard", "both selections required");
  }
  if (originalSelection.provider !== actualSelection.provider) {
    throw mkErr("auto_route_violation", `provider switched ${originalSelection.provider} → ${actualSelection.provider} without user consent`);
  }
  if (originalSelection.modelId !== actualSelection.modelId) {
    throw mkErr("auto_route_violation", `modelId switched ${originalSelection.modelId} → ${actualSelection.modelId} without user consent`);
  }
  return { ok: true };
}

function listSupportedProviders() {
  return [...SUPPORTED_PROVIDERS];
}

function listSupportedModalities() {
  return [...SUPPORTED_MODALITIES];
}

/**
 * Default in-memory provider stubs. Each one returns a deterministic
 * synthetic response so the platform works zero-deps. Production
 * passes its own provider map via the second argument of
 * callUserSelectedModel.
 */
function createDefaultProviders() {
  const stub = (label) => async ({ selectedModel, systemPrompt, messages, responseFormat }) => {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || "");
    const text = `[${label}:${selectedModel.modelId}] ${userText.slice(0, 240)}`;
    let parsed = null;
    if (responseFormat === "json" || responseFormat === "json_schema") {
      parsed = {
        provider: selectedModel.provider, modelId: selectedModel.modelId,
        echo: userText.slice(0, 200), system_prompt_len: (systemPrompt || "").length,
      };
    }
    return {
      text,
      parsed,
      usage: { input_tokens: userText.length, output_tokens: text.length },
      raw: null,
    };
  };
  return {
    openai: stub("openai"),
    anthropic: stub("anthropic"),
    google: stub("google"),
    deepseek: stub("deepseek"),
    xai: stub("xai"),
    openrouter: stub("openrouter"),
    image_provider: stub("image"),
    video_provider: stub("video"),
    audio_provider: stub("audio"),
    custom: stub("custom"),
  };
}

// Code → error class mapping. Codes are kept verbatim — the test
// suite + audit consumers index on `err.code` as the primary
// discriminator, so the migration to SiraPipelineError must NOT
// rename or namespace the code value. Only the class changes,
// which gives `toHttpResponse` / `toAuditPayload` / the Express
// `siraErrorHandler` a structured payload to work with.
const _MODEL_ADAPTER_TOOL_CODES = new Set([
  "provider_circuit_open",
]);
function mkErr(code, message) {
  const { IngressError, ToolError } = require("./pipeline-errors");
  if (_MODEL_ADAPTER_TOOL_CODES.has(code)) {
    return new ToolError({ code, message, retryable: true });
  }
  // Every other thrown code in this module is a request-shape
  // complaint (missing field, bad message, modality unsupported,
  // auto-routing violation) → 400 / IngressError.
  return new IngressError({ code, message });
}

module.exports = {
  callUserSelectedModel,
  guardAgainstAutoRouting,
  listSupportedProviders,
  listSupportedModalities,
  createDefaultProviders,
  createGatewayPlan: liteLLMGateway.createGatewayPlan,
  createLiteLLMGateway: liteLLMGateway.createLiteLLMGateway,
  SUPPORTED_PROVIDERS,
  SUPPORTED_MODALITIES,
};
