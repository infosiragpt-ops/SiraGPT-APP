'use strict';

/**
 * adaptive-retry-strategy — executes the recovery decision produced
 * by tool-error-classifier.
 *
 * Why this exists:
 *  `tool-resilience.js` retries with fixed backoff. `tool-error-
 *  classifier.js` decides the right strategy (retry_with_backoff,
 *  retry_with_fallback_model, retry_with_different_tool,
 *  ask_user_for_input, escalate_to_operator, abort_and_surface_error)
 *  but DOES NOT execute anything. This module closes the loop.
 *
 *  Given:
 *    - a tool-invoking function (async)
 *    - an optional `fallback_model_caller` function
 *    - an optional `fallback_tool_caller` function
 *    - context: tool name, max attempts, base backoff ms
 *
 *  it runs the invocation, classifies failures with
 *  `classifyToolError`, executes the chosen strategy, and returns a
 *  structured outcome:
 *
 *    { success: true, result, attempts, history } |
 *    { success: false, errorClassification, attempts, history, finalReason }
 *
 * Pure async function (no globals, no side effects beyond what the
 * caller's function does). Caps total attempts via maxAttempts and
 * never recurses without bound.
 *
 * Public API:
 *   executeAdaptive(invoke, context) → Promise<Outcome>
 *   sleepFor(ms)                     → Promise<void>   (utility, swappable)
 */

const { classifyToolError } = require('./tool-error-classifier');

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

async function executeAdaptive(invoke, context = {}) {
  if (typeof invoke !== 'function') {
    throw new TypeError('executeAdaptive: invoke must be a function');
  }
  const ctx = {
    toolName: context.toolName || null,
    maxAttempts: Number(context.maxAttempts) || DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs: Number(context.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs: Number(context.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS,
    fallbackModel: typeof context.fallbackModelCaller === 'function' ? context.fallbackModelCaller : null,
    fallbackTool: typeof context.fallbackToolCaller === 'function' ? context.fallbackToolCaller : null,
    askUser: typeof context.askUserCaller === 'function' ? context.askUserCaller : null,
    escalate: typeof context.escalateCaller === 'function' ? context.escalateCaller : null,
    sleep: typeof context.sleep === 'function' ? context.sleep : sleepFor,
    onAttempt: typeof context.onAttempt === 'function' ? context.onAttempt : noop,
  };

  const history = [];
  let attempts = 0;
  let lastDecision = null;

  while (attempts < ctx.maxAttempts) {
    attempts += 1;
    ctx.onAttempt({ attempt: attempts, max: ctx.maxAttempts });
    try {
      const result = await invoke({ attempt: attempts });
      history.push({ attempt: attempts, status: 'success' });
      return { success: true, result, attempts, history };
    } catch (err) {
      const decision = classifyToolError(err, {
        toolName: ctx.toolName,
        attempts,
        maxAttempts: ctx.maxAttempts,
        hasFallbackModel: Boolean(ctx.fallbackModel),
        hasFallbackTool: Boolean(ctx.fallbackTool),
      });
      lastDecision = decision;
      history.push({ attempt: attempts, status: 'error', decision });

      // Stop conditions
      if (!decision.retryable && decision.strategy === 'abort_and_surface_error') {
        return finalFailure(decision, attempts, history, 'abort_and_surface_error');
      }

      // Branch on strategy
      if (decision.strategy === 'retry_with_backoff') {
        const delay = decideDelay(decision, attempts, ctx);
        await ctx.sleep(delay);
        continue;
      }

      if (decision.strategy === 'retry_with_fallback_model' && ctx.fallbackModel) {
        try {
          const result = await ctx.fallbackModel({ attempt: attempts, originalError: err });
          history.push({ attempt: attempts, status: 'success', via: 'fallback_model' });
          return { success: true, result, attempts, history };
        } catch (fallbackErr) {
          history.push({ attempt: attempts, status: 'error', via: 'fallback_model', error: pickMessage(fallbackErr) });
          // Treat fallback failure as a system error and continue the loop
          continue;
        }
      }

      if (decision.strategy === 'retry_with_different_tool' && ctx.fallbackTool) {
        try {
          const result = await ctx.fallbackTool({ attempt: attempts, originalError: err });
          history.push({ attempt: attempts, status: 'success', via: 'fallback_tool' });
          return { success: true, result, attempts, history };
        } catch (fallbackErr) {
          history.push({ attempt: attempts, status: 'error', via: 'fallback_tool', error: pickMessage(fallbackErr) });
          continue;
        }
      }

      if (decision.strategy === 'ask_user_for_input') {
        if (ctx.askUser) {
          try {
            const result = await ctx.askUser({ decision, attempts });
            history.push({ attempt: attempts, status: 'paused_for_user' });
            return { success: false, errorClassification: decision, attempts, history, finalReason: 'paused_for_user', userPayload: result };
          } catch (askErr) {
            history.push({ attempt: attempts, status: 'error', via: 'ask_user', error: pickMessage(askErr) });
          }
        }
        return finalFailure(decision, attempts, history, 'ask_user_for_input');
      }

      if (decision.strategy === 'escalate_to_operator') {
        if (ctx.escalate) {
          try { await ctx.escalate({ decision, attempts, history }); } catch { /* swallow */ }
        }
        return finalFailure(decision, attempts, history, 'escalate_to_operator');
      }

      // Default: stop
      return finalFailure(decision, attempts, history, decision.strategy || 'unknown');
    }
  }
  // Exhausted attempts
  return finalFailure(lastDecision, attempts, history, 'max_attempts_reached');
}

function finalFailure(decision, attempts, history, finalReason) {
  return {
    success: false,
    errorClassification: decision || null,
    attempts,
    history,
    finalReason,
  };
}

function decideDelay(decision, attempts, ctx) {
  // Honour upstream Retry-After hint when present
  if (decision.retryAfterMs && Number.isFinite(decision.retryAfterMs)) {
    return Math.min(decision.retryAfterMs, ctx.maxBackoffMs);
  }
  // Exponential backoff with jitter
  const exp = Math.min(ctx.baseBackoffMs * Math.pow(2, attempts - 1), ctx.maxBackoffMs);
  const jitter = exp * 0.25 * (Math.random() - 0.5) * 2;
  return Math.max(50, Math.round(exp + jitter));
}

function sleepFor(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function pickMessage(err) {
  if (!err) return '';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}

function noop() {}

module.exports = {
  executeAdaptive,
  sleepFor,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  _internal: { decideDelay, finalFailure, pickMessage },
};
