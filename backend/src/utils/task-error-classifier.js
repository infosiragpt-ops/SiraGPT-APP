'use strict';

/**
 * Unified task error classification for agent workers, graphs, and retries.
 * Single source of truth — agent-task-runner re-exports this module.
 */

function withJitter(baseMs, jitterRatio = 0.25) {
  const base = Math.max(0, Number(baseMs) || 0);
  const jitter = base * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(base + jitter));
}

function classifyTaskError(err) {
  if (!err) return { retryable: false, reason: 'no-error' };
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || err.statusCode || '').toLowerCase();
  const errName = String(err.name || '').toLowerCase();

  if (errName === 'aborterror' || msg.includes('aborted') || msg.includes('operation was canceled') || code === 'abort_err') {
    return { retryable: false, reason: 'aborted' };
  }
  if (msg.includes('insufficient_quota') || msg.includes('insufficient quota') ||
      msg.includes('quota exceeded') || msg.includes('billing') ||
      msg.includes('payment required') || code === '402') {
    return { retryable: false, reason: 'quota-exhausted' };
  }
  if (msg.includes('context_length_exceeded') || msg.includes('context length') ||
      msg.includes('maximum context') || msg.includes('too many tokens') ||
      msg.includes('reduce the length')) {
    return { retryable: false, reason: 'context-length' };
  }
  if (msg.includes('content_policy') || msg.includes('content policy') ||
      msg.includes('safety filter') || msg.includes('flagged by') ||
      msg.includes('moderation')) {
    return { retryable: false, reason: 'content-policy' };
  }
  if (msg.includes('api_key') || msg.includes('api key') || msg.includes('authentication') ||
      msg.includes('unauthorized') || code === '401' || code === '403') {
    return { retryable: false, reason: 'auth-failure' };
  }
  if (msg.includes('missing') && (msg.includes('taskid') || msg.includes('required'))) {
    return { retryable: false, reason: 'validation-error' };
  }
  if (msg.includes('model_not_found') || msg.includes('does not exist') ||
      msg.includes('deprecated model') || msg.includes('decommissioned') ||
      msg.includes('has been retired') || msg.includes('no such model')) {
    return { retryable: false, reason: 'model-unavailable' };
  }
  if (msg.includes('payload too large') || msg.includes('request entity too large') || code === '413') {
    return { retryable: false, reason: 'payload-too-large' };
  }
  if (code === '501' || msg.includes('not implemented')) {
    return { retryable: false, reason: 'not-implemented' };
  }
  if (code.includes('rate_limit') || msg.includes('rate limit') || msg.includes('rate_limit') ||
      msg.includes('too many requests') || code.startsWith('429')) {
    return { retryable: true, reason: 'rate-limited', ttlMs: withJitter(15_000) };
  }
  if (msg.includes('enotfound') || msg.includes('eai_again') || msg.includes('getaddrinfo')) {
    return { retryable: true, reason: 'dns-failure', ttlMs: withJitter(5_000) };
  }
  if (code.includes('timeout') || msg.includes('timeout') || msg.includes('etimedout') ||
      msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('econnaborted') ||
      msg.includes('epipe') || msg.includes('hang up') || msg.includes('socket') ||
      code === '408' || code === '504' || code.startsWith('408') || code.startsWith('504')) {
    return { retryable: true, reason: 'network-timeout', ttlMs: withJitter(5_000) };
  }
  if (msg.includes('cert_has_expired') || msg.includes('unable to verify') ||
      msg.includes('self signed certificate') || msg.includes('self-signed certificate') ||
      msg.includes('depth_zero_self_signed') || msg.includes('ssl handshake') ||
      msg.includes('tls handshake') || msg.includes('handshake failure')) {
    return { retryable: true, reason: 'ssl-error', ttlMs: withJitter(8_000) };
  }
  if (code.startsWith('5') || msg.includes('internal server') ||
      msg.includes('service unavailable') || msg.includes('bad gateway')) {
    return { retryable: true, reason: 'server-error', ttlMs: withJitter(10_000) };
  }
  if (msg.includes('missing') || msg.includes('invalid') || msg.includes('required') ||
      msg.includes('not configured')) {
    return { retryable: false, reason: 'validation-error' };
  }

  // Unknown errors: do not retry by default (prevents retry storms).
  return { retryable: false, reason: 'unknown', ttlMs: 0 };
}

module.exports = {
  classifyTaskError,
  withJitter,
};
