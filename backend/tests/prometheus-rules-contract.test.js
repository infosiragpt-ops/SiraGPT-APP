'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const backendPackage = require('../package.json');
const utilityMetrics = require('../src/utils/metrics');
const agentMetrics = require('../src/services/agents/metrics');
const {
  formatMetricsExposition,
} = require('../src/services/observability/metrics-exposition');

const RULES_PATH = path.resolve(__dirname, '../../docs/prometheus-rules.yml');
const RULE_TESTS_PATH = path.resolve(__dirname, '../../docs/prometheus-rules.test.yml');
const SLO_PATH = path.resolve(__dirname, '../../docs/slo.md');
const LEGACY_SLO_PATH = path.resolve(__dirname, '../../siraGPT/docs/slo.md');
const LEGACY_RULES_PATH = path.resolve(__dirname, '../../siraGPT/docs/prometheus-rules.yml');
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const RULE_SOURCE = fs.readFileSync(RULES_PATH, 'utf8');
const SLO_SOURCE = fs.readFileSync(SLO_PATH, 'utf8');
const RULE_DOCUMENT = yaml.load(RULE_SOURCE);
const RATIO_WINDOWS = Object.freeze(['5m', '30m', '1h', '2h', '6h', '1d', '3d']);
const SLI_RATIO_PREFIXES = Object.freeze([
  'siragpt:http_availability:ratio_rate',
  'siragpt:http_latency_good:ratio_rate',
  'siragpt:agent_success:ratio_rate',
]);

const LEGACY_FAMILIES = Object.freeze([
  'http_requests_total',
  'http_request_duration_seconds_bucket',
  'http_request_duration_seconds_count',
  'agent_tasks_total',
  'circuit_breaker_state',
]);
const LEGACY_LABELS = new Set(['breaker', 'code', 'streaming']);
const PROMETHEUS_INTRINSIC_METRICS = new Set(['up']);
const PROMQL_NON_METRIC_TOKENS = new Set([
  'and',
  'avg',
  'bool',
  'bottomk',
  'by',
  'count',
  'count_values',
  'group',
  'group_left',
  'group_right',
  'ignoring',
  'limit_ratio',
  'limitk',
  'max',
  'min',
  'offset',
  'on',
  'or',
  'quantile',
  'stddev',
  'stdvar',
  'sum',
  'topk',
  'unless',
  'without',
]);

function allRules() {
  return (RULE_DOCUMENT?.groups || []).flatMap((group) => group.rules || []);
}

function typeInventory() {
  const exposition = formatMetricsExposition();
  const types = new Map(Array.from(
    exposition.matchAll(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) ([a-z]+)$/gm),
    (match) => [match[1], match[2]],
  ));
  const inventory = new Map();
  const registries = [utilityMetrics.registry, agentMetrics.registry];

  for (const [name, type] of types) {
    const registration = registries
      .map((registry) => registry.get(name))
      .find(Boolean);
    const labels = new Set(registration?.labels || []);
    inventory.set(name, labels);
    if (type === 'histogram') {
      inventory.set(`${name}_bucket`, new Set([...labels, 'le']));
      inventory.set(`${name}_count`, new Set(labels));
      inventory.set(`${name}_sum`, new Set(labels));
    }
  }
  return inventory;
}

function metricReferences(expression) {
  const normalized = String(expression || '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, '')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\[[^\]]*\]/g, '[]');
  const references = new Set();
  const tokenPattern = /[a-zA-Z_:][a-zA-Z0-9_:]*/g;
  for (const match of normalized.matchAll(tokenPattern)) {
    const token = match[0];
    if (PROMQL_NON_METRIC_TOKENS.has(token)) continue;
    const following = normalized.slice(match.index + token.length);
    if (/^\s*\(/.test(following)) continue;
    references.add(token);
  }
  return references;
}

function selectorLabels(expression) {
  const selectors = [];
  const selectorPattern = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{([^}]*)\}/g;
  for (const match of String(expression || '').matchAll(selectorPattern)) {
    const labels = Array.from(
      match[2].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)/g),
      (labelMatch) => labelMatch[1],
    );
    selectors.push({ metric: match[1], labels });
  }
  return selectors;
}

function findAlert(name) {
  return allRules().find((rule) => rule.alert === name);
}

function findRecord(name) {
  return allRules().find((rule) => rule.record === name);
}

function assertRatioSemanticContract(rule, {
  rawMetric,
  selector = '',
  window,
  zeroFill = true,
}) {
  assert.ok(rule, `missing recording rule for ${rawMetric} ${window}`);
  assert.match(rule.expr, new RegExp(`${rawMetric.replaceAll(':', '\\:')}\\{?`));
  if (selector) assert.match(rule.expr, new RegExp(selector));
  assert.match(
    rule.expr,
    new RegExp(`\\[${window.replace('.', '\\.')}\\]`),
    `${rule.record} must use its declared ${window} window`,
  );
  assert.match(
    rule.expr,
    /\/\s*clamp_min\s*\(/,
    `${rule.record} must clamp its denominator`,
  );
  if (zeroFill) {
    assert.match(
      rule.expr,
      /\bor\s+vector\s*\(\s*0\s*\)/,
      `${rule.record} must zero-fill a missing numerator`,
    );
  }
  assert.match(
    rule.expr,
    /\band\s+on\s*\(\s*\)\s*\([\s\S]*>\s*0\s*\)\s*$/,
    `${rule.record} must be absent when its traffic denominator is idle or missing`,
  );
}

test('canonical backend suite registers a syntactically valid Prometheus rule document', () => {
  assert.match(
    backendPackage.scripts.test,
    /tests\/prometheus-rules-contract\.test\.js/,
  );
  assert.ok(RULE_DOCUMENT && typeof RULE_DOCUMENT === 'object');
  assert.ok(Array.isArray(RULE_DOCUMENT.groups));
  assert.ok(RULE_DOCUMENT.groups.length > 0);
  for (const group of RULE_DOCUMENT.groups) {
    assert.equal(typeof group.name, 'string');
    assert.ok(Array.isArray(group.rules));
  }
});

test('SLO documentation contains no stale unimplemented SLO identifiers', () => {
  for (const [file, source] of [
    [SLO_PATH, SLO_SOURCE],
    [RULES_PATH, RULE_SOURCE],
    [LEGACY_SLO_PATH, fs.readFileSync(LEGACY_SLO_PATH, 'utf8')],
    [LEGACY_RULES_PATH, fs.readFileSync(LEGACY_RULES_PATH, 'utf8')],
  ]) {
    assert.doesNotMatch(source, /SLO-API-3|SLO-AGT-2/, `${file} names an unimplemented SLO`);
  }
});

test('committed rule fixture covers idle and missing-series semantics', () => {
  assert.equal(fs.existsSync(RULE_TESTS_PATH), true, 'promtool rule-test fixture must be committed');
  const fixture = yaml.load(fs.readFileSync(RULE_TESTS_PATH, 'utf8'));
  assert.ok(Array.isArray(fixture?.tests) && fixture.tests.length >= 3);
  const names = fixture.tests.map((entry) => String(entry?.name || ''));
  assert.ok(names.some((name) => /idle|no traffic/i.test(name)), names);
  assert.ok(names.some((name) => /missing.*error|zero.fill/i.test(name)), names);
  assert.ok(names.some((name) => /missing.*success|all.*error/i.test(name)), names);
});

test('promtool checks rules and semantic fixture when installed', (t) => {
  const version = spawnSync('promtool', ['--version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') {
    t.skip('promtool is optional; deterministic Node contract remains the CI gate');
    return;
  }
  assert.equal(version.status, 0, version.stderr || version.stdout);
  for (const args of [
    ['check', 'rules', RULES_PATH],
    ['test', 'rules', RULE_TESTS_PATH],
  ]) {
    const result = spawnSync('promtool', args, {
      cwd: path.dirname(RULE_TESTS_PATH),
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `promtool ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
});

test('rules reference only families and labels emitted by the unified exporter', () => {
  const inventory = typeInventory();
  const recordingRules = new Set(allRules().map((rule) => rule.record).filter(Boolean));
  const unknownReferences = new Set();

  for (const legacy of LEGACY_FAMILIES) {
    const escaped = legacy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(
      RULE_SOURCE,
      new RegExp(`(?:^|[^a-zA-Z0-9_:])${escaped}(?![a-zA-Z0-9_:])`),
      `legacy metric family ${legacy} must not appear`,
    );
  }

  for (const rule of allRules()) {
    for (const reference of metricReferences(rule.expr)) {
      if (
        !inventory.has(reference)
        && !recordingRules.has(reference)
        && !PROMETHEUS_INTRINSIC_METRICS.has(reference)
      ) {
        unknownReferences.add(reference);
      }
    }
    for (const selector of selectorLabels(rule.expr)) {
      const knownLabels = inventory.get(selector.metric);
      if (!knownLabels) continue;
      for (const label of selector.labels) {
        assert.ok(
          knownLabels.has(label),
          `${selector.metric} selector uses unregistered label ${label}`,
        );
        assert.equal(
          LEGACY_LABELS.has(label),
          false,
          `${selector.metric} selector uses legacy label ${label}`,
        );
      }
    }
  }

  assert.deepEqual(Array.from(unknownReferences).sort(), []);
});

test('SLO ratios zero-fill missing numerators and suppress idle or missing traffic', () => {
  assert.match(
    RULE_SOURCE,
    /siragpt_http_slo_requests_total\{[^}]*status_class="5xx"[^}]*request_class="standard"/,
  );
  assert.match(
    RULE_SOURCE,
    /siragpt_http_slo_request_duration_seconds_bucket\{[^}]*le="1\.5"[^}]*request_class="standard"/,
  );
  assert.match(RULE_SOURCE, /agent_task_terminal_total\{status="success"\}/);
  assert.doesNotMatch(RULE_SOURCE, /agent_task_invocations_total/);
  assert.match(RULE_SOURCE, /siragpt_circuit_breaker_state/);

  for (const window of RATIO_WINDOWS) {
    assertRatioSemanticContract(
      findRecord(`siragpt:http_availability:ratio_rate${window}`),
      {
        rawMetric: 'siragpt_http_slo_requests_total',
        selector: 'request_class="standard"',
        window,
      },
    );
    assertRatioSemanticContract(
      findRecord(`siragpt:http_latency_good:ratio_rate${window}`),
      {
        rawMetric: 'siragpt_http_slo_request_duration_seconds',
        selector: 'request_class="standard"',
        window,
      },
    );
    assertRatioSemanticContract(
      findRecord(`siragpt:agent_success:ratio_rate${window}`),
      {
        rawMetric: 'agent_task_terminal_total',
        window,
      },
    );
  }

  assert.deepEqual(
    SLI_RATIO_PREFIXES.flatMap((prefix) => RATIO_WINDOWS.map((window) => `${prefix}${window}`))
      .filter((record) => !findRecord(record)),
    [],
  );
});

test('dedicated HTTP SLO metrics have fixed tiny domains and are recorded beside detail', () => {
  const detailedRequests = utilityMetrics.registry.get('siragpt_http_requests_total');
  const detailedDuration = utilityMetrics.registry.get('siragpt_http_request_duration_seconds');
  const sloRequests = utilityMetrics.registry.get('siragpt_http_slo_requests_total');
  const sloDuration = utilityMetrics.registry.get('siragpt_http_slo_request_duration_seconds');

  assert.deepEqual(detailedRequests.labels, ['method', 'route', 'status', 'request_class']);
  assert.deepEqual(detailedDuration.labels, ['method', 'route', 'request_class']);
  assert.ok(sloRequests, 'dedicated SLO request counter must be registered');
  assert.ok(sloDuration, 'dedicated SLO duration histogram must be registered');
  assert.deepEqual(sloRequests.labels, ['request_class', 'status_class']);
  assert.deepEqual(sloDuration.labels, ['request_class']);
  assert.equal(sloRequests.maxSeries, 19);
  assert.equal(sloDuration.maxSeries, 4);

  assert.match(INDEX_SOURCE, /const requestClass = classifyRequestClass\(req, res\)/);
  assert.match(INDEX_SOURCE, /const statusClass = classifyStatusClass\(res\.statusCode\)/);
  assert.match(
    INDEX_SOURCE,
    /counter\('siragpt_http_slo_requests_total',[\s\S]*?request_class:\s*requestClass,[\s\S]*?status_class:\s*statusClass/,
  );
  assert.match(
    INDEX_SOURCE,
    /observe\('siragpt_http_slo_request_duration_seconds',[\s\S]*?request_class:\s*requestClass/,
  );
  assert.ok(
    sloDuration.buckets.includes(1.5),
    'the 1.5s SLO boundary must be an emitted histogram bucket',
  );
  assert.ok(sloDuration.buckets.includes(3), 'the 3s diagnostic boundary must be exact');
});

test('multi-window alerts use the documented 6h+30m and 24h+2h policies with traffic gates', () => {
  for (const prefix of ['HTTPAvailability', 'HTTPLatency', 'AgentSuccess']) {
    const slow = findAlert(`SiraGPT${prefix}SlowBurn`);
    const ticket = findAlert(`SiraGPT${prefix}Ticket`);
    assert.ok(slow, `missing ${prefix} slow-burn alert`);
    assert.ok(ticket, `missing ${prefix} ticket alert`);
    assert.match(slow.expr, /ratio_rate6h/);
    assert.match(slow.expr, /ratio_rate30m/);
    assert.doesNotMatch(slow.expr, /ratio_rate1h/);
    assert.match(ticket.expr, /ratio_rate1d/);
    assert.match(ticket.expr, /ratio_rate2h/);
    for (const alert of [slow, ticket]) {
      assert.match(
        alert.expr,
        /\band\s+on\s*\(\s*\)[\s\S]*>\s*0/,
        `${alert.alert} must explicitly require positive traffic`,
      );
    }
  }
});

test('scrape absence and health-excluded business traffic have separate alerts', () => {
  assert.equal(findAlert('SiraGPTNoTraffic'), undefined);
  const scrape = findAlert('SiraGPTMetricsScrapeMissing');
  const business = findAlert('SiraGPTBusinessTrafficMissing');
  assert.ok(scrape);
  assert.match(
    scrape.expr,
    /\(\s*up\{[^}]*job=~"siragpt-backend\.\*"[^}]*\}\s*==\s*0\s*\)/,
    'scrape alert must detect a currently down target',
  );
  assert.match(
    scrape.expr,
    /absent\s*\(\s*up\{[^}]*job=~"siragpt-backend\.\*"[^}]*\}\s*\)/,
    'scrape alert must detect an absent target',
  );
  assert.doesNotMatch(scrape.expr, /_over_time/);
  assert.equal(scrape.for, '5m');
  assert.ok(business);
  assert.match(business.expr, /siragpt_http_slo_requests_total/);
  assert.match(business.expr, /request_class=~"standard\|streaming"/);
  assert.match(business.expr, /\bor\s+vector\s*\(\s*0\s*\)/);
  assert.match(
    business.expr,
    /and\s+on\s*\(\s*\)\s*\(\s*max\s*\(\s*up\{[^}]*job=~"siragpt-backend\.\*"[^}]*\}\s*\)\s*==\s*1\s*\)/,
    'business no-traffic warning must require at least one healthy scrape',
  );
  assert.equal(business.labels.severity, 'warning');
});

test('queue probe metrics are low-cardinality unified-exporter gauges', () => {
  const inventory = typeInventory();

  assert.deepEqual(
    Array.from(inventory.get('siragpt_queue_jobs') || []),
    ['queue', 'state'],
  );
  assert.deepEqual(
    Array.from(inventory.get('siragpt_queue_probe_up') || []),
    ['queue'],
  );
  assert.deepEqual(
    Array.from(inventory.get('siragpt_queue_probe_status') || []),
    ['status'],
  );
  assert.deepEqual(
    Array.from(inventory.get('siragpt_queue_probe_last_success_timestamp_seconds') || []),
    ['queue'],
  );
  assert.deepEqual(
    Array.from(inventory.get('siragpt_queue_probe_staleness_seconds') || []),
    ['queue'],
  );
});

test('queue backlog and failure alerts retain documented actionable thresholds', () => {
  const backlog = findAlert('SiraGPTQueueWaitingBacklogHigh');
  const paused = findAlert('SiraGPTQueuePausedBacklog');
  const failures = findAlert('SiraGPTQueueFailedJobsRetained');
  const probeDown = findAlert('SiraGPTQueueProbeDown');
  const partialProbe = findAlert('SiraGPTQueueProbePartialFailure');
  const slo = fs.readFileSync(SLO_PATH, 'utf8');

  assert.ok(backlog, 'missing queue backlog alert');
  assert.match(
    backlog.expr,
    /max by \(queue\) \([\s\S]*siragpt_queue_jobs\{state="waiting"\}[\s\S]*\) > 100/,
  );
  assert.equal(backlog.for, '10m');

  assert.ok(paused, 'missing paused queue backlog alert');
  assert.match(
    paused.expr,
    /max by \(queue\) \([\s\S]*siragpt_queue_jobs\{state="paused"\}[\s\S]*\) > 0/,
  );
  assert.equal(paused.labels.severity, 'warning');

  assert.ok(failures, 'missing queue failure alert');
  assert.match(
    failures.expr,
    /max by \(queue\) \([\s\S]*siragpt_queue_jobs\{state="failed"\}[\s\S]*\) > 10/,
  );
  assert.equal(failures.for, '15m');

  assert.ok(probeDown, 'missing queue probe-down alert');
  assert.match(
    probeDown.expr,
    /max by \(queue\) \(siragpt_queue_probe_up\) == 0/,
  );
  assert.equal(probeDown.for, '5m');
  assert.equal(probeDown.labels.severity, 'page');

  assert.ok(partialProbe, 'missing partial queue observer alert');
  assert.match(partialProbe.expr, /min by \(queue\) \(siragpt_queue_probe_up\) == 0/);
  assert.match(partialProbe.expr, /max by \(queue\) \(siragpt_queue_probe_up\) == 1/);
  assert.equal(partialProbe.labels.severity, 'warning');

  for (const alert of [backlog, paused, failures]) {
    assert.match(
      alert.expr,
      /and on\s*\(\s*queue\s*,\s*instance\s*\)\s*\(\s*siragpt_queue_probe_up\s*==\s*1\s*\)/,
      `${alert.alert} must use only a successful observer's queue sample`,
    );
    assert.match(
      alert.expr,
      /and on\s*\(\s*queue\s*,\s*instance\s*\)\s*\(\s*siragpt_queue_probe_staleness_seconds\s*<=\s*120\s*\)/,
      `${alert.alert} must ignore queue samples whose last success is stale`,
    );
  }

  assert.match(slo, /waiting[^|\n]*> 100[^|\n]*10 m/i);
  assert.match(slo, /failed[^|\n]*> 10[^|\n]*15 m/i);
});
