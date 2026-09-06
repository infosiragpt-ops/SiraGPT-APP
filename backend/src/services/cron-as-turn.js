'use strict';

/**
 * 3H-BE-014 -- Hermes/OpenClaw idea rewritten: cron fires as a FRESH agent turn
 * through the single gateway (startAgent), never a hidden pipeline.
 * 3H2-BE-020 leftover: overlap skip, timeout, abort previous tick, DeepSeek-only.
 * 3H12 leftover: user required fail-closed, per-tick timeout, DLQ on timeout/error,
 * prompt cap (never unscoped generate).
 */

const inFlight = new Map(); // [owner, jobId] -> { sessionKey, startedAt, abort }
const { raceWithSignal } = require('../utils/retry-with-backoff');
const { redactString } = require('../utils/secret-redactor');

const DEFAULT_CRON_TURN_TIMEOUT_MS = 180_000;
const MAX_CRON_PROMPT_CHARS = 8000;
const MAX_CONCURRENT_CRON_TICKS = 8;
const MAX_CRON_JOB_ID_CHARS = 128;
const CRON_DEAD_LETTER_TIMEOUT_MS = 1000;

function stableFailureCode(value, fallback = 'cron_dispatch_failed') {
  return typeof value === 'string'
    && /^(?:E_[A-Z0-9_]{1,48}|[a-z][a-z0-9_]{1,63})$/.test(value)
    && redactString(value) === value
    ? value
    : fallback;
}

async function confirmDeadLetter(operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cron_dead_letter_timeout')), CRON_DEAD_LETTER_TIMEOUT_MS);
  try {
    // No retry: after a timeout, a sink may still commit. The returned false
    // means insertion was not confirmed before the deadline, not disproved.
    const result = await raceWithSignal(Promise.resolve().then(operation), controller.signal);
    return result !== false && result?.ok !== false;
  } finally {
    clearTimeout(timer);
  }
}

function cronTurnTimeoutMs() {
  const n = Number(process.env.SIRAGPT_CRON_TURN_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5_000 ? Math.min(n, 600_000) : DEFAULT_CRON_TURN_TIMEOUT_MS;
}

function assertCronModel(model) {
  const raw = String(model || 'deepseek-v4-flash').trim().toLowerCase();
  if (/openrouter|openai|gemini|anthropic|gpt-4o|claude/.test(raw)) {
    const err = new Error('cron_model_forbidden');
    err.code = 'model_forbidden';
    throw err;
  }
  if (raw.includes('pro')) return 'deepseek-v4-pro';
  return 'deepseek-v4-flash';
}

function cronJobToAgentArgs(job, now = Date.now()) {
  const id = String(job && job.id || 'cron');
  const prompt = String(job && job.prompt || '').trim();
  const surface = job && job.surface === 'code' ? 'code' : 'chat';
  return {
    sessionKey: job && job.sessionKey ? String(job.sessionKey) : `cron-run:${id}:${now}`,
    sessionId: job && job.sessionId || null,
    surface,
    userId: job && job.userId || null,
    message: prompt,
    model: assertCronModel(job && job.model),
    fresh: true,
    allowCronTools: false,
  };
}

function inflightKey(jobId, userId) {
  return JSON.stringify([String(userId || '').trim(), String(jobId || '').trim()]);
}

function shouldSkipOverlappingTick(jobId, now = Date.now(), maxMs = 120_000, userId = null) {
  const prev = inFlight.get(inflightKey(jobId, userId));
  if (!prev) return false;
  return (now - Number(prev.startedAt || 0)) < maxMs;
}

async function pushCronDeadLetter(gatewayOrRunner, sessionKey, reason, extra) {
  try {
    const dlq = gatewayOrRunner && (gatewayOrRunner.pushDeadLetter || gatewayOrRunner.pushSessionDeadLetter);
    if (typeof dlq === 'function') {
      return await confirmDeadLetter(() => dlq.call(gatewayOrRunner, {
        sessionKey: String(sessionKey || ''),
        error: String(reason || 'cron_error'),
        at: Date.now(),
        ...(extra && typeof extra === 'object' ? extra : {}),
      }));
    }
    if (gatewayOrRunner && gatewayOrRunner.sessionDlq && typeof gatewayOrRunner.sessionDlq.push === 'function') {
      return await confirmDeadLetter(() => gatewayOrRunner.sessionDlq.push({
        sessionKey: String(sessionKey || ''),
        error: String(reason || 'cron_error'),
        at: Date.now(),
        ...(extra && typeof extra === 'object' ? extra : {}),
      }));
    }
  } catch (_) { /* DLQ must never throw out of cron */ }
  return false;
}

function inflightSnapshot() {
  // Honest count only — never leak jobId (PII-adjacent).
  return { size: inFlight.size, max: MAX_CONCURRENT_CRON_TICKS };
}

async function dispatchCronJobAsAgentTurn(gatewayOrRunner, job, now = Date.now()) {
  const rawId = String(job && job.id || '');
  if (rawId.length > MAX_CRON_JOB_ID_CHARS) {
    return { ok: false, error: 'cron_job_id_too_long', code: 'cron_job_id_too_long' };
  }
  const id = rawId.trim() || 'cron';
  // 3H12 leftover: never unscoped generate — cron-as-turn requires userId.
  if (!String(job && job.userId || '').trim()) {
    return { ok: false, error: 'cron_user_required', code: 'user_required', jobId: id };
  }
  // 3H14 leftover: per-tick unique claim so two workers cannot double-dispatch the same job window.
  try {
    const { claimTurnIdentityUnique } = require('./chat-turn-idempotency');
    const window = Math.floor(now / 60_000);
    const claimed = claimTurnIdentityUnique(`cron-tick:${id}:${window}`, { now, ttlMs: 60_000 });
    if (!claimed.ok && !(job && job._retried)) {
      return { ok: false, error: 'duplicate_turn', code: 'duplicate_turn', jobId: id };
    }
  } catch (_) { /* unique helper optional */ }
  const args = cronJobToAgentArgs(job, now);
  if (!args.message) {
    return { ok: false, error: 'empty_prompt', code: 'empty_prompt', sessionKey: args.sessionKey, jobId: id };
  }
  // 3H12 leftover prompt cap — oversized ticks fail-closed (no generate).
  if (args.message.length > MAX_CRON_PROMPT_CHARS) {
    return { ok: false, error: 'prompt_too_long', code: 'prompt_too_long', sessionKey: args.sessionKey, jobId: id };
  }
  if (shouldSkipOverlappingTick(id, now, 120_000, args.userId)) {
    return { ok: false, error: 'overlap_skipped', jobId: id };
  }
  if (inFlight.size >= MAX_CONCURRENT_CRON_TICKS) {
    return { ok: false, error: 'cron_busy', code: 'cron_busy', jobId: id };
  }

  const timeoutMs = cronTurnTimeoutMs();
  const abort = { aborted: false, reason: null };
  const key = inflightKey(id, args.userId);
  const activeTick = { sessionKey: args.sessionKey, startedAt: now, abort };
  inFlight.set(key, activeTick);
  try {
    if (gatewayOrRunner && typeof gatewayOrRunner.abortSession === 'function' && job && job.abortPrevious) {
      try { gatewayOrRunner.abortSession(args.sessionKey, 'cron_overlap', args.userId); } catch (_) { /* best-effort */ }
    }

    const runPromise = (async () => {
      if (gatewayOrRunner && typeof gatewayOrRunner.startAgent === 'function') {
        const started = await gatewayOrRunner.startAgent(args);
        if (started?.ok === false) {
          const err = new Error('cron dispatch rejected');
          err.code = stableFailureCode(started.code || started.error);
          throw err;
        }
        return { ok: true, via: 'gateway.startAgent', ...started, sessionKey: args.sessionKey, jobId: id };
      }
      if (gatewayOrRunner && typeof gatewayOrRunner.run === 'function') {
        const result = await gatewayOrRunner.run(args);
        if (result?.ok === false) {
          const err = new Error('cron runner rejected');
          err.code = stableFailureCode(result.code || result.error);
          throw err;
        }
        return { ok: true, via: 'runner.run', sessionKey: args.sessionKey, jobId: id };
      }
      const err = new Error('no_gateway_or_runner');
      err.code = 'cron_dispatch_unavailable';
      throw err;
    })();

    // 3H12 leftover timeout: per-tick Promise.race vs SIRAGPT_CRON_TURN_TIMEOUT_MS.
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.aborted = true;
        abort.reason = 'cron_timeout';
        try {
          if (gatewayOrRunner && typeof gatewayOrRunner.abortSession === 'function') {
            gatewayOrRunner.abortSession(args.sessionKey, 'cron_timeout', args.userId);
          }
        } catch (_) { /* best-effort */ }
        const err = new Error('cron_timeout');
        err.code = 'cron_timeout';
        reject(err);
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });

    try {
      const result = await Promise.race([runPromise, timeoutPromise]);
      return result;
    } catch (err) {
      // The dispatcher has already settled. Waiting for evidence must not
      // let its old deadline abort a later run occupying the same session.
      if (timer) clearTimeout(timer);
      timer = null;
      const code = stableFailureCode(err?.code, 'cron_error');
      const reason = code.includes('timeout') ? 'cron_timeout' : (code || 'cron_error');
      const deadLettered = await pushCronDeadLetter(gatewayOrRunner, args.sessionKey, reason, { jobId: id, userId: args.userId });
      return {
        ok: false,
        error: reason,
        code: reason,
        sessionKey: args.sessionKey,
        jobId: id,
        deadLettered,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    if (inFlight.get(key) === activeTick) inFlight.delete(key);
  }
}

function markCronTickFinished(jobId, userId) {
  if (!String(userId || '').trim()) return { ok: false, code: 'user_required' };
  inFlight.delete(inflightKey(jobId, userId));
  return { ok: true, jobId: String(jobId || '') };
}

module.exports = {
  cronJobToAgentArgs,
  dispatchCronJobAsAgentTurn,
  assertCronModel,
  shouldSkipOverlappingTick,
  cronTurnTimeoutMs,
  markCronTickFinished,
  pushCronDeadLetter,
  MAX_CRON_PROMPT_CHARS,
  MAX_CONCURRENT_CRON_TICKS,
  MAX_CRON_JOB_ID_CHARS,
  CRON_DEAD_LETTER_TIMEOUT_MS,
  DEFAULT_CRON_TURN_TIMEOUT_MS,
  inflightSnapshot,
};
