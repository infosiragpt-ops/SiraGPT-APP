'use strict';

/**
 * Unified task error classification for agent workers, graphs, and retries.
 * Single source of truth — agent-task-runner re-exports this module.
 */

function withJitter(baseMs) {
  if (!baseMs || baseMs <= 0) return baseMs;
  const spread = baseMs * 0.2;
  return Math.max(100, Math.round(baseMs + (Math.random() * 2 - 1) * spread));
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

const NON_RETRYABLE_RULES = [
  {
    reason: 'aborted',
    patterns: [
      'aborted', 'aborterror', 'abort_err', 'cancelled', 'canceled', 'err_canceled',
      'operation was canceled', 'context canceled', 'context deadline exceeded',
      'client closed request', 'user interrupted', 'shutdown in progress',
    ],
  },
  {
    reason: 'context-length',
    patterns: [
      'context_length_exceeded', 'context length', 'context window', 'maximum context',
      'prompt is too long', 'too many tokens', 'token limit exceeded', 'input token limit',
      'output token limit', 'token budget exceeded', 'maximum prompt length',
      'reduce the length',
    ],
  },
  {
    reason: 'content-policy',
    patterns: [
      'content_policy', 'content policy', 'policy_violation', 'safety filter',
      'safety system', 'flagged by', 'moderation', 'terms of service',
      'responsible ai policy', 'unsafe content', 'guardrail intervention',
      'jailbreak detected', 'disallowed content',
    ],
  },
  {
    reason: 'auth-failure',
    codes: ['401', '403'],
    patterns: [
      'api_key', 'api key', 'authentication', 'permission denied', 'forbidden',
      'unauthorized', 'unauthorized_client', 'invalid bearer token', 'expired token',
      'missing authorization header', 'does not have access', 'not entitled',
    ],
  },
  {
    reason: 'validation-error',
    patterns: [
      'missing required', 'required field', 'invalid json', 'schema validation failed',
      'malformed request body', 'unsupported file type', 'invalid enum',
      'request body must be an object', 'zod validation', 'not configured',
      'invalid webhook signature',
    ],
  },
  {
    reason: 'model-unavailable',
    patterns: [
      'model_not_found', 'model not found', 'does not exist', 'deployment not found',
      'deprecated model', 'decommissioned', 'has been retired', 'no such model',
      'engine not found', 'model is not enabled', 'unknown model alias',
      'model temporarily disabled',
    ],
  },
  {
    reason: 'payload-too-large',
    codes: ['413'],
    patterns: [
      'payload too large', 'request entity too large', 'content too large',
      'body exceeded', 'max upload size exceeded', 'file size exceeds',
      'response too large', 'artifact exceeds max bytes', 'image is too large',
      'multipart body exceeded',
    ],
  },
  {
    reason: 'quota-exhausted',
    codes: ['402'],
    patterns: [
      'insufficient_quota', 'insufficient quota', 'quota exceeded', 'billing',
      'payment required', 'monthly usage limit', 'credits exhausted',
      'no available credits', 'subscription inactive', 'free tier limit', 'spend cap exceeded',
    ],
  },
  {
    reason: 'not-implemented',
    codes: ['501'],
    patterns: ['not implemented'],
  },
];

const RETRYABLE_RULES = [
  {
    reason: 'rate-limited',
    ttlMs: 15_000,
    codes: ['429'],
    patterns: [
      'rate limit', 'rate_limit', 'too many requests', 'resource exhausted',
      'rpm limit', 'tpm limit', 'concurrency limit', 'throttled', 'slow down',
      'burst limit', 'server busy, retry after',
    ],
  },
  {
    reason: 'dns-failure',
    ttlMs: 5_000,
    patterns: ['enotfound', 'eai_again', 'getaddrinfo', 'dns_probe_finished_nxdomain'],
  },
  {
    reason: 'network-timeout',
    ttlMs: 5_000,
    codes: ['408', '504'],
    patterns: [
      'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused',
      'econnaborted', 'epipe', 'hang up', 'socket', 'gateway timeout',
    ],
  },
  {
    reason: 'ssl-error',
    ttlMs: 8_000,
    patterns: [
      'cert_has_expired', 'unable to verify', 'self signed certificate',
      'self-signed certificate', 'depth_zero_self_signed', 'ssl handshake',
      'tls handshake', 'handshake failure',
    ],
  },
  {
    reason: 'server-error',
    ttlMs: 10_000,
    codePrefix: '5',
    // 'overloaded'/'overloaded_error' = provider capacity pressure (e.g.
    // Anthropic HTTP 529) — transient, should be retried. Previously bare
    // 'overloaded' fell through to 'unknown' (non-retryable).
    patterns: ['internal server', 'service unavailable', 'bad gateway', 'upstream 503', '502 bad gateway', 'overloaded', 'overloaded_error', 'server is overloaded'],
  },
];

function matchesByCode(rule, code) {
  if (!code) return false;
  if (rule.codePrefix && code.startsWith(rule.codePrefix)) return true;
  if (rule.codes && rule.codes.some((c) => code === c || code.startsWith(c))) return true;
  return false;
}

function matchesByMessage(rule, combined) {
  return includesAny(combined, rule.patterns || []);
}

function matchesRule(rule, msg, code, errName) {
  return matchesByCode(rule, code) || matchesByMessage(rule, `${errName} ${code} ${msg}`);
}

function classifyTaskError(err) {
  if (!err) return { retryable: false, reason: 'no-error' };
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || err.statusCode || '').toLowerCase();
  const errName = String(err.name || '').toLowerCase();

  // Rate/concurrency pressure wins over generic quota words like "burst quota".
  const rateRule = RETRYABLE_RULES[0];
  if (matchesRule(rateRule, msg, code, errName)) {
    return { retryable: true, reason: rateRule.reason, ttlMs: withJitter(rateRule.ttlMs) };
  }

  // ECONNABORTED is an HTTP client timeout code, not a user cancellation.
  if (code.includes('econnaborted') || msg.includes('econnaborted')) {
    return { retryable: true, reason: 'network-timeout', ttlMs: withJitter(5_000) };
  }

  const combined = `${errName} ${code} ${msg}`;

  // Structured HTTP status is authoritative — classify by status code BEFORE any
  // soft message-keyword rule. This keeps a transient 5xx retryable even when its
  // body happens to contain "invalid"/"unauthorized" (previously such errors hit
  // the NON_RETRYABLE auth/validation message rules and were given up on), while
  // genuinely permanent statuses (401/403 auth, 402 quota, 413 payload, 501
  // not-implemented) are still caught by their NON_RETRYABLE code rules, and 504
  // keeps its more specific 'network-timeout' reason.
  for (const rule of NON_RETRYABLE_RULES) {
    if (matchesByCode(rule, code)) return { retryable: false, reason: rule.reason };
  }
  for (const rule of RETRYABLE_RULES) {
    if (matchesByCode(rule, code)) return { retryable: true, reason: rule.reason, ttlMs: withJitter(rule.ttlMs) };
  }

  // No usable status code — fall back to message-keyword matching.
  for (const rule of NON_RETRYABLE_RULES) {
    if (matchesByMessage(rule, combined)) return { retryable: false, reason: rule.reason };
  }
  for (const rule of RETRYABLE_RULES.slice(1)) {
    if (matchesByMessage(rule, combined)) return { retryable: true, reason: rule.reason, ttlMs: withJitter(rule.ttlMs) };
  }

  if (msg.includes('missing') || msg.includes('invalid') || msg.includes('required')) {
    return { retryable: false, reason: 'validation-error' };
  }

  // Unknown errors: do not retry by default (prevents retry storms).
  return { retryable: false, reason: 'unknown', ttlMs: 0 };
}

module.exports = {
  classifyTaskError,
  withJitter,
};
