'use strict';

/**
 * codex/model-telemetry — per-model signal for the DeepSeek canary gate.
 *
 * CEO Office decision (msg_ef10ee19d3 + amendment): the flip of
 * SIRAGPT_AGENT_DEFAULT_MODEL to deepseek-v4-flash is gated on ≥1 week of
 * comparable flash-vs-sonnet data across three metrics — stream failure
 * rate, p95 TTFT and cost per run — segmented by model × agent.
 *
 * Families (all best-effort, never throw; same contract as utils/metrics.js):
 *   siragpt_agent_llm_calls_total{model,provider,outcome}
 *       outcome: ok | error | stall | cancelled. One sample per LLM turn.
 *   siragpt_agent_llm_errors_total{model,provider,error_class}
 *       error_class: payment_required | rate_limit | timeout | stall |
 *       provider_error | tool_unsupported | aborted | internal.
 *   siragpt_agent_llm_ttft_ms{model,provider}
 *       Time to first token per streaming call (delta callback or chunk).
 *   siragpt_agent_llm_duration_ms{model,provider,outcome}
 *       Wall time of the full LLM turn.
 *   siragpt_agent_llm_tokens_total{model,direction}  (direction: in|out)
 *       Token totals per model, for cost cross-checks against CodexRunMetric.
 *
 * Cardinality budget: model is a bounded allowlist token (flash|pro|sonnet|
 * opus|gpt|other…), provider one of 6 fixed values, agent one of ~10 —
 * maxSeries keeps each family far below overflow. Unknown ids never create
 * open-ended series.
 */

let metrics = null;
try { metrics = require('../../utils/metrics'); } catch { metrics = null; }

const CALLS = 'siragpt_agent_llm_calls_total';
const ERRORS = 'siragpt_agent_llm_errors_total';
const TTFT = 'siragpt_agent_llm_ttft_ms';
const DURATION = 'siragpt_agent_llm_duration_ms';
const TOKENS = 'siragpt_agent_llm_tokens_total';
const AGENT_CALLS = 'siragpt_agent_llm_calls_by_agent_total';

const OUTCOMES = Object.freeze(['ok', 'error', 'stall', 'cancelled']);

const ERROR_CLASSES = Object.freeze([
  'payment_required',
  'rate_limit',
  'timeout',
  'stall',
  'provider_error',
  'tool_unsupported',
  'aborted',
  'internal',
]);

// Bounded provider vocabulary. Anything else folds into 'other'.
const PROVIDERS = Object.freeze([
  'anthropic',
  'deepseek',
  'openrouter',
  'cerebras',
  'openai',
  'gemini',
]);

// Bounded agent-surface vocabulary for the model×agent segmentation. Runtime
// surfaces are structural; anything else folds into 'other' so a hostile or
// novel caller can never open the label space.
const AGENTS = Object.freeze([
  'codex_build',
  'codex_plan',
  'doc_agent',
  'agent_runner',
  'agent_task',
  'react_agent',
  'se_agent',
]);

function agentToken(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (AGENTS.includes(s)) return s;
  // se-agents route passes the agent role name (code_review, test_gen, …).
  if (/^(code_review|test_gen|debug|code_gen|requirements|maintenance|log_analysis)$/.test(s)) return 'se_agent';
  return 'other';
}

/**
 * Collapse an arbitrary model id into a bounded comparison bucket. The canary
 * compares FLASH vs PRO vs sonnet; everything else lands in coarse families so
 * label cardinality stays closed no matter what ids flow in from clients.
 */
function modelToken(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (/deepseek.*(v4-pro|reasoner|r1)/.test(s)) return 'deepseek_pro';
  if (/deepseek/.test(s)) return 'deepseek_flash';
  if (/sonnet|claude-3-5|claude-3\.5/.test(s)) return 'sonnet';
  if (/opus/.test(s)) return 'opus';
  if (/haiku/.test(s)) return 'haiku';
  if (/^gpt-|^o\d|^chatgpt/.test(s)) return 'gpt';
  if (/gemini/.test(s)) return 'gemini';
  if (/qwen|kimi|glm|llama|mistral|grok|deepcoder/.test(s)) return 'other_oss';
  if (/cerebras|llama3/.test(s)) return 'other_oss';
  return 'other';
}

function providerToken(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return PROVIDERS.includes(s) ? s : 'other';
}

/** Outcome/error class tokens share the bounded normalization used by batch2. */
function token(value, fallback = 'unknown') {
  return String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.:]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function normalizeErrorClass(cls) {
  const t = token(cls, 'internal');
  return ERROR_CLASSES.includes(t) ? t : 'internal';
}

// Idempotent per-family: each register* no-ops when the name already exists,
// and re-runs cleanly after a test _reset() clears the registry.
function registerAll(registry = metrics) {
  if (!registry) return;
  safe(() => registry.registerCounter(CALLS, {
    help: 'Agent LLM turns by model bucket, provider and outcome',
    labels: ['model', 'provider', 'outcome'],
    maxSeries: 128,
  }));
  safe(() => registry.registerCounter(ERRORS, {
    help: 'Failed agent LLM turns by model bucket, provider and bounded error class',
    labels: ['model', 'provider', 'error_class'],
    maxSeries: 128,
  }));
  safe(() => registry.registerHistogram(TTFT, {
    help: 'Milliseconds to first streamed token by model bucket and provider',
    labels: ['model', 'provider'],
    buckets: [100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000],
    maxSeries: 32,
  }));
  safe(() => registry.registerHistogram(DURATION, {
    help: 'Wall milliseconds of the full agent LLM turn by model bucket, provider and outcome',
    labels: ['model', 'provider', 'outcome'],
    buckets: [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 65000],
    maxSeries: 64,
  }));
  safe(() => registry.registerCounter(TOKENS, {
    help: 'Agent LLM token totals by model bucket and direction (in|out)',
    labels: ['model', 'direction'],
    maxSeries: 16,
  }));
  safe(() => registry.registerCounter(AGENT_CALLS, {
    help: 'Agent LLM turns by model bucket and agent surface (model × agent segmentation)',
    labels: ['model', 'agent', 'outcome'],
    maxSeries: 128,
  }));
}
registerAll();

/**
 * Map any LLM transport failure into the bounded error class. The runner's
 * loop_stall classification arrives as err.code === 'loop_stall' /
 * 'stream_stall_retryable'; HTTP statuses come through err.status.
 */
function classifyLlmError(err) {
  if (!err) return 'internal';
  if (err.aborted || /aborted/i.test(String(err.message || ''))) return 'aborted';
  const status = Number(err.status || err.statusCode || err?.response?.status) || 0;
  if (status === 402) return 'payment_required';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'provider_error';
  const text = String(err.code || err.message || '');
  if (/loop_stall|stream_stall|no progress|empty response/i.test(text)) return 'stall';
  if (/timeout|timed out|ETIMEDOUT|ETIMEDOUT|socket hang up|ECONNRESET|ECONNREFUSED|network|fetch failed|epipe/i.test(text)) return 'timeout';
  if (/tool.?not.?support|does not support (?:tools|function)/i.test(text)) return 'tool_unsupported';
  if (/402|insufficient[_ ]?(?:credit|balance)|payment required|can only afford/i.test(text)) return 'payment_required';
  if (/429|rate.?limit|quota exceeded/i.test(text)) return 'rate_limit';
  if (/5\d\d/.test(status ? '' : text)) return 'provider_error';
  return 'internal';
}

function safe(fn) {
  try { fn(); } catch { /* instrumentation never breaks a turn */ }
}

/**
 * Record one finished LLM turn. Call sites:
 *   - codex build/plan loop after each llmTurn resolves/rejects
 *   - agent-runner loop after each callModel resolves/rejects
 *   - react-agent task runtime after each step resolves/rejects
 *
 * @param {object} e
 * @param {string} [e.model]        raw model id (bucketed via modelToken)
 * @param {string} [e.provider]     provider label (bounded)
 * @param {'ok'|'error'|'stall'|'cancelled'} [e.outcome]
 * @param {Error|string} [e.error]  rejection reason when outcome=error
 * @param {number} [e.durationMs]   wall time of the turn
 * @param {number|null} [e.ttftMs]  ms to first token (null when non-streamed)
 * @param {number} [e.tokensIn]
 * @param {number} [e.tokensOut]
 */
function recordLlmTurn(e = {}) {
  const ev = e && typeof e === 'object' ? e : {};
  const model = modelToken(ev.model);
  const provider = providerToken(ev.provider);
  const rawOutcome = String(ev.outcome || '').toLowerCase();
  const outcome = OUTCOMES.includes(rawOutcome) ? rawOutcome : (ev.error ? 'error' : 'ok');
  safe(() => metrics?.counter?.(CALLS, { model, provider, outcome }, 1));
  safe(() => metrics?.counter?.(AGENT_CALLS, { model, agent: agentToken(ev.agent), outcome }, 1));
  if (outcome === 'error') {
    const cls = classifyLlmError(ev.error);
    safe(() => metrics?.counter?.(ERRORS, { model, provider, error_class: cls }, 1));
  }
  const durationMs = Number(ev.durationMs);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    safe(() => metrics?.observe?.(DURATION, { model, provider, outcome }, durationMs));
  }
  const ttftMs = Number(ev.ttftMs);
  if (Number.isFinite(ttftMs) && ttftMs >= 0) {
    safe(() => metrics?.observe?.(TTFT, { model, provider }, ttftMs));
  }
  const tokensIn = Math.max(0, Math.floor(Number(ev.tokensIn)) || 0);
  const tokensOut = Math.max(0, Math.floor(Number(ev.tokensOut)) || 0);
  if (tokensIn > 0) safe(() => metrics?.counter?.(TOKENS, { model, direction: 'in' }, tokensIn));
  if (tokensOut > 0) safe(() => metrics?.counter?.(TOKENS, { model, direction: 'out' }, tokensOut));
}

module.exports = {
  CALLS,
  ERRORS,
  TTFT,
  DURATION,
  TOKENS,
  AGENT_CALLS,
  OUTCOMES,
  ERROR_CLASSES,
  AGENTS,
  classifyLlmError,
  modelToken,
  providerToken,
  agentToken,
  recordLlmTurn,
  registerAll,
};
