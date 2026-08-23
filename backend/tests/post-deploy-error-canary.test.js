'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const canary = require('../scripts/post-deploy-error-canary');

const CONFIG = canary.resolveConfig({
  CANARY_MIN_REQUESTS: '10',
  CANARY_POLL_INTERVAL_SECONDS: '1',
  CANARY_TIMEOUT_SECONDS: '5',
});

test('resolveConfig applies documented defaults', () => {
  const config = canary.resolveConfig({});
  assert.equal(config.promUrl, 'http://prometheus:9090');
  assert.equal(config.baselineMinutes, 60);
  assert.equal(config.recentMinutes, 10);
  assert.equal(config.errorRatioMax, 0.05);
  assert.equal(config.ratioMultiplier, 3);
  assert.equal(config.minAbsDelta, 0.01);
  assert.equal(config.minRequests, 20);
  assert.equal(config.pollIntervalSeconds, 30);
  assert.equal(config.timeoutSeconds, 600);
});

test('resolveConfig rejects non-numeric values and clamps recent below baseline', () => {
  const config = canary.resolveConfig({
    CANARY_BASELINE_MINUTES: 'not-a-number',
    CANARY_RECENT_MINUTES: '120',
    CANARY_ERROR_RATIO_MAX: '-1',
  });
  assert.equal(config.baselineMinutes, 60);
  assert.ok(config.recentMinutes < config.baselineMinutes);
  assert.equal(config.errorRatioMax, 0.05);
});

test('buildQueries targets standard-class SLO counters with offset baseline', () => {
  const queries = canary.buildQueries(canary.resolveConfig({}));
  assert.match(queries.baselineTotal, /siragpt_http_slo_requests_total\{request_class="standard"\}\[60m\] offset 10m/);
  assert.match(queries.baselineErrors, /status_class="5xx"/);
  assert.match(queries.baselineErrors, /offset 10m/);
  assert.match(queries.recentTotal, /sum\(increase\(siragpt_http_slo_requests_total\{request_class="standard"\}\[10m\]\)\)/);
  assert.match(queries.recentErrors, /status_class="5xx"/);
  assert.doesNotMatch(queries.recentTotal, /offset/);
  assert.doesNotMatch(queries.recentErrors, /offset/);
});

test('evaluateGates waits when recent traffic is below the minimum sample floor', () => {
  const observationFor = (recentTotal, recentErrors, baselineTotal, baselineErrors) => ({
    recentTotal,
    recentErrors,
    baselineTotal,
    baselineErrors,
  });
  const verdict = canary.evaluateGates(observationFor(5, 5, 1000, 0), CONFIG);
  assert.equal(verdict.decision, 'wait');
  assert.equal(verdict.reason, 'insufficient_recent_traffic');
});

test('evaluateGates rolls back on the absolute gate alone', () => {
  const verdict = canary.evaluateGates({
    recentTotal: 100,
    recentErrors: 10,
    baselineTotal: 1000,
    baselineErrors: 10,
  }, CONFIG);
  assert.equal(verdict.decision, 'rollback');
  assert.equal(verdict.gate, 'absolute');
  assert.equal(verdict.recentRatio, 0.1);
});

test('evaluateGates passes healthy traffic even without a usable baseline', () => {
  const verdict = canary.evaluateGates({
    recentTotal: 100,
    recentErrors: 0,
    baselineTotal: 0,
    baselineErrors: 0,
  }, CONFIG);
  assert.equal(verdict.decision, 'pass');
  assert.equal(verdict.reason, 'healthy_without_usable_baseline');
});

test('evaluateGates rolls back when the relative gate trips against a healthy baseline', () => {
  const verdict = canary.evaluateGates({
    recentTotal: 100,
    recentErrors: 4,
    baselineTotal: 1000,
    baselineErrors: 1,
  }, CONFIG);
  assert.equal(verdict.decision, 'rollback');
  assert.equal(verdict.gate, 'relative');
  assert.equal(verdict.baselineRatio, 0.001);
});

test('evaluateGates passes when recent ratio stays within baseline tolerance', () => {
  const verdict = canary.evaluateGates({
    recentTotal: 1000,
    recentErrors: 3,
    baselineTotal: 1000,
    baselineErrors: 1,
  }, CONFIG);
  assert.equal(verdict.decision, 'pass');
  assert.equal(verdict.reason, 'healthy');
});

test('evaluateGates never rolls back on zero recent errors regardless of baseline', () => {
  const verdict = canary.evaluateGates({
    recentTotal: 1000,
    recentErrors: 0,
    baselineTotal: 10,
    baselineErrors: 0,
  }, CONFIG);
  assert.equal(verdict.decision, 'pass');
});

test('runCanary returns rollback immediately on a gate breach', async () => {
  const sleeps = [];
  const result = await canary.runCanary(CONFIG, {
    queryFn: async (query) => (query.includes('status_class="5xx"') && !query.includes('offset') ? 10 : 100),
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 0,
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'rollback');
  assert.equal(result.verdict.gate, 'absolute');
  assert.equal(sleeps.length, 0);
});

test('runCanary polls through wait verdicts and passes when traffic recovers', async () => {
  let observeRound = 0;
  const sleeps = [];
  // Mock one Prometheus series value per query: baseline window is healthy
  // (1000 total / 0 errors); round 1 has too little recent traffic to judge,
  // round 2 has healthy recent traffic (100 total / 0 errors).
  const result = await canary.runCanary(CONFIG, {
    queryFn: async (query) => {
      const isErrorQuery = query.includes('status_class="5xx"');
      const isBaseline = query.includes('offset');
      if (isBaseline) return isErrorQuery ? 0 : 1000;
      if (observeRound === 0 && !isErrorQuery) return 5;
      return isErrorQuery ? 0 : 100;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      observeRound += 1;
    },
    now: () => 0,
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'pass');
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], CONFIG.pollIntervalSeconds * 1000);
});

test('runCanary fails closed as unobservable when Prometheus never answers', async () => {
  const sleeps = [];
  const result = await canary.runCanary({ ...CONFIG, timeoutSeconds: 2 }, {
    queryFn: async () => { throw new Error('prometheus_query_timeout'); },
    sleep: async (ms) => { sleeps.push(ms); },
    now: (() => { let t = 0; return () => (t += 1000); })(),
    log: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'unobservable');
  assert.match(result.error, /prometheus_query_timeout/);
  assert.ok(sleeps.length >= 1);
});

test('runCanary passes on timeout when the only reason was insufficient traffic', async () => {
  let t = 0;
  const result = await canary.runCanary({ ...CONFIG, timeoutSeconds: 2 }, {
    queryFn: async () => 1,
    sleep: async () => {},
    now: () => (t += 1500),
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'pass');
  assert.equal(result.reason, 'timeout_with_insufficient_traffic');
});

test('deploy workflow wires the canary after the version check inside the rollback window', () => {
  const deployYml = fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/deploy.yml'),
    'utf8',
  );
  assert.match(deployYml, /post-deploy-error-canary\.js/);
  const canaryIndex = deployYml.indexOf('post-deploy-error-canary.js');
  const versionCheckIndex = deployYml.indexOf('Deploy version check passed');
  const cleanupIndex = deployYml.lastIndexOf('cleanup_old_rollback_images');
  assert.ok(canaryIndex > versionCheckIndex, 'canary must run after the version check');
  assert.ok(canaryIndex < cleanupIndex, 'canary must run before rollback images are cleaned');
});

test('production Prometheus loads the SLO rules file the canary queries through', () => {
  const prometheusYml = fs.readFileSync(
    path.resolve(__dirname, '../../deploy/prometheus/prometheus.yml'),
    'utf8',
  );
  assert.match(prometheusYml, /rule_files/);
  assert.match(prometheusYml, /\/etc\/prometheus\/siragpt-rules\.yml/);
});
