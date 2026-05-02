const test = require('node:test');
const assert = require('node:assert/strict');

const sentry = require('../src/services/observability/sentry');
const health = require('../src/services/observability/health-check');

test('Sentry backend config is disabled without DSN', () => {
  const config = sentry.resolveSentryConfig({ NODE_ENV: 'test' });

  assert.equal(config.configured, false);
  assert.equal(config.enabled, false);
  assert.equal(config.environment, 'test');
  assert.equal(config.tracesSampleRate, 0);
});

test('Sentry backend config is opt-in and clamps trace sample rate', () => {
  const config = sentry.resolveSentryConfig({
    SENTRY_DSN: 'https://public@example.com/1',
    SENTRY_ENABLED: 'true',
    SENTRY_ENVIRONMENT: 'staging',
    SENTRY_TRACES_SAMPLE_RATE: '2',
  });

  assert.equal(config.configured, true);
  assert.equal(config.enabled, true);
  assert.equal(config.environment, 'staging');
  assert.equal(config.tracesSampleRate, 1);
  assert.equal(config.sendDefaultPii, false);
});

test('Sentry health check is informational and non-critical', () => {
  const report = health.checkSentry({
    configured: true,
    enabled: true,
    started: false,
    reason: 'missing_auth',
    traces_sample_rate: 0.1,
  });

  assert.equal(report.name, 'sentry');
  assert.equal(report.status, 'degraded');
  assert.equal(report.critical, false);
  assert.equal(report.details.traces_sample_rate, 0.1);
});

test('Sentry config exposes profilesSampleRate (default 0, opt-in only)', () => {
  // Profiling sampling is silent by default. An operator turns it on
  // explicitly via SENTRY_PROFILES_SAMPLE_RATE; the default is 0 so
  // an upgrade of `@sentry/node` never accidentally enables profile
  // collection on a live deploy.
  const offByDefault = sentry.resolveSentryConfig({
    SENTRY_DSN: 'https://public@example.com/1',
  });
  assert.equal(offByDefault.profilesSampleRate, 0);

  const opted = sentry.resolveSentryConfig({
    SENTRY_DSN: 'https://public@example.com/1',
    SENTRY_PROFILES_SAMPLE_RATE: '0.25',
  });
  assert.equal(opted.profilesSampleRate, 0.25);

  // Same clamping as tracesSampleRate: anything above 1 means "100%"
  // and we don't want a typo ("10%" → "10") to firehose profiles.
  const clampedHigh = sentry.resolveSentryConfig({
    SENTRY_DSN: 'https://public@example.com/1',
    SENTRY_PROFILES_SAMPLE_RATE: '5',
  });
  assert.equal(clampedHigh.profilesSampleRate, 1);

  const clampedNeg = sentry.resolveSentryConfig({
    SENTRY_DSN: 'https://public@example.com/1',
    SENTRY_PROFILES_SAMPLE_RATE: '-0.5',
  });
  assert.equal(clampedNeg.profilesSampleRate, 0);
});

test('Sentry config falls back to 0 for malformed profilesSampleRate', () => {
  const cfg = sentry.resolveSentryConfig({
    SENTRY_DSN: 'https://public@example.com/1',
    SENTRY_PROFILES_SAMPLE_RATE: 'not-a-number',
  });
  assert.equal(cfg.profilesSampleRate, 0);
});
