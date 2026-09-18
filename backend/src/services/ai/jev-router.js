'use strict';

/**
 * Jev tier router — TypeSafe Jev (System One decision model, via OpenRouter)
 * as an INTERNAL escalation judge for the Sira model tiers.
 *
 * Jev is NOT a chat model: it returns a typed decision, not prose, so it is
 * never exposed in the model picker. Here it answers exactly one question per
 * turn — "does this turn need the pro tier?" — and its verdict refines the
 * reasoning-orchestrator routing decision that ai.js already knows how to
 * apply (picker-wins, plan gate and provider inference all stay in the
 * existing apply block).
 *
 * Modes (env SIRAGPT_JEV_ROUTER):
 *   off (default)  — module inert, zero network calls.
 *   on|1|true      — judge runs only when its verdict could actually apply
 *                    (no explicit picker model, current model is the flash
 *                    tier, no images) and may escalate flash→pro or veto a
 *                    heuristic pro escalation.
 *   shadow         — judge runs on every eligible flash-tier turn and logs
 *                    its verdict, but NEVER mutates routing. Use this to
 *                    collect calibration data before trusting it.
 *
 * Requires OPENROUTER_API_KEY. Fail-open by contract: any error, timeout or
 * unparseable answer leaves the turn exactly as it was.
 */

const DEFAULT_JEV_MODEL_ID = 'typesafe/jev-latest';
const DEFAULT_TIMEOUT_MS = 1200;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_PROMPT_CHARS = 4000;

const TIERS = Object.freeze(['flash', 'pro']);

// Mirrors custom-provider-client isSiraRapidoRow / isSiraProRow, applied to a
// bare model id ('deepseek-v4-flash' or 'deepseek/deepseek-v4-flash').
function isFlashTierModel(modelId) {
  const id = String(modelId || '');
  return /deepseek/i.test(id) && /v4[-_\s]?flash/i.test(id);
}

function isProTierModel(modelId) {
  const id = String(modelId || '');
  return /deepseek/i.test(id) && /v4[-_\s]?pro/i.test(id) && !/flash/i.test(id);
}

/** flash id → pro id preserving the provider shape (direct vs openrouter slug). */
function flashToProModelId(modelId, env = process.env) {
  const override = String((env && env.SIRAGPT_JEV_PRO_TARGET) || '').trim();
  if (override) return override;
  return String(modelId || '').replace(/(v4[-_]?)flash/i, '$1pro');
}

function cleanKey(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw || null;
}

function parseMode(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (v === '1' || v === 'true' || v === 'on' || v === 'active') return 'on';
  return 'off';
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getJevRouterConfig(env = process.env) {
  const apiKey = cleanKey(env.OPENROUTER_API_KEY);
  return {
    mode: parseMode(env.SIRAGPT_JEV_ROUTER),
    configured: !!apiKey,
    apiKey,
    modelId: cleanKey(env.SIRAGPT_JEV_MODEL_ID) || DEFAULT_JEV_MODEL_ID,
    baseUrl: (cleanKey(env.OPENROUTER_BASE_URL) || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: clampNumber(env.SIRAGPT_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    minConfidence: clampNumber(env.SIRAGPT_JEV_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, 0, 1),
  };
}

function isJevRouterEnabled(env = process.env) {
  const config = getJevRouterConfig(env);
  return config.mode !== 'off' && config.configured;
}

function buildJudgePrompt({ prompt, contextChars = 0, attachmentsCount = 0, language = 'es' } = {}) {
  const text = String(prompt || '').slice(0, MAX_PROMPT_CHARS);
  return [
    'You are a routing judge for a chat product with two text tiers:',
    '- "flash": fast tier for everyday chat, short answers, simple lookups and casual conversation.',
    '- "pro": strong tier for multi-step reasoning, code generation or debugging, long or technical documents, legal/financial/medical stakes, and complex analysis.',
    '',
    `Conversation context size: ${Math.max(0, Number(contextChars) || 0)} chars. Attachments: ${Math.max(0, Number(attachmentsCount) || 0)}. User language: ${language}.`,
    'Next user turn:',
    '---',
    text,
    '---',
    'Decide which tier this turn needs. Answer with exactly one word: flash or pro.',
  ].join('\n');
}

function pickOption(value) {
  const v = String(value || '').trim().toLowerCase();
  return TIERS.includes(v) ? v : null;
}

function pickConfidence(source) {
  if (!source || typeof source !== 'object') return null;
  for (const key of ['confidence', 'probability', 'score']) {
    const n = Number(source[key]);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return null;
}

/**
 * Robust parse of Jev's answer regardless of how OpenRouter surfaces it:
 * a bare word, a JSON object ({choice|answer|decision|value|tier}), a
 * {answers:[...]} System-One-like shape, or prose mentioning an option.
 * When prose mentions both options the LAST mention wins ("…between flash
 * and pro I choose pro").
 */
function parseDecisionContent(content) {
  const text = String(content || '').trim();
  if (!text) return null;

  const jsonCandidate = (() => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fenced ? fenced[1] : text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  })();

  if (jsonCandidate && typeof jsonCandidate === 'object') {
    const answers = Array.isArray(jsonCandidate.answers) ? jsonCandidate.answers : null;
    const first = answers && answers.length ? answers[0] : null;
    const holders = [jsonCandidate, first].filter(Boolean);
    for (const holder of holders) {
      for (const key of ['choice', 'answer', 'decision', 'value', 'tier']) {
        const choice = pickOption(holder[key]);
        if (choice) return { choice, confidence: pickConfidence(holder) };
      }
    }
  }

  let last = null;
  const rx = /\b(flash|pro)\b/gi;
  let match;
  while ((match = rx.exec(text)) !== null) last = match[1].toLowerCase();
  return last ? { choice: last, confidence: null } : null;
}

/**
 * Ask Jev which tier the next turn needs. Never throws.
 * → { ok:true, tier, confidence, latencyMs } | { ok:false, reason, latencyMs }
 */
async function judgeTierEscalation(input = {}, opts = {}) {
  const env = opts.env || process.env;
  const config = getJevRouterConfig(env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const startedAt = Date.now();
  const fail = (reason) => ({ ok: false, reason, latencyMs: Date.now() - startedAt });

  if (!config.configured) return fail('not_configured');
  if (typeof fetchImpl !== 'function') return fail('fetch_unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'HTTP-Referer': 'https://siragpt.com',
        'X-Title': 'SiraGPT',
      },
      body: JSON.stringify({
        model: config.modelId,
        temperature: 0,
        max_tokens: 64,
        messages: [{ role: 'user', content: buildJudgePrompt(input) }],
      }),
    });
    if (!response || !response.ok) {
      return fail(`http_${response && response.status ? response.status : 'error'}`);
    }
    let payload;
    try { payload = await response.json(); } catch { return fail('bad_json'); }
    const content = payload
      && payload.choices
      && payload.choices[0]
      && payload.choices[0].message
      ? payload.choices[0].message.content
      : null;
    const decision = parseDecisionContent(content);
    if (!decision) return fail('unparseable');
    return {
      ok: true,
      tier: decision.choice,
      confidence: decision.confidence,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return fail(err && err.name === 'AbortError' ? 'timeout' : 'fetch_failed');
  } finally {
    clearTimeout(timer);
  }
}

function skipResult(routing, reason) {
  return { routing, jev: { ok: false, applied: false, reason } };
}

/**
 * Refine the reasoning-orchestrator routing decision with Jev's verdict.
 * Pure with respect to its inputs: returns a NEW routing object when it
 * changes anything, and the original one untouched otherwise. The caller's
 * apply block keeps enforcing picker-wins, plan eligibility and provider
 * inference — this function only proposes.
 *
 * ctx: { prompt, contextChars, attachmentsCount, hasImages, pickerLocked,
 *        currentModel, reachableModelIds, language }
 */
async function refineRoutingWithJev(routing, ctx = {}, opts = {}) {
  const env = opts.env || process.env;
  const config = getJevRouterConfig(env);
  if (config.mode === 'off' || !config.configured) return { routing, jev: null };
  if (!String(ctx.prompt || '').trim()) return skipResult(routing, 'empty_prompt');
  if (ctx.hasImages) return skipResult(routing, 'has_images');
  if (!isFlashTierModel(ctx.currentModel)) return skipResult(routing, 'not_flash_tier');
  // In active mode an explicit picker model means the verdict can never
  // apply (the apply block honors the picker), so skip the network call.
  if (config.mode === 'on' && ctx.pickerLocked) return skipResult(routing, 'picker_locked');

  const verdict = await judgeTierEscalation({
    prompt: ctx.prompt,
    contextChars: ctx.contextChars,
    attachmentsCount: ctx.attachmentsCount,
    language: ctx.language,
  }, opts);
  if (!verdict.ok) {
    return { routing, jev: { ...verdict, applied: false } };
  }

  const shadow = config.mode === 'shadow';
  const jev = { ...verdict, applied: false, reason: 'keep' };

  if (verdict.tier === 'pro') {
    if (verdict.confidence != null && verdict.confidence < config.minConfidence) {
      return { routing, jev: { ...jev, reason: 'low_confidence' } };
    }
    const target = flashToProModelId(ctx.currentModel, env);
    if (!isProTierModel(target)) {
      return { routing, jev: { ...jev, reason: 'bad_target' } };
    }
    const reachable = ctx.reachableModelIds instanceof Set
      ? ctx.reachableModelIds
      : (Array.isArray(ctx.reachableModelIds) ? new Set(ctx.reachableModelIds) : null);
    if (reachable && !reachable.has(target)) {
      return { routing, jev: { ...jev, reason: 'target_unreachable' } };
    }
    if (shadow) {
      return { routing, jev: { ...jev, reason: 'shadow_escalate' } };
    }
    return {
      routing: {
        ...routing,
        selectedModel: target,
        selectedProvider: null, // caller re-infers provider from the id
        changed: true,
        action: 'escalate',
        shouldApply: true,
        reason: `jev:escalate${verdict.confidence != null ? `:${verdict.confidence}` : ''}`,
      },
      jev: { ...jev, applied: true, reason: 'escalated' },
    };
  }

  // tier === 'flash' — veto a heuristic escalation to the pro tier only;
  // escalations to any other model (vision, long-context…) are not ours.
  if (routing && routing.shouldApply && isProTierModel(routing.selectedModel)) {
    if (shadow) {
      return { routing, jev: { ...jev, reason: 'shadow_veto' } };
    }
    return {
      routing: {
        ...routing,
        selectedModel: routing.userModel || ctx.currentModel || null,
        selectedProvider: routing.userProvider || null,
        changed: false,
        action: 'keep',
        shouldApply: false,
        reason: 'jev:veto_escalation',
      },
      jev: { ...jev, applied: true, reason: 'vetoed_escalation' },
    };
  }
  return { routing, jev };
}

module.exports = {
  DEFAULT_JEV_MODEL_ID,
  getJevRouterConfig,
  isJevRouterEnabled,
  isFlashTierModel,
  isProTierModel,
  flashToProModelId,
  buildJudgePrompt,
  parseDecisionContent,
  judgeTierEscalation,
  refineRoutingWithJev,
};
