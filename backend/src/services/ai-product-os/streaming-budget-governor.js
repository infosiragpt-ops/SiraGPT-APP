'use strict';

/**
 * streaming-budget-governor — live token-spend tracker for streaming
 * model responses. Goes beyond the openclaw v2026.5.7 compaction fix:
 * that one capped the request, this one watches the response in flight
 * and cuts the stream when the running spend approaches the budget,
 * so a runaway generation cannot blow past the operator's ceiling.
 *
 * Public API:
 *   const gov = createStreamingBudgetGovernor({
 *     maxOutputTokens,                  // hard cap; required
 *     softStopRatio,                    // 0..1, default 0.95
 *     estimateTokens,                   // (chunk) => int; default chars/4
 *     onSoftStop,                       // ({spent, max}) sink (optional)
 *     onHardStop,                       // ({spent, max}) sink (optional)
 *     abortController,                  // optional caller-owned controller
 *   })
 *   gov.observe(chunk)                  → 'continue' | 'soft' | 'hard'
 *   gov.spent()                         → integer
 *   gov.remaining()                     → integer
 *   gov.shouldStop()                    → boolean (true once hard cap is hit)
 *   gov.snapshot()                      → { spent, max, softCap, state, chunks }
 *
 * The governor is stateless toward I/O — it does not own the stream.
 * Callers pipe each chunk through observe() and react to the verdict:
 *   - 'continue': keep streaming
 *   - 'soft':     warning crossed; emit a hint, keep streaming
 *   - 'hard':     budget exhausted; close the stream, abort the upstream
 *
 * If an `abortController` is wired, the governor calls .abort() when
 * the hard cap is crossed so callers don't need a separate signal.
 */

const DEFAULT_SOFT_STOP_RATIO = 0.95;

function defaultEstimateTokens(chunk) {
  if (chunk == null) return 0;
  if (typeof chunk === 'number' && Number.isFinite(chunk)) return Math.max(0, Math.floor(chunk));
  if (typeof chunk === 'string') return Math.ceil(chunk.length / 4);
  if (Array.isArray(chunk)) return chunk.reduce((a, c) => a + defaultEstimateTokens(c), 0);
  if (typeof chunk === 'object') {
    if (typeof chunk.text === 'string') return Math.ceil(chunk.text.length / 4);
    if (typeof chunk.content === 'string') return Math.ceil(chunk.content.length / 4);
    if (typeof chunk.tokens === 'number' && Number.isFinite(chunk.tokens)) return Math.max(0, Math.floor(chunk.tokens));
    try { return Math.ceil(JSON.stringify(chunk).length / 4); } catch { return 0; }
  }
  return 0;
}

function createStreamingBudgetGovernor(opts = {}) {
  const max = Number(opts.maxOutputTokens);
  if (!Number.isFinite(max) || max <= 0) {
    throw new TypeError('streaming-budget-governor: maxOutputTokens must be a positive number');
  }
  const softRatio = Number.isFinite(opts.softStopRatio) && opts.softStopRatio > 0 && opts.softStopRatio <= 1
    ? opts.softStopRatio
    : DEFAULT_SOFT_STOP_RATIO;
  const softCap = Math.max(1, Math.floor(max * softRatio));
  const estimateTokens = typeof opts.estimateTokens === 'function' ? opts.estimateTokens : defaultEstimateTokens;
  const onSoftStop = typeof opts.onSoftStop === 'function' ? opts.onSoftStop : null;
  const onHardStop = typeof opts.onHardStop === 'function' ? opts.onHardStop : null;
  const abortController = opts.abortController || null;

  let spent = 0;
  let chunks = 0;
  let state = 'continue';
  let softFired = false;

  function fireSoftOnce() {
    if (softFired) return;
    softFired = true;
    state = state === 'hard' ? 'hard' : 'soft';
    if (onSoftStop) {
      try { onSoftStop({ spent, max, softCap }); } catch { /* swallow */ }
    }
  }

  function observe(chunk) {
    if (state === 'hard') return 'hard';
    let delta = 0;
    try { delta = estimateTokens(chunk); } catch { delta = 0; }
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    spent += delta;
    chunks += 1;

    if (spent >= max) {
      state = 'hard';
      if (onHardStop) {
        try { onHardStop({ spent, max, softCap }); } catch { /* swallow */ }
      }
      if (abortController && typeof abortController.abort === 'function' && !abortController.signal?.aborted) {
        try { abortController.abort('streaming_budget_exhausted'); } catch { /* swallow */ }
      }
      return 'hard';
    }

    if (spent >= softCap) {
      fireSoftOnce();
      return 'soft';
    }

    return 'continue';
  }

  return {
    observe,
    spent: () => spent,
    remaining: () => Math.max(0, max - spent),
    shouldStop: () => state === 'hard',
    snapshot: () => ({ spent, max, softCap, state, chunks }),
  };
}

module.exports = {
  createStreamingBudgetGovernor,
  defaultEstimateTokens,
  DEFAULT_SOFT_STOP_RATIO,
};
