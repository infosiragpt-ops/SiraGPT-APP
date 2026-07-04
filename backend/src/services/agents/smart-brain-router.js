'use strict';

/**
 * smart-brain-router — escalate the AGENTIC ORCHESTRATION to the strongest
 * configured model when the user's selected model is a weak tool-caller.
 *
 * The user picks a model for chat quality/price; but the agentic loop
 * (plan → tools → observe → repair → finalize) lives or dies by the
 * orchestrator's tool-calling fidelity. A weak model in 'prompted' mode
 * drifts, mis-formats tool calls and under-delivers ("el cerebro"). This
 * router swaps ONLY the loop's driver to a strong native-tools model via
 * OpenRouter; everything else (billing feature, quotas, persona, UI) is
 * untouched, and the usage frame reports the model actually used.
 *
 * Guardrails:
 *   - Kill switch: SIRAGPT_SMART_BRAIN=0
 *   - Plan gate (cost control): SIRAGPT_SMART_BRAIN_PLANS, default
 *     "PRO,PRO_MAX,ENTERPRISE" (+ superadmins always). "ALL" opens it up.
 *   - Only escalates weak drivers: toolCallMode 'prompted', or a model in
 *     the weak-list (default: the FlashGPT/free-tier families).
 *   - Never escalates an already-strong model, and never without
 *     OPENROUTER_API_KEY (native tool transport for anthropic/* slugs).
 *   - Target override: SIRAGPT_SMART_BRAIN_MODEL (OpenRouter slug).
 */

const DEFAULT_TARGET_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_PLANS = 'PRO,PRO_MAX,ENTERPRISE';

// Weak orchestrators: free-tier / small models that shouldn't drive the loop.
const DEFAULT_WEAK_MODELS = /^(gpt-oss|llama-3\.1-8b|llama3\.1-8b|zai-glm|glm-4|qwen-?2\.5-7b|mistral-7b|gemma)/i;

// Already-strong drivers: escalating these wastes money for no gain.
const STRONG_MODELS = /(claude|gpt-5|gpt-4\.1|gpt-4o|o[134](-|$)|gemini-2\.5-pro|gemini-2\.0-pro|deepseek-r1|grok-[34])/i;

function parsePlanGate(env) {
  const raw = String(env.SIRAGPT_SMART_BRAIN_PLANS || DEFAULT_PLANS).trim();
  if (raw.toUpperCase() === 'ALL') return null; // no gate
  return new Set(raw.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean));
}

/**
 * @returns {null | { provider: string, model: string, reason: string }}
 */
function resolveBrainEscalation({
  provider,
  model,
  toolCallMode,
  userPlan = 'FREE',
  isSuperAdmin = false,
  env = process.env,
} = {}) {
  if (String(env.SIRAGPT_SMART_BRAIN || '1').trim() === '0') return null;
  if (!env.OPENROUTER_API_KEY || !String(env.OPENROUTER_API_KEY).trim()) return null;

  const target = String(env.SIRAGPT_SMART_BRAIN_MODEL || DEFAULT_TARGET_MODEL).trim();
  const m = String(model || '');
  if (!m) return null;
  // Already the target, or already strong → leave it alone.
  if (m === target || STRONG_MODELS.test(m)) return null;

  // Plan gate (superadmins bypass — the owner debugging IS the use case).
  if (!isSuperAdmin) {
    const allowed = parsePlanGate(env);
    if (allowed && !allowed.has(String(userPlan || 'FREE').toUpperCase())) return null;
  }

  const weakRe = env.SIRAGPT_SMART_BRAIN_WEAK_MODELS
    ? new RegExp(env.SIRAGPT_SMART_BRAIN_WEAK_MODELS, 'i')
    : DEFAULT_WEAK_MODELS;

  let reason = null;
  if (toolCallMode === 'prompted') reason = 'prompted_tool_mode';
  else if (weakRe.test(m)) reason = 'weak_model';
  if (!reason) return null;

  return { provider: 'OpenRouter', model: target, reason };
}

module.exports = {
  resolveBrainEscalation,
  DEFAULT_TARGET_MODEL,
  DEFAULT_WEAK_MODELS,
  STRONG_MODELS,
};
