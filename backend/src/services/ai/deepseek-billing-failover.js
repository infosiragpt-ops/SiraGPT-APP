'use strict';

/**
 * deepseek-billing-failover — keep «Sira Rápido / Sira Pro» answering when the
 * DeepSeek direct account is out of credit or its key is rejected.
 *
 * Live failure (2026-09-18): api.deepseek.com answered `402 Insufficient
 * Balance`; the chat turn ended as «El modelo no pudo completar la respuesta»
 * although the SAME model is reachable through OpenRouter
 * (`deepseek/deepseek-v4-pro`). This wraps the DeepSeek OpenAI-compatible
 * client: a billing/auth failure (402, 401, 403, "insufficient balance",
 * "invalid api key", quota) on `chat.completions.create` is retried ONCE on
 * the OpenRouter client with the model id mapped to its OpenRouter slug —
 * streaming and non-streaming alike, same request body. The failure is
 * memoised (`SIRAGPT_DEEPSEEK_BILLING_MEMO_MS`, default 5 min) so the next
 * turns go straight to OpenRouter without paying a dead round-trip; after the
 * TTL DeepSeek direct is probed again. Transient errors (5xx, timeouts) are
 * NOT failed over here — the existing retry/failover policy owns those.
 *
 * Same model, different transport: this never changes which model the user
 * picked, in line with «los motores siguen al modelo elegido; failover solo
 * ante errores del proveedor».
 */

const DEFAULT_MEMO_MS = 5 * 60 * 1000;
const state = { failedAt: 0, memoMs: DEFAULT_MEMO_MS, lastReason: null };

function memoMs(env = process.env) {
  const n = Number(env.SIRAGPT_DEEPSEEK_BILLING_MEMO_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_MEMO_MS;
}

function isBillingOrAuthError(err) {
  if (!err) return false;
  const status = Number(err.status || err.statusCode || (err.response && err.response.status) || 0);
  if (status === 402 || status === 401 || status === 403) return true;
  const msg = `${err.code || ''} ${err.message || ''} ${(err.error && err.error.message) || ''}`.toLowerCase();
  return /insufficient[_ ]balance|insufficient[_ ]quota|payment required|invalid api key|incorrect api key|authentication|unauthori|billing|quota exceeded/i.test(msg)
    && !/rate ?limit/i.test(msg);
}

/** `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`; slugs pass through. */
function toOpenRouterSlug(model) {
  const m = String(model || '').trim();
  if (!m) return 'deepseek/deepseek-v4-flash';
  if (m.includes('/')) return m;
  return `deepseek/${m}`;
}

function isDirectFailureMemoised(env = process.env) {
  if (!state.failedAt) return false;
  if (Date.now() - state.failedAt > memoMs(env)) { state.failedAt = 0; state.lastReason = null; return false; }
  return true;
}

function markDirectFailure(err, env = process.env) {
  state.failedAt = Date.now();
  state.memoMs = memoMs(env);
  state.lastReason = String((err && (err.status || err.statusCode)) || '') + ' ' + String((err && err.message) || '').slice(0, 120);
}

function resetForTests() { state.failedAt = 0; state.lastReason = null; }

function snapshot() {
  return { memoised: isDirectFailureMemoised(), failedAt: state.failedAt || null, reason: state.lastReason };
}

/**
 * @param {object} client                 OpenAI-compatible DeepSeek client
 * @param {object} opts
 * @param {() => object} opts.fallbackClientFactory  returns the OpenRouter client (may throw when unavailable)
 * @param {object} [opts.env]
 * @param {object} [opts.log]
 */
function wrapDeepSeekClient(client, { fallbackClientFactory, env = process.env, log = console } = {}) {
  if (!client || !client.chat || !client.chat.completions || typeof client.chat.completions.create !== 'function') return client;
  if (typeof fallbackClientFactory !== 'function') return client;
  const primaryCreate = client.chat.completions.create.bind(client.chat.completions);

  const viaOpenRouter = async (body, options, reason) => {
    const fallback = fallbackClientFactory();
    if (!fallback || !fallback.chat || !fallback.chat.completions) throw new Error('openrouter_unavailable');
    const mapped = { ...body, model: toOpenRouterSlug(body && body.model) };
    log.warn?.(`[deepseek-failover] DeepSeek direct ${reason} → OpenRouter ${mapped.model}`);
    return options === undefined ? fallback.chat.completions.create(mapped) : fallback.chat.completions.create(mapped, options);
  };

  const create = async (body, options) => {
    if (isDirectFailureMemoised(env)) {
      try {
        return await viaOpenRouter(body, options, `memoised (${state.lastReason})`);
      } catch (fallbackErr) {
        // OpenRouter itself unavailable: give DeepSeek direct a real try.
        log.warn?.(`[deepseek-failover] OpenRouter fallback failed (${fallbackErr && fallbackErr.message}); trying DeepSeek direct`);
      }
    }
    try {
      return options === undefined ? await primaryCreate(body) : await primaryCreate(body, options);
    } catch (err) {
      if (!isBillingOrAuthError(err)) throw err;
      markDirectFailure(err, env);
      try {
        return await viaOpenRouter(body, options, `${err.status || err.statusCode || ''} ${String(err.message || '').slice(0, 80)}`.trim());
      } catch (fallbackErr) {
        log.warn?.(`[deepseek-failover] fallback unavailable: ${fallbackErr && fallbackErr.message}`);
        throw err;
      }
    }
  };

  // Keep the client's shape (prototype methods, other namespaces) intact.
  client.chat.completions.create = create;
  client.__deepseekBillingFailover = true;
  return client;
}

module.exports = { wrapDeepSeekClient, isBillingOrAuthError, toOpenRouterSlug, isDirectFailureMemoised, snapshot, resetForTests, DEFAULT_MEMO_MS };
