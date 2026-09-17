'use strict';

/**
 * native-llm — DeepSeek direct-API client + reliability primitives for the
 * agent runner. The drift on the VPS ran tool-call turns against the native
 * DeepSeek API ("Never OpenRouter" for agents: one less aggregator hop,
 * no OpenRouter credit double-accounting). This module is the reviewed
 * port of that machinery:
 *
 *   - FLASH / PRO tiering constants (env-overridable)
 *   - resolveNativeDeepSeekModel: normalize any incoming model id to the
 *     DeepSeek flash/pro pair, or pass through an explicit fallback model
 *   - createNativeDeepSeekClient: OpenAI-SDK client pointed at api.deepseek.com
 *   - repairToolArgs: salvage JSON tool arguments that models emit with
 *     trailing commas, single quotes, unquoted keys, code fences, etc.
 *   - MAX_TOKENS_DEFAULT 1500: OpenRouter/DeepSeek reserve max_tokens up
 *     front; a low balance rejects large reservations with 402 even when
 *     the actual turn needs a few hundred tokens. 1500 still fits a tool
 *     call plus arguments.
 *   - isTransientLlmError / backoffMs / sleep: bounded retry (LLM_RETRY_MAX=3)
 *     for 429/network blips; never retry 402 (permanent) or client errors.
 */

const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.AGENT_TASK_LLM_TIMEOUT_MS || '', 10) || 60_000;

const FLASH = process.env.AGENT_FLASH_MODEL || 'deepseek-v4-flash';
const PRO = process.env.AGENT_PRO_MODEL || 'deepseek-v4-pro';
const LLM_RETRY_MAX = Math.max(1, Number.parseInt(process.env.LLM_RETRY_MAX || '', 10) || 3);

// Tool-call turns are SHORT. Providers charge/reserve max_tokens up front:
// with a low balance a big reservation gets rejected with 402 before a single
// token is generated. 2048 fits a code-bearing tool call (contract floor in
// agent-runner-routing.test.js) while staying far below the 8192 reservation
// that 402s on low balances.
const MAX_TOKENS_DEFAULT = 2048;

function resolveAgentRunnerMaxTokens(env = process.env) {
  const raw = Number(env.SIRAGPT_AGENT_RUNNER_MAX_TOKENS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(256, Math.min(8192, Math.floor(raw)));
  }
  return MAX_TOKENS_DEFAULT;
}

/** True when a DeepSeek API key exists and looks non-placeholder. */
function hasUsableDeepSeekKey(env = process.env) {
  const key = env.DEEPSEEK_API_KEY;
  return typeof key === 'string' && key.length >= 20 && !/^your_|^sk-xxx/i.test(key);
}

/**
 * Map any incoming model id to the DeepSeek tier pair. Unknown ids collapse
 * to FLASH unless they name the pro/reasoner family. Non-DeepSeek ids are
 * only honored when explicitly allowlisted via AGENT_BATCH_FALLBACK_MODELS
 * (see routes/agent-batch.js); here we keep it strict: bare ids resolve to
 * a DeepSeek tier.
 */
function resolveNativeDeepSeekModel(raw, { proModel = PRO, flashModel = FLASH } = {}) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return flashModel;
  if (/v4-pro|reasoner|r1/.test(s)) return proModel;
  return flashModel;
}

/**
 * OpenAI-compatible client against the NATIVE DeepSeek API. Agents must not
 * route through OpenRouter: direct API means simpler billing, fewer hops and
 * no aggregator-side rate limits stacked on top of DeepSeek's own.
 * Returns null when no usable key is configured — callers decide whether to
 * fall back to their existing provider chain.
 */
function createNativeDeepSeekClient(env = process.env, OpenAIClient) {
  let OpenAI = OpenAIClient;
  if (!OpenAI) {
    try { OpenAI = require('openai'); } catch (_) { return null; }
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: 0, // retries live in callModelWithRetry so 402 never retries
  });
}

/** Same as above but resolves the key from either DEEPSEEK_API_KEY or OPENAI_API_KEY-less setups; null when unusable. */
function resolveAgentLlmClient(env = process.env, OpenAIClient) {
  if (!hasUsableDeepSeekKey(env)) return null;
  return createNativeDeepSeekClient(env, OpenAIClient);
}

// ── repairToolArgs ──────────────────────────────────────────────────
// Models occasionally emit slightly-broken JSON for tool arguments
// (markdown fences, trailing commas, single quotes, unquoted keys,
 // trailing prose). One cheap repair pass beats failing the whole turn.

function stripJsonFences(s) {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s.trim());
  return m ? m[1] : s;
}

function stripTrailingCommas(s) {
  return s.replace(/,\s*([}\]])/g, '$1');
}

function quoteSingleQuotedStrings(s) {
  // Only safe when no double quotes exist anywhere in the payload.
  if (s.includes('"')) return s;
  return s.replace(/'([^'\\]*)'/g, '"$1"');
}

function trimAfterLastBrace(s) {
  const lastObj = s.lastIndexOf('}');
  const lastArr = s.lastIndexOf(']');
  const cut = Math.max(lastObj, lastArr);
  if (cut === -1) return s;
  const tail = s.slice(cut + 1);
  // Trailing prose after the final closing bracket is droppable.
  if (/[^}\]\s]/.test(tail.slice(0, 40))) return `${s.slice(0, cut + 1)}${tail.match(/[}\]]*$/)[0] || ''}`;
  return s;
}

/**
 * Attempt to parse `raw` as JSON tool arguments, applying escalating
 * repairs. Returns { ok: true, value } on success or { ok: false }
 * when every attempt fails (caller surfaces __parse_error).
 */
function repairToolArgs(raw) {
  if (raw == null) return { ok: true, value: {} };
  if (typeof raw === 'object') return { ok: true, value: raw };
  let s = String(raw).trim();
  if (!s) return { ok: true, value: {} };

  const attempts = [
    s,
    stripJsonFences(s),
    trimAfterLastBrace(stripJsonFences(s)),
    stripTrailingCommas(trimAfterLastBrace(stripJsonFences(s))),
    quoteSingleQuotedStrings(stripTrailingCommas(trimAfterLastBrace(stripJsonFences(s)))),
  ];
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return { ok: true, value };
      return { ok: true, value: { value } }; // scalar args wrap into an object
    } catch { /* next attempt */ }
  }
  return { ok: false };
}

// ── transient-error classification + bounded retry ─────────────────

function statusOf(err) {
  return Number(err?.status || err?.statusCode || err?.response?.status) || 0;
}

function isTransientLlmError(err) {
  if (!err) return false;
  const status = statusOf(err);
  if (status === 429) return true;             // rate limited — retry with backoff
  if (status >= 500 && status <= 599) return true;
  if (status >= 400 && status < 500) return false; // permanent client errors
  const msg = String(err?.message || '').toLowerCase();
  return /etimedout|econnreset|econnrefused|socket hang up|network error|fetch failed|epipe/.test(msg);
}

function backoffMs(attempt, { baseMs = 500, factor = 2, maxMs = 8000, jitter = true } = {}) {
  let ms = Math.min(maxMs, baseMs * (factor ** Math.max(0, attempt)));
  if (jitter) ms = Math.floor(ms * (0.5 + Math.random() * 0.5));
  return ms;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Bounded retry wrapper around a chat.completions.create-style thunk.
 * Retries only transient failures (429/5xx/network), never 402/4xx.
 */
async function callModelWithRetry(thunk, { signal, retryMax = LLM_RETRY_MAX, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < Math.max(1, retryMax); attempt += 1) {
    if (signal?.aborted) { const e = new Error('aborted'); e.aborted = true; throw e; }
    try {
      return await thunk(attempt);
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      if (!isTransientLlmError(err)) throw err;
      if (attempt >= retryMax - 1) throw err;
      if (typeof onRetry === 'function') {
        try { onRetry({ attempt: attempt + 1, err }); } catch (_) { /* trace only */ }
      }
      await sleep(backoffMs(attempt, { jitter: false }), signal);
    }
  }
  throw lastErr;
}

module.exports = {
  FLASH,
  PRO,
  LLM_RETRY_MAX,
  MAX_TOKENS_DEFAULT,
  hasUsableDeepSeekKey,
  resolveNativeDeepSeekModel,
  createNativeDeepSeekClient,
  resolveAgentLlmClient,
  resolveAgentRunnerMaxTokens,
  repairToolArgs,
  isTransientLlmError,
  backoffMs,
  sleep,
  callModelWithRetry,
};
