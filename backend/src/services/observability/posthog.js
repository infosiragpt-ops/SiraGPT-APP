'use strict';

/**
 * posthog — open-source product analytics, feature flags, session
 * replay and A/B testing in one SDK. We use it from the backend for
 * server-authoritative events (the ones a malicious frontend could
 * forge or skip): subscription state changes, payment outcomes,
 * webhook deliveries.
 *
 * Frontend events (chat sent, file uploaded, model selected) live in
 * `lib/analytics.ts` — the two surfaces share a `distinctId` so an
 * event chain like "user clicks upgrade → checkout.session.completed
 * → user keeps chatting on the new plan" is one funnel in PostHog.
 *
 * Disabled by default. Activates only when POSTHOG_API_KEY is set;
 * `POSTHOG_ENABLED=false` lets a staging deploy that shares secrets
 * opt out without touching the key. When disabled, every helper
 * exported here is a safe no-op so call sites don't need to branch.
 *
 * Mirrors `sentry.js` and `langfuse.js` in this directory:
 *   - resolvePostHogConfig(env)
 *   - getPostHogStatus()
 *   - startPostHog()        called from index.js boot before route mounting
 *   - getPostHogClient()    raw SDK handle for callers that need it
 *   - capturePostHogEvent() the convenience helper for the common case
 *   - shutdownPostHog()     awaitable flush, called from SIGTERM
 */

let posthogClient = null;
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

function resolvePostHogConfig(env = process.env) {
  const apiKey = String(env.POSTHOG_API_KEY || env.POSTHOG_PROJECT_API_KEY || '').trim();
  const host = String(env.POSTHOG_HOST || env.POSTHOG_API_HOST || '').trim();
  const configured = Boolean(apiKey);
  const explicitToggle = env.POSTHOG_ENABLED;
  const enabled = explicitToggle === undefined || explicitToggle === ''
    ? configured
    : parseBoolean(explicitToggle, configured);
  return {
    configured,
    enabled: enabled && configured,
    apiKey,
    host: host || 'https://us.i.posthog.com',
    flushAt: Number.parseInt(env.POSTHOG_FLUSH_AT, 10) || 20,
    flushInterval: Number.parseInt(env.POSTHOG_FLUSH_INTERVAL_MS, 10) || 10_000,
    environment: env.POSTHOG_ENVIRONMENT || env.NODE_ENV || 'development',
  };
}

function getPostHogStatus() {
  return { ...runtimeStatus };
}

function getPostHogClient() {
  return posthogClient;
}

function startPostHog(env = process.env) {
  if (runtimeStatus.started) return runtimeStatus;
  const config = resolvePostHogConfig(env);
  runtimeStatus = {
    ...runtimeStatus,
    configured: config.configured,
    enabled: config.enabled,
    started: true,
  };
  if (!config.enabled) {
    runtimeStatus.reason = config.configured
      ? 'disabled_by_env'
      : 'missing_api_key';
    return runtimeStatus;
  }
  try {
    // Lazy require — package is optional until the operator turns
    // it on. Same posture as langfuse.js so a fresh checkout
    // without `npm install` doesn't crash at boot.
    const { PostHog } = require('posthog-node');
    posthogClient = new PostHog(config.apiKey, {
      host: config.host,
      flushAt: config.flushAt,
      flushInterval: config.flushInterval,
    });
    runtimeStatus.reason = 'running';
  } catch (err) {
    runtimeStatus.enabled = false;
    runtimeStatus.reason = `init_failed: ${err && err.message ? err.message : 'unknown'}`;
  }
  return runtimeStatus;
}

/**
 * capturePostHogEvent — record a server-authoritative event.
 *
 * `distinctId` is the user-id (Prisma User.id) when authenticated, or
 * the same anonymous-cookie id the frontend uses. Pass `properties`
 * any context that's useful in funnels — model name, plan, source —
 * but NEVER PII (email, name, ip, payment instrument). PostHog
 * defaults to capturing IP at ingestion; we set `$ip: null` here to
 * keep that off for backend events (the request IP belongs to our
 * server, not the user).
 *
 * Returns true if an event was queued, false otherwise (no-op when
 * disabled). Callers that need delivery confirmation should not rely
 * on this — use the `shutdownPostHog()` flush in tests.
 */
function capturePostHogEvent({ distinctId, event, properties, groups } = {}) {
  if (!posthogClient) return false;
  if (!distinctId || !event) return false;
  try {
    posthogClient.capture({
      distinctId: String(distinctId),
      event: String(event),
      properties: { ...(properties || {}), $ip: null },
      ...(groups ? { groups } : {}),
    });
    return true;
  } catch (_err) {
    // Observability must never break the request path.
    return false;
  }
}

async function shutdownPostHog() {
  if (!posthogClient) return;
  try {
    await posthogClient.shutdown();
  } catch (_err) {
    // best-effort
  }
  posthogClient = null;
  runtimeStatus.started = false;
  runtimeStatus.reason = 'shutdown';
}

module.exports = {
  resolvePostHogConfig,
  getPostHogStatus,
  getPostHogClient,
  startPostHog,
  capturePostHogEvent,
  shutdownPostHog,
};
