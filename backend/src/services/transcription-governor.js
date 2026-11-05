'use strict';

/**
 * transcription-governor — process-wide admission for cloud speech-to-text
 * requests, one ledger per provider.
 *
 * Every segment request of every transcription job in this process (the long
 * and short media lanes, dictation, link clips, the runner's transcribe_audio)
 * takes a permit here before it leaves the host, so 100 ten-hour videos fan
 * out across every configured provider without any of them seeing more
 * requests than its plan allows, and a 429 answered to ONE job slows every
 * job's traffic to that provider instead of being discovered 24 times.
 *
 * Per provider:
 *   - `inFlight` requests at once (TRANSCRIBE_<PROVIDER>_IN_FLIGHT; defaults
 *     below follow the providers' published concurrency for pay-as-you-go
 *     plans, conservatively);
 *   - optional requests per minute (TRANSCRIBE_<PROVIDER>_RPM) and audio
 *     seconds per hour (TRANSCRIBE_<PROVIDER>_AUDIO_SECONDS_PER_HOUR), the two
 *     quotas Groq publishes per tier; unset means «let the 429 feedback decide»;
 *   - adaptive capacity (AIMD): a rate limit halves the effective in-flight
 *     cap (at most once per burst) and pauses new requests for the hinted
 *     Retry-After (15 s without a hint, never more than 30 min); each minute
 *     of clean traffic gives one slot back, up to the configured cap.
 *
 * Permits are FIFO per provider and abortable (the job's signal). `capacity()`
 * tells the engine's scheduler whether a provider can take a piece NOW, so a
 * saturated or paused provider is skipped for the next healthy one instead of
 * queueing behind it. Nothing here knows API keys, file names or text.
 *
 * `now`/`sleep` are injectable: a job that runs with a fake clock (tests) gets
 * a governor on the same clock, and a wake-up that fires before the clock
 * moved treats the wait as served (the pause or the window entry expires) so
 * a fake sleep can never spin.
 */

const DEFAULT_LIMITS = Object.freeze({
  // ElevenLabs Scribe batch STT: 8 (Free) … 60 (Scale) concurrent by plan.
  elevenlabs: Object.freeze({ inFlight: 8 }),
  // AssemblyAI: 200 concurrent async jobs on paid plans; 5 on Free.
  assemblyai: Object.freeze({ inFlight: 32 }),
  // Deepgram pre-recorded: 50 concurrent requests per project (PAYG / Growth).
  deepgram: Object.freeze({ inFlight: 24 }),
  mistral: Object.freeze({ inFlight: 8 }),
  openai: Object.freeze({ inFlight: 12 }),
  // Groq: 20 RPM / 7 200 audio-s per hour on Free, 400 RPM / 400 000 on
  // Developer. The tier is not knowable here: the 429 feedback decides.
  groq: Object.freeze({ inFlight: 8 }),
  xai: Object.freeze({ inFlight: 8 }),
  meta: Object.freeze({ inFlight: 4 }),
});
const FALLBACK_IN_FLIGHT = 6;
const MAX_IN_FLIGHT = 200;
const DEFAULT_PAUSE_MS = 15_000;
const MIN_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = 30 * 60_000;
const SHRINK_COOLDOWN_MS = 5_000;
const GROW_INTERVAL_MS = 60_000;
const RPM_WINDOW_MS = 60_000;
const AUDIO_WINDOW_MS = 3_600_000;

function abortError() {
  return Object.assign(new Error('aborted by user'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function providerKey(name) {
  return String(name || '').trim().toLowerCase();
}

function envName(provider) {
  return providerKey(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function envInt(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The configured limits of one provider (defaults + TRANSCRIBE_<PROVIDER>_* overrides). */
function limitsFor(env = process.env, provider) {
  const key = providerKey(provider);
  const base = DEFAULT_LIMITS[key] || {};
  const prefix = `TRANSCRIBE_${envName(key)}_`;
  return {
    inFlight: envInt(env[`${prefix}IN_FLIGHT`], base.inFlight ?? FALLBACK_IN_FLIGHT, 1, MAX_IN_FLIGHT),
    rpm: envInt(env[`${prefix}RPM`], null, 1, 100_000),
    audioSecondsPerHour: envInt(env[`${prefix}AUDIO_SECONDS_PER_HOUR`], null, 60, 10_000_000),
  };
}

function createTranscriptionGovernor({ env = process.env, now = Date.now, sleep = defaultSleep } = {}) {
  const states = new Map();

  function stateFor(provider) {
    const key = providerKey(provider) || 'unknown';
    let state = states.get(key);
    if (!state) {
      const limits = limitsFor(env, key);
      state = {
        name: key,
        limits,
        inFlight: 0,
        waiters: [],
        pausedUntil: 0,
        effectiveCap: limits.inFlight,
        // -Infinity: «never» (a clock that starts at 0 must still allow the first shrink).
        lastShrinkAt: -Infinity,
        lastGrowAt: -Infinity,
        requests: [],
        audio: [],
        rateLimits: 0,
        completed: 0,
        errors: 0,
        wakePending: false,
        wakeAt: 0,
      };
      states.set(key, state);
    }
    return state;
  }

  function prune(state, at) {
    while (state.requests.length && at - state.requests[0] >= RPM_WINDOW_MS) state.requests.shift();
    while (state.audio.length && at - state.audio[0].at >= AUDIO_WINDOW_MS) state.audio.shift();
  }

  function audioUsed(state) {
    let total = 0;
    for (const entry of state.audio) total += entry.seconds;
    return total;
  }

  /** Why a request cannot start now: null (it can), 'paused', 'in_flight', 'rpm' or 'audio'. */
  function blocker(state, at) {
    prune(state, at);
    if (at < state.pausedUntil) return 'paused';
    if (state.inFlight >= state.effectiveCap) return 'in_flight';
    if (state.limits.rpm != null && state.requests.length >= state.limits.rpm) return 'rpm';
    if (state.limits.audioSecondsPerHour != null && audioUsed(state) >= state.limits.audioSecondsPerHour) return 'audio';
    return null;
  }

  function take(state, audioSeconds) {
    const at = now();
    state.inFlight++;
    state.requests.push(at);
    const seconds = Number(audioSeconds);
    if (Number.isFinite(seconds) && seconds > 0) state.audio.push({ at, seconds });
    let released = false;
    const release = (outcome = 'ok') => {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (outcome === 'ok') {
        state.completed++;
        noteSuccess(state);
      } else if (outcome !== 'aborted' && outcome !== 'rate_limit') {
        state.errors++;
      }
      pump(state);
    };
    return { release, provider: state.name };
  }

  function noteSuccess(state) {
    if (state.effectiveCap >= state.limits.inFlight) return;
    const at = now();
    if (at - Math.max(state.lastShrinkAt, state.lastGrowAt) >= GROW_INTERVAL_MS) {
      state.effectiveCap = Math.min(state.limits.inFlight, state.effectiveCap + 1);
      state.lastGrowAt = at;
    }
  }

  /** The next moment the blocker could clear by itself (a pause end, a window entry expiring). */
  function nextChangeAt(state, reason, at) {
    if (reason === 'paused') return state.pausedUntil;
    if (reason === 'rpm' && state.requests.length) return state.requests[0] + RPM_WINDOW_MS;
    if (reason === 'audio' && state.audio.length) return state.audio[0].at + AUDIO_WINDOW_MS;
    return null;
  }

  /** The wait was served: a clock that did not move still releases what the wait was for. */
  function expire(state, reason) {
    if (reason === 'paused') state.pausedUntil = 0;
    else if (reason === 'rpm') state.requests.shift();
    else if (reason === 'audio') state.audio.shift();
  }

  function pump(state) {
    for (;;) {
      if (!state.waiters.length) return;
      const at = now();
      const reason = blocker(state, at);
      if (!reason) {
        const waiter = state.waiters.shift();
        waiter.cleanup();
        waiter.resolve(take(state, waiter.audioSeconds));
        continue;
      }
      if (reason === 'in_flight') return; // a release() pumps again
      const wakeAt = nextChangeAt(state, reason, at);
      if (wakeAt == null) return;
      if (state.wakePending) return;
      state.wakePending = true;
      state.wakeAt = wakeAt;
      const wait = Math.max(0, wakeAt - at);
      Promise.resolve(sleep(wait)).catch(() => {}).then(() => {
        state.wakePending = false;
        // A fake clock did not move: the sleep still counts as the wait served.
        if (now() < state.wakeAt && blocker(state, now()) === reason) expire(state, reason);
        pump(state);
      });
      return;
    }
  }

  function acquire(provider, { signal = null, audioSeconds = 0 } = {}) {
    const state = stateFor(provider);
    throwIfAborted(signal);
    if (!state.waiters.length && !blocker(state, now())) return Promise.resolve(take(state, audioSeconds));
    return new Promise((resolve, reject) => {
      const waiter = { audioSeconds, resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      state.waiters.push(waiter);
      pump(state);
    });
  }

  /**
   * A provider answered 429: pause its new requests for the hinted wait and
   * halve its effective in-flight cap (once per burst: twenty simultaneous
   * 429s are one event, not a collapse to a single slot).
   */
  function noteRateLimited(provider, retryAfterMs = null) {
    const state = stateFor(provider);
    const at = now();
    const hinted = Number(retryAfterMs);
    const wait = Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Number.isFinite(hinted) && hinted > 0 ? hinted : DEFAULT_PAUSE_MS));
    state.pausedUntil = Math.max(state.pausedUntil, at + wait);
    state.rateLimits++;
    if (at - state.lastShrinkAt >= SHRINK_COOLDOWN_MS) {
      state.effectiveCap = Math.max(1, Math.floor(state.effectiveCap / 2));
      state.lastShrinkAt = at;
    }
    pump(state);
    return { pausedMs: wait, effectiveCap: state.effectiveCap };
  }

  /** What a provider can take NOW (the scheduler's view): free slots, or why none. */
  function capacity(provider) {
    const state = stateFor(provider);
    const at = now();
    const reason = blocker(state, at);
    const free = reason ? 0 : Math.max(0, state.effectiveCap - state.inFlight - state.waiters.length);
    return {
      free,
      blocked: reason,
      paused: reason === 'paused',
      pausedMs: reason === 'paused' ? Math.max(0, state.pausedUntil - at) : 0,
      inFlight: state.inFlight,
      waiting: state.waiters.length,
      cap: state.effectiveCap,
    };
  }

  /** Public numbers per provider touched so far (never a key, a file or a text). */
  function snapshot() {
    const out = {};
    const at = now();
    for (const state of states.values()) {
      prune(state, at);
      out[state.name] = {
        inFlight: state.inFlight,
        waiting: state.waiters.length,
        cap: state.limits.inFlight,
        effectiveCap: state.effectiveCap,
        pausedMs: Math.max(0, state.pausedUntil - at),
        rpm: { limit: state.limits.rpm, used: state.requests.length },
        audioSecondsPerHour: { limit: state.limits.audioSecondsPerHour, used: Math.round(audioUsed(state)) },
        completed: state.completed,
        errors: state.errors,
        rateLimits: state.rateLimits,
      };
    }
    return out;
  }

  function reset() {
    for (const state of states.values()) {
      for (const waiter of state.waiters.splice(0)) { waiter.cleanup(); waiter.reject(abortError()); }
    }
    states.clear();
  }

  return { acquire, noteRateLimited, capacity, snapshot, limits: (provider) => ({ ...stateFor(provider).limits }), reset };
}

let singleton = null;

/** The process-wide governor (process.env limits). */
function getTranscriptionGovernor() {
  if (!singleton) singleton = createTranscriptionGovernor({ env: process.env });
  return singleton;
}

function resetTranscriptionGovernor() {
  if (singleton) singleton.reset();
  singleton = null;
}

module.exports = {
  createTranscriptionGovernor,
  getTranscriptionGovernor,
  resetTranscriptionGovernor,
  limitsFor,
  DEFAULT_LIMITS,
  DEFAULT_PAUSE_MS,
  MAX_PAUSE_MS,
  GROW_INTERVAL_MS,
  SHRINK_COOLDOWN_MS,
};
