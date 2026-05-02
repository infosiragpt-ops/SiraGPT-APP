'use strict';

let sentryClient = null;
let runtimeStatus = {
  enabled: false,
  configured: false,
  started: false,
  reason: 'not_started',
};

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseSampleRate(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function resolveSentryConfig(env = process.env) {
  const dsn = String(env.SENTRY_DSN || '').trim();
  const configured = Boolean(dsn);
  const enabled = parseBoolean(env.SENTRY_ENABLED, configured);
  return {
    configured,
    enabled: enabled && configured,
    dsn,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development',
    release: env.SENTRY_RELEASE || env.npm_package_version || undefined,
    tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
    // Profiling sample rate is APPLIED to traces, so a profile only
    // exists for traces that were already sampled. Setting this > 0
    // without `tracesSampleRate > 0` is a no-op — `@sentry/profiling-
    // node` documents this explicitly. Default 0 keeps the new
    // integration completely silent until an operator opts in.
    profilesSampleRate: parseSampleRate(env.SENTRY_PROFILES_SAMPLE_RATE, 0),
    sendDefaultPii: false,
  };
}

function getSentryStatus() {
  return { ...runtimeStatus };
}

// Try to load the optional `@sentry/profiling-node` integration.
// Returns either a configured integration instance or `null` when
// the package is unavailable (fresh checkout pre-`npm install`) or
// when profiling is disabled. The require is wrapped in try/catch
// so a missing native binary on an exotic platform never crashes
// boot — Sentry continues to work without profiles.
function loadProfilingIntegration(profilesSampleRate) {
  if (!profilesSampleRate || profilesSampleRate <= 0) return null;
  try {
    const { nodeProfilingIntegration } = require('@sentry/profiling-node');
    return nodeProfilingIntegration();
  } catch (_err) {
    return null;
  }
}

function startSentry(env = process.env) {
  const config = resolveSentryConfig(env);
  runtimeStatus = {
    enabled: config.enabled,
    configured: config.configured,
    started: false,
    environment: config.environment,
    release: config.release || null,
    traces_sample_rate: config.tracesSampleRate,
    profiles_sample_rate: config.profilesSampleRate,
    profiling_loaded: false,
    reason: config.configured ? 'disabled' : 'not_configured',
  };

  if (!config.enabled) return getSentryStatus();
  if (sentryClient) {
    runtimeStatus.started = true;
    runtimeStatus.reason = 'already_started';
    return getSentryStatus();
  }

  try {
    sentryClient = require('@sentry/node');
    const profilingIntegration = loadProfilingIntegration(config.profilesSampleRate);
    runtimeStatus.profiling_loaded = Boolean(profilingIntegration);
    sentryClient.init({
      dsn: config.dsn,
      environment: config.environment,
      release: config.release,
      tracesSampleRate: config.tracesSampleRate,
      profilesSampleRate: config.profilesSampleRate,
      // Only attach the integration when profiling is enabled AND
      // the optional package loaded. Sentry's defaults still cover
      // error capture when the integrations array is omitted, so we
      // leave that path untouched.
      ...(profilingIntegration ? { integrations: [profilingIntegration] } : {}),
      sendDefaultPii: false,
      beforeSend(event) {
        if (event?.request) {
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.data;
          delete event.request.query_string;
        }
        return event;
      },
    });
    runtimeStatus.started = true;
    runtimeStatus.reason = 'started';
  } catch (error) {
    runtimeStatus.started = false;
    runtimeStatus.reason = error?.message || 'sentry_init_failed';
  }

  return getSentryStatus();
}

function requestContext(req) {
  if (!req) return undefined;
  return {
    method: req.method,
    path: req.path || req.route?.path || 'unknown',
    request_id: req.requestId || req.id || req.headers?.['x-request-id'] || null,
    trace_id: req.traceId || resTraceId(req) || null,
  };
}

function resTraceId(req) {
  return req?.res?.locals?.traceId || req?.res?.getHeader?.('X-Trace-Id') || null;
}

function captureException(error, context = {}) {
  if (!sentryClient || !runtimeStatus.started) return null;
  return sentryClient.withScope((scope) => {
    if (context.req) {
      scope.setContext('request', requestContext(context.req));
    }
    if (context.tags && typeof context.tags === 'object') {
      for (const [key, value] of Object.entries(context.tags)) {
        scope.setTag(key, String(value));
      }
    }
    return sentryClient.captureException(error);
  });
}

module.exports = {
  captureException,
  getSentryStatus,
  parseBoolean,
  parseSampleRate,
  resolveSentryConfig,
  startSentry,
};
