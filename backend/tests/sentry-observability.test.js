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
