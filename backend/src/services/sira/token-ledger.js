"use strict";

/**
 * token-ledger - token accounting for agentic turns.
 *
 * The ledger deliberately stores counts and metadata only. It never stores raw
 * user text, raw attachment bodies or provider prompts. Provider-reported token
 * usage can be merged later, while deterministic estimates keep dry-run and
 * offline tests observable.
 */

const SCHEMA_VERSION = "sira.token_usage.v1";
const ESTIMATOR_VERSION = "chars_div_4.v1";

function estimateTokens(value) {
  const text = stringifyForEstimate(value);
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildTokenUsageFrame({
  envelope = null,
  userMessage = "",
  attachments = [],
  history = [],
  selectedModel = null,
  runtimeResult = null,
  responseText = "",
  providerUsage = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const safeAttachments = attachments.map(redactAttachmentForAccounting);
  const safeHistory = history.slice(-12).map(redactMessageForAccounting);
  const safeToolResults = (runtimeResult?.tool_results || []).map(redactToolResultForAccounting);
  const safeArtifacts = (runtimeResult?.artifact_frame?.artifacts || []).map(redactArtifactForAccounting);
  const safeValidation = (runtimeResult?.validation_frame?.checks || []).map(check => ({
    name: check?.name || null,
    status: check?.status || null,
    score: typeof check?.score === "number" ? check.score : null,
  }));

  const provider = normalizeProviderUsage(providerUsage || runtimeResult?.provider_usage || runtimeResult?.usage);
  const estimatedInput = estimateTokens(userMessage) + estimateTokens(safeAttachments) + estimateTokens(safeHistory);
  const estimatedTool = estimateTokens(safeToolResults) + estimateTokens(runtimeResult?.evidence_ledger || []);
  const estimatedOutput = estimateTokens(responseText) + estimateTokens(safeArtifacts) + estimateTokens(safeValidation);

  const inputTokens = provider.input_tokens || estimatedInput;
  const outputTokens = provider.output_tokens || estimatedOutput;
  const toolTokens = estimatedTool;
  const totalTokens = provider.total_tokens
    ? provider.total_tokens + toolTokens
    : inputTokens + outputTokens + toolTokens;

  const model = normalizeSelectedModel(selectedModel || envelope?.model_execution_context?.selected_model);
  const primaryIntent = envelope?.intent_analysis?.primary_intent?.id || "unknown";
  const taskFamily = envelope?.intent_analysis?.task_family || "unknown";

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    frame_type: "token_usage_frame",
    request_id: envelope?.request_id || null,
    conversation_id: envelope?.conversation_id || null,
    user_id: envelope?.user_id || null,
    generated_at: generatedAt,
    accounting_method: provider.reported
      ? "provider_reported_plus_estimated_tooling"
      : "deterministic_estimate",
    estimator_version: ESTIMATOR_VERSION,
    estimated: !provider.reported,
    dimensions: Object.freeze({
      user_id: envelope?.user_id || null,
      conversation_id: envelope?.conversation_id || null,
      provider: model.provider,
      model_id: model.model_id,
      task_intent: primaryIntent,
      task_family: taskFamily,
    }),
    usage: Object.freeze({
      input_tokens: inputTokens,
      tool_tokens: toolTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      provider_reported: provider.reported,
      provider_usage: provider.reported ? provider : null,
    }),
    inputs_profile: Object.freeze({
      user_message_tokens_estimated: estimateTokens(userMessage),
      attachment_count: safeAttachments.length,
      attachment_tokens_estimated: estimateTokens(safeAttachments),
      history_messages_counted: safeHistory.length,
      history_tokens_estimated: estimateTokens(safeHistory),
    }),
    runtime_profile: Object.freeze({
      tool_results_counted: safeToolResults.length,
      artifacts_counted: safeArtifacts.length,
      validation_checks_counted: safeValidation.length,
    }),
    privacy: Object.freeze({
      raw_user_text_logged: false,
      raw_attachment_content_logged: false,
      raw_history_logged: false,
    }),
  });
}

function createInMemoryTokenLedger({ capacity = 10000 } = {}) {
  const records = [];

  function record(frame) {
    validateTokenUsageFrame(frame);
    records.push(frame);
    while (records.length > capacity) records.shift();
    return frame;
  }

  function summarize(filter = {}) {
    const matches = records.filter(frame => matchesFilter(frame, filter));
    const totals = matches.reduce((acc, frame) => {
      acc.input_tokens += frame.usage.input_tokens;
      acc.tool_tokens += frame.usage.tool_tokens;
      acc.output_tokens += frame.usage.output_tokens;
      acc.total_tokens += frame.usage.total_tokens;
      return acc;
    }, { input_tokens: 0, tool_tokens: 0, output_tokens: 0, total_tokens: 0 });

    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      frame_type: "token_usage_summary",
      filters: Object.freeze({ ...filter }),
      records: matches.length,
      totals: Object.freeze(totals),
      by_model: groupTotals(matches, frame => `${frame.dimensions.provider}:${frame.dimensions.model_id}`),
      by_task: groupTotals(matches, frame => frame.dimensions.task_intent),
      by_user: groupTotals(matches, frame => frame.dimensions.user_id || "anonymous"),
    });
  }

  return Object.freeze({
    record,
    summarize,
    snapshot: () => records.slice(),
    clear: () => { records.length = 0; },
  });
}

function validateTokenUsageFrame(frame) {
  if (!frame || frame.schema_version !== SCHEMA_VERSION || frame.frame_type !== "token_usage_frame") {
    throw makeError("invalid_token_usage_frame", "token usage frame required");
  }
  if (!frame.usage || !Number.isFinite(frame.usage.total_tokens) || frame.usage.total_tokens < 0) {
    throw makeError("invalid_token_usage_total", "token usage total must be finite and non-negative");
  }
}

function matchesFilter(frame, filter) {
  if (filter.userId && frame.dimensions.user_id !== filter.userId) return false;
  if (filter.user_id && frame.dimensions.user_id !== filter.user_id) return false;
  if (filter.conversationId && frame.dimensions.conversation_id !== filter.conversationId) return false;
  if (filter.conversation_id && frame.dimensions.conversation_id !== filter.conversation_id) return false;
  if (filter.modelId && frame.dimensions.model_id !== filter.modelId) return false;
  if (filter.model_id && frame.dimensions.model_id !== filter.model_id) return false;
  if (filter.provider && frame.dimensions.provider !== filter.provider) return false;
  if (filter.taskIntent && frame.dimensions.task_intent !== filter.taskIntent) return false;
  if (filter.task_intent && frame.dimensions.task_intent !== filter.task_intent) return false;
  return true;
}

function groupTotals(frames, keyFn) {
  const grouped = {};
  for (const frame of frames) {
    const key = keyFn(frame) || "unknown";
    if (!grouped[key]) {
      grouped[key] = { records: 0, input_tokens: 0, tool_tokens: 0, output_tokens: 0, total_tokens: 0 };
    }
    grouped[key].records += 1;
    grouped[key].input_tokens += frame.usage.input_tokens;
    grouped[key].tool_tokens += frame.usage.tool_tokens;
    grouped[key].output_tokens += frame.usage.output_tokens;
    grouped[key].total_tokens += frame.usage.total_tokens;
  }
  return Object.freeze(grouped);
}

function normalizeProviderUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return Object.freeze({ reported: false, input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  }
  const input = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const output = Number(usage.output_tokens || usage.completion_tokens || 0);
  const total = Number(usage.total_tokens || input + output || 0);
  return Object.freeze({
    reported: input > 0 || output > 0 || total > 0,
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  });
}

function normalizeSelectedModel(selectedModel) {
  return Object.freeze({
    provider: selectedModel?.provider || "unknown",
    model_id: selectedModel?.model_id || selectedModel?.modelId || "unknown",
    modality: selectedModel?.modality || "text",
  });
}

function redactAttachmentForAccounting(attachment) {
  return {
    file_id: attachment?.file_id || attachment?.id || null,
    filename: attachment?.filename || attachment?.name || null,
    mime_type: attachment?.mime_type || attachment?.mimeType || attachment?.type || null,
    detected_type: attachment?.detected_type || attachment?.kind || null,
    size_bytes: Number(attachment?.size_bytes || attachment?.size || 0) || 0,
  };
}

function redactMessageForAccounting(message) {
  return {
    role: message?.role || "unknown",
    content_tokens_estimated: estimateTokens(message?.content || message?.text || ""),
    attachment_count: Array.isArray(message?.attachments) ? message.attachments.length : 0,
  };
}

function redactToolResultForAccounting(result) {
  return {
    node: result?.node || null,
    tool: result?.tool || null,
    status: result?.status || null,
    error_code: result?.error?.code || null,
    output_shape: summarizeShape(result?.output),
    artifact_count: Array.isArray(result?.artifacts) ? result.artifacts.length : 0,
  };
}

function redactArtifactForAccounting(artifact) {
  return {
    artifact_id: artifact?.artifact_id || null,
    type: artifact?.type || null,
    format: artifact?.format || null,
    status: artifact?.status || null,
    size_bytes: Number(artifact?.size_bytes || artifact?.sizeBytes || 0) || 0,
  };
}

function summarizeShape(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 20) };
  return { type: typeof value };
}

function stringifyForEstimate(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, current) => {
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    });
  } catch (_error) {
    return String(value);
  }
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  SCHEMA_VERSION,
  ESTIMATOR_VERSION,
  estimateTokens,
  buildTokenUsageFrame,
  createInMemoryTokenLedger,
  validateTokenUsageFrame,
};
