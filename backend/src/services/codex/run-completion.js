'use strict';

const metrics = require('../../utils/metrics');

const TERMINAL_COUNTER = 'siragpt_codex_runs_terminal_total';
const EVENT_BY_STATUS = Object.freeze({
  done: 'codex.run.completed',
  error: 'codex.run.failed',
  cancelled: 'codex.run.cancelled',
});

metrics.registerCounter(TERMINAL_COUNTER, {
  help: 'Terminal Codex runs by final status',
  labels: ['status'],
  maxSeries: 8,
});

const MODEL_TERMINAL_COUNTER = 'siragpt_codex_runs_terminal_by_model_total';

// Per-model canary gate (CEO Office decision): terminal outcomes segmented by
// model bucket, so flash-vs-sonnet success rates are comparable pre/post flip.
metrics.registerCounter(MODEL_TERMINAL_COUNTER, {
  help: 'Terminal Codex runs by final status and model bucket',
  labels: ['model', 'status'],
  maxSeries: 32,
});

function modelBucket(value) {
  try {
    return require('./model-telemetry').modelToken(value);
  } catch {
    return 'unknown';
  }
}

function redactError(value) {
  return String(value || '')
    .replace(/\b(?:sk|pk|key)-[a-zA-Z0-9_-]{16,}\b/g, '[secret]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [secret]')
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*\S+/gi, '$1=[secret]')
    .trim()
    .slice(0, 600);
}

function completionPayload(run, status, error = null) {
  return {
    schemaVersion: 1,
    runId: run?.id || null,
    projectId: run?.projectId || null,
    status,
    mode: run?.mode || null,
    model: run?.model || null,
    tier: run?.tier || null,
    // Inbox/push copy (flota/chat-pwa-notificaciones): the user closing the
    // tab sees only this payload, so carry a short prompt excerpt with it.
    prompt: String(run?.prompt || '').slice(0, 120) || null,
    error: status === 'error' ? redactError(error || run?.error) || null : null,
  };
}

async function publishRunCompletion({
  run,
  status,
  error = null,
  triggers = null,
  env = process.env,
}) {
  const event = EVENT_BY_STATUS[status];
  if (!event || !run?.id) return { published: false, reason: 'not_terminal' };
  try { metrics.counter(TERMINAL_COUNTER, { status }, 1); } catch { /* no-op */ }
  try {
    metrics.counter(MODEL_TERMINAL_COUNTER, { model: modelBucket(run?.model), status }, 1);
  } catch { /* no-op */ }
  if (String(env?.CODEX_COMPLETION_WEBHOOKS ?? '1').trim() === '0') {
    return { published: false, reason: 'disabled' };
  }
  if (!triggers && !env?.DATABASE_URL && env?.NODE_ENV !== 'production') {
    return { published: false, reason: 'store_unconfigured' };
  }
  try {
    const registry = triggers || require('../trigger-registry');
    const result = await registry.publish(
      event,
      completionPayload(run, status, error),
      run.userId || null,
      { idempotencyTtlMs: 24 * 60 * 60_000 },
    );
    return { published: true, event, result };
  } catch (publishError) {
    if (env?.NODE_ENV !== 'test') {
      console.warn('[codex completion] webhook publish failed:', publishError?.message || publishError);
    }
    return {
      published: false,
      event,
      reason: 'publish_failed',
      error: String(publishError?.message || publishError).slice(0, 500),
    };
  }
}

module.exports = {
  TERMINAL_COUNTER,
  MODEL_TERMINAL_COUNTER,
  EVENT_BY_STATUS,
  redactError,
  completionPayload,
  publishRunCompletion,
};
