'use strict';

/**
 * speculative-model-race — launch the primary model and one or more
 * speculative replicas in parallel, take the first valid response,
 * cancel the rest. Trades a small amount of incremental cost for a
 * meaningful P99-latency reduction when the primary occasionally
 * stalls (cold cache, regional brownout). Goes beyond openclaw
 * v2026.5.7's sequential override routing.
 *
 * Public API:
 *   const racer = createSpeculativeRace({
 *     models,                           // string[] (≥1; first is primary)
 *     stagger,                          // ms before launching each replica
 *     accept,                           // (value, model) => bool; default truthy
 *     onLaunch,                         // ({ model, index }) sink
 *     onLose,                           // ({ model, index, reason }) sink
 *     now,                              // clock injector
 *   })
 *   await racer.run(async (modelId, signal) => {...})
 *     → { ok: true, model, value, raced, latencyMs, attempts }
 *     → throws RaceFailedError when every replica errors / is rejected
 *
 * Each runner is given an AbortSignal that fires when the race is
 * decided so losers stop spending tokens. `accept` lets callers
 * filter out partial / refusal responses (e.g. "I cannot help with
 * that") so a faster-but-worse response doesn't beat a correct one.
 */

const DEFAULT_STAGGER_MS = 0;

class RaceFailedError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'RaceFailedError';
    this.attempts = attempts;
  }
}

function createSpeculativeRace(opts = {}) {
  const models = Array.isArray(opts.models) ? opts.models.filter((m) => typeof m === 'string' && m) : [];
  if (models.length === 0) throw new TypeError('speculative-race: models[] required');
  const stagger = Number.isFinite(opts.stagger) && opts.stagger > 0 ? Math.floor(opts.stagger) : DEFAULT_STAGGER_MS;
  const accept = typeof opts.accept === 'function' ? opts.accept : (v) => v != null && v !== '';
  const onLaunch = typeof opts.onLaunch === 'function' ? opts.onLaunch : null;
  const onLose = typeof opts.onLose === 'function' ? opts.onLose : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  function delay(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (typeof t.unref === 'function') t.unref();
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('cancelled'));
        }, { once: true });
      }
    });
  }

  async function run(runner) {
    if (typeof runner !== 'function') throw new TypeError('speculative-race.run: runner required');
    const startedAt = now();
    const ctrls = models.map(() => new AbortController());
    const attempts = models.map((m) => ({ model: m, ok: null, latencyMs: null, error: null }));
    let winner = null;

    function abortLosers(winningIndex, reason) {
      for (let i = 0; i < ctrls.length; i++) {
        if (i === winningIndex) continue;
        if (!ctrls[i].signal.aborted) {
          try { ctrls[i].abort(reason || 'speculative_race_decided'); } catch { /* swallow */ }
        }
        if (attempts[i].ok === null) {
          attempts[i].ok = false;
          attempts[i].error = reason || 'cancelled';
          if (onLose) {
            try { onLose({ model: models[i], index: i, reason: reason || 'cancelled' }); } catch { /* swallow */ }
          }
        }
      }
    }

    const promises = models.map((model, i) => (async () => {
      if (i > 0 && stagger > 0) {
        try { await delay(stagger * i, ctrls[i].signal); } catch { return null; }
      }
      if (ctrls[i].signal.aborted) return null;
      if (onLaunch) {
        try { onLaunch({ model, index: i }); } catch { /* swallow */ }
      }
      const t0 = now();
      try {
        const value = await runner(model, ctrls[i].signal);
        const elapsed = now() - t0;
        if (!accept(value, model)) {
          attempts[i].ok = false;
          attempts[i].latencyMs = elapsed;
          attempts[i].error = 'rejected_by_accept';
          if (onLose) {
            try { onLose({ model, index: i, reason: 'rejected_by_accept' }); } catch { /* swallow */ }
          }
          return null;
        }
        if (winner) return null; // someone else already won
        winner = { model, value, index: i, latencyMs: elapsed };
        attempts[i].ok = true;
        attempts[i].latencyMs = elapsed;
        abortLosers(i);
        return winner;
      } catch (err) {
        const elapsed = now() - t0;
        attempts[i].ok = false;
        attempts[i].latencyMs = elapsed;
        attempts[i].error = err && err.message;
        if (onLose) {
          try { onLose({ model, index: i, reason: 'error', error: err }); } catch { /* swallow */ }
        }
        return null;
      }
    })());

    const results = await Promise.all(promises);
    const w = results.find((r) => r) || winner;
    if (!w) {
      throw new RaceFailedError('every replica failed or was rejected', attempts);
    }
    return {
      ok: true,
      model: w.model,
      value: w.value,
      raced: models.length,
      latencyMs: now() - startedAt,
      attempts,
    };
  }

  return { run, models: () => models.slice() };
}

module.exports = {
  createSpeculativeRace,
  RaceFailedError,
  DEFAULT_STAGGER_MS,
};
