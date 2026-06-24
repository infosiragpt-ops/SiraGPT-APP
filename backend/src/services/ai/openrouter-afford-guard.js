'use strict';

/**
 * openrouter-afford-guard — graceful degradation for OpenRouter 402s.
 *
 * When the account balance is low, OpenRouter rejects the WHOLE request if
 * `max_tokens` (or the model's default completion limit — 65k on grok/glm —
 * when the field is absent) costs more than the remaining credits:
 *
 *   402 "You requested up to 65536 tokens, but can only afford 4863"
 *
 * Seen in prod as every chat falling to the degraded stream. The error
 * message tells us EXACTLY how many tokens are affordable, so instead of
 * failing the turn we retry once with `max_tokens` clamped to ~85% of that
 * budget (headroom for the prompt-cost drift between the two calls). A
 * shorter answer beats no answer; the definitive fix is topping up credits.
 *
 * `wrapOpenRouterClient` patches `chat.completions.create` in place and is
 * idempotent, so every OpenRouter client factory can apply it blindly.
 */

const AFFORD_RX = /can only afford (\d+)/i;
const MIN_RETRY_TOKENS = 256;

function extractMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(
    err.message
    || err.error?.message
    || err.response?.data?.error?.message
    || ''
  );
}

/**
 * Returns the clamped retry budget when `err` is an OpenRouter
 * insufficient-credits 402, else null.
 */
function parseAffordableTokens(err) {
  const message = extractMessage(err);
  const statusIs402 = Number(err?.status) === 402 || Number(err?.response?.status) === 402 || /\b402\b/.test(message);
  if (!statusIs402) return null;
  const match = message.match(AFFORD_RX);
  if (!match) return null;
  const afford = Math.floor(Number(match[1]) * 0.85);
  return Number.isFinite(afford) && afford >= MIN_RETRY_TOKENS ? afford : null;
}

function wrapOpenRouterClient(client) {
  const completions = client?.chat?.completions;
  if (!completions || typeof completions.create !== 'function' || completions.__affordGuard) {
    return client;
  }
  const original = completions.create.bind(completions);
  completions.create = async (params, opts) => {
    try {
      return await original(params, opts);
    } catch (err) {
      const afford = parseAffordableTokens(err);
      if (!afford) throw err;
      try { console.warn(`[openrouter-afford] 402 insufficient credits — retrying with max_tokens=${afford}`); } catch (_) { /* noop */ }
      const retryParams = { ...params, max_tokens: afford };
      // max_tokens and max_completion_tokens are mutually exclusive.
      delete retryParams.max_completion_tokens;
      return original(retryParams, opts);
    }
  };
  completions.__affordGuard = true;
  return client;
}

module.exports = { wrapOpenRouterClient, parseAffordableTokens, MIN_RETRY_TOKENS };
