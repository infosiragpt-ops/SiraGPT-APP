"use strict";

/**
 * token-budget-policy - preflight budget checks for Sira chat turns.
 *
 * This module is intentionally deterministic and dependency-free. It does not
 * mutate the ledger; it only projects whether a turn should be allowed before
 * the runtime spends tokens/tools. Production can swap caps via env or injected
 * options without coupling the UI to budget logic.
 */

const { estimateTokens } = require("./token-ledger");

const SCHEMA_VERSION = "sira.token_budget.v1";

const DEFAULT_PLAN_CAPS = Object.freeze({
  FREE: Object.freeze({
    max_input_tokens: 24_000,
    max_tokens_per_turn: 96_000,
    max_tokens_per_conversation: 500_000,
    max_tokens_per_day: 750_000,
  }),
  PRO: Object.freeze({
    max_input_tokens: 64_000,
    max_tokens_per_turn: 180_000,
    max_tokens_per_conversation: 2_000_000,
    max_tokens_per_day: 5_000_000,
  }),
  TEAM: Object.freeze({
    max_input_tokens: 96_000,
    max_tokens_per_turn: 260_000,
    max_tokens_per_conversation: 5_000_000,
    max_tokens_per_day: 15_000_000,
  }),
  ENTERPRISE: Object.freeze({
    max_input_tokens: 180_000,
    max_tokens_per_turn: 500_000,
    max_tokens_per_conversation: 25_000_000,
    max_tokens_per_day: 75_000_000,
  }),
});

function assessTokenBudget({
  userId = null,
  conversationId = null,
  userPlan = "FREE",
  userMessage = "",
  attachments = [],
  history = [],
  selectedModel = null,
  tokenLedger = null,
  caps = null,
  mode = "enforce",
  reserveOutputTokens = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const resolvedCaps = resolveTokenBudgetCaps({ userPlan, overrides: caps });
  const inputTokens = estimateRequestInputTokens({ userMessage, attachments, history });
  const outputReserve = Number.isFinite(Number(reserveOutputTokens))
    ? Math.max(0, Number(reserveOutputTokens))
    : defaultOutputReserve(inputTokens, selectedModel);
  const projectedTurnTokens = inputTokens + outputReserve;
  const usage = readLedgerUsage({ tokenLedger, userId, conversationId });
  const violations = [];

  if (inputTokens > resolvedCaps.max_input_tokens) {
    violations.push(makeViolation("input_tokens_exceeded", inputTokens, resolvedCaps.max_input_tokens));
  }
  if (projectedTurnTokens > resolvedCaps.max_tokens_per_turn) {
    violations.push(makeViolation("turn_tokens_exceeded", projectedTurnTokens, resolvedCaps.max_tokens_per_turn));
  }
  if (usage.conversation_total_tokens + projectedTurnTokens > resolvedCaps.max_tokens_per_conversation) {
    violations.push(makeViolation(
      "conversation_tokens_exceeded",
      usage.conversation_total_tokens + projectedTurnTokens,
      resolvedCaps.max_tokens_per_conversation,
    ));
  }
  if (usage.user_total_tokens + projectedTurnTokens > resolvedCaps.max_tokens_per_day) {
    violations.push(makeViolation(
      "daily_tokens_exceeded",
      usage.user_total_tokens + projectedTurnTokens,
      resolvedCaps.max_tokens_per_day,
    ));
  }

  const enforcementMode = normalizeMode(mode);
  const blocked = enforcementMode === "enforce" && violations.some(v => v.severity === "hard");

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    frame_type: "token_budget_frame",
    generated_at: generatedAt,
    decision: blocked ? "blocked" : "allowed",
    enforcement_mode: enforcementMode,
    user_id: userId,
    conversation_id: conversationId,
    user_plan: normalizePlan(userPlan),
    model: Object.freeze({
      provider: selectedModel?.provider || "unknown",
      model_id: selectedModel?.modelId || selectedModel?.model_id || "unknown",
      modality: selectedModel?.modality || "text",
    }),
    caps: Object.freeze({ ...resolvedCaps }),
    projected_usage: Object.freeze({
      input_tokens: inputTokens,
      reserved_output_tokens: outputReserve,
      projected_turn_tokens: projectedTurnTokens,
      conversation_tokens_after_turn: usage.conversation_total_tokens + projectedTurnTokens,
      user_tokens_after_turn: usage.user_total_tokens + projectedTurnTokens,
    }),
    current_usage: Object.freeze(usage),
    violations: Object.freeze(violations),
    privacy: Object.freeze({
      raw_user_text_logged: false,
      raw_attachment_content_logged: false,
      raw_history_logged: false,
    }),
  });
}

function resolveTokenBudgetCaps({ userPlan = "FREE", overrides = null } = {}) {
  const plan = normalizePlan(userPlan);
  const base = DEFAULT_PLAN_CAPS[plan] || DEFAULT_PLAN_CAPS.FREE;
  const envCaps = readEnvCaps(plan);
  return Object.freeze({
    ...base,
    ...envCaps,
    ...(overrides || {}),
  });
}

function estimateRequestInputTokens({ userMessage = "", attachments = [], history = [] } = {}) {
  const attachmentProfile = (attachments || []).map(a => ({
    file_id: a?.file_id || a?.id || null,
    filename: a?.filename || a?.name || null,
    mime_type: a?.mime_type || a?.mimeType || a?.type || null,
    detected_type: a?.detected_type || a?.kind || null,
    size_bytes: Number(a?.size_bytes || a?.size || 0) || 0,
  }));
  const historyProfile = (history || []).slice(-12).map(m => ({
    role: m?.role || "unknown",
    tokens: estimateTokens(m?.content || m?.text || ""),
    attachment_count: Array.isArray(m?.attachments) ? m.attachments.length : 0,
  }));
  return estimateTokens(userMessage) + estimateTokens(attachmentProfile) + estimateTokens(historyProfile);
}

function readLedgerUsage({ tokenLedger, userId, conversationId }) {
  if (!tokenLedger || typeof tokenLedger.summarize !== "function") {
    return { user_total_tokens: 0, conversation_total_tokens: 0, ledger_available: false, ledger_error: null };
  }
  try {
    const userSummary = userId ? tokenLedger.summarize({ userId }) : null;
    const conversationSummary = conversationId ? tokenLedger.summarize({ conversationId }) : null;
    return {
      user_total_tokens: Number(userSummary?.totals?.total_tokens || 0),
      conversation_total_tokens: Number(conversationSummary?.totals?.total_tokens || 0),
      ledger_available: true,
      ledger_error: null,
    };
  } catch (error) {
    return {
      user_total_tokens: 0,
      conversation_total_tokens: 0,
      ledger_available: false,
      ledger_error: error && error.message ? error.message : String(error),
    };
  }
}

function defaultOutputReserve(inputTokens, selectedModel) {
  const modality = String(selectedModel?.modality || "text").toLowerCase();
  const multiplier = modality === "image" || modality === "video" ? 0.2 : 0.6;
  return Math.max(512, Math.ceil(inputTokens * multiplier));
}

function readEnvCaps(plan) {
  const prefix = `SIRA_${plan}_`;
  const generic = "SIRA_";
  return {
    ...readCapEnv(generic),
    ...readCapEnv(prefix),
  };
}

function readCapEnv(prefix) {
  return pickFinite({
    max_input_tokens: process.env[`${prefix}MAX_INPUT_TOKENS`],
    max_tokens_per_turn: process.env[`${prefix}MAX_TOKENS_PER_TURN`],
    max_tokens_per_conversation: process.env[`${prefix}MAX_TOKENS_PER_CONVERSATION`],
    max_tokens_per_day: process.env[`${prefix}MAX_TOKENS_PER_DAY`],
  });
}

function pickFinite(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

function makeViolation(code, observed, limit) {
  return Object.freeze({
    code,
    severity: "hard",
    observed,
    limit,
    message: `${code}: observed ${observed} > limit ${limit}`,
  });
}

function normalizePlan(plan) {
  const value = String(plan || "FREE").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(DEFAULT_PLAN_CAPS, value) ? value : "FREE";
}

function normalizeMode(mode) {
  const value = String(mode || "enforce").trim().toLowerCase();
  return value === "observe" ? "observe" : "enforce";
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_PLAN_CAPS,
  assessTokenBudget,
  resolveTokenBudgetCaps,
  estimateRequestInputTokens,
};
