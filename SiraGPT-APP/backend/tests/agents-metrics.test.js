/**
 * Tests for services/agents/metrics.js — Prometheus text-format
 * exporter for in-process counters/gauges/histograms.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  counter,
  gauge,
  observe,
  renderText,
  recordAgentRun,
  _reset,
  registerCounter,
  registerHistogram,
  registerGauge,
  registry,
} = require('../src/services/agents/metrics');

beforeEach(() => {
  _reset();
});

// ── pre-registered metrics ─────────────────────────────────────

describe('pre-registered metrics', () => {
  it('includes core SE agent counters', () => {
    for (const name of [
      'se_agent_invocations_total',
      'se_agent_errors_total',
      'se_agent_tokens_total',
      'se_agent_tool_calls_total',
      'se_agent_tool_cache_hits_total',
      'se_agent_rate_limited_total',
      'se_agent_injection_signals_total',
    ]) {
      const m = registry.get(name);
      assert.ok(m, `${name} not registered`);
      assert.equal(m.type, 'counter');
    }
  });

  it('includes the SE agent duration histogram', () => {
    const m = registry.get('se_agent_duration_ms');
    assert.equal(m.type, 'histogram');
    assert.ok(Array.isArray(m.buckets));
  });

  it('includes the RAG chunks gauge', () => {
    const m = registry.get('se_agent_rag_chunks');
    assert.equal(m.type, 'gauge');
  });

  it('includes long-running chat agent metrics', () => {
    assert.equal(registry.get('agent_task_invocations_total').type, 'counter');
    assert.equal(registry.get('agent_task_events_total').type, 'counter');
    assert.equal(registry.get('agent_task_cancellations_total').type, 'counter');
    assert.equal(registry.get('agent_task_artifacts_total').type, 'counter');
    assert.equal(registry.get('agent_task_duration_ms').type, 'histogram');
  });
});

describe('registration schema', () => {
  it('is idempotent for an identical counter schema without clearing samples', () => {
    const name = 'test_agent_identical_counter_registration';
    const schema = { help: 'identical schema', labels: ['agent'], maxSeries: 3 };
    registerCounter(name, schema);
    counter(name, { agent: 'planner' }, 2);

    registerCounter(name, { ...schema, labels: [...schema.labels] });

    const metric = registry.get(name);
    assert.equal(metric.series.get('agent=planner'), 2);
    assert.equal(metric.series.size, 1);
  });

  it('is idempotent for an identical histogram schema without clearing samples', () => {
    const name = 'test_agent_identical_histogram_registration';
    const schema = {
      help: 'identical histogram',
      labels: ['agent'],
      buckets: [10, 20],
      maxSeries: 4,
    };
    registerHistogram(name, schema);
    observe(name, { agent: 'planner' }, 5);

    registerHistogram(name, {
      ...schema,
      labels: [...schema.labels],
      buckets: [...schema.buckets],
    });

    assert.equal(registry.get(name).series.get('agent=planner').count, 1);
  });

  it('rejects duplicate registration with a conflicting type or schema', () => {
    const name = 'test_agent_conflicting_registration';
    registerHistogram(name, {
      help: 'duration',
      labels: ['agent'],
      buckets: [10, 20],
      maxSeries: 4,
    });

    for (const registerConflict of [
      () => registerCounter(name, { help: 'duration', labels: ['agent'], maxSeries: 4 }),
      () => registerHistogram(name, {
        help: 'different help',
        labels: ['agent'],
        buckets: [10, 20],
        maxSeries: 4,
      }),
      () => registerHistogram(name, {
        help: 'duration',
        labels: ['tool'],
        buckets: [10, 20],
        maxSeries: 4,
      }),
      () => registerHistogram(name, {
        help: 'duration',
        labels: ['agent'],
        buckets: [10, 30],
        maxSeries: 4,
      }),
      () => registerHistogram(name, {
        help: 'duration',
        labels: ['agent'],
        buckets: [10, 20],
        maxSeries: 5,
      }),
    ]) {
      assert.throws(registerConflict, /conflicting metric registration/i);
    }

    const metric = registry.get(name);
    assert.equal(metric.type, 'histogram');
    assert.deepEqual(metric.labels, ['agent']);
    assert.deepEqual(metric.buckets, [10, 20]);
    assert.equal(metric.maxSeries, 4);
  });
});

// ── counter ───────────────────────────────────────────────────

describe('counter', () => {
  it('increments by 1 by default', () => {
    counter('se_agent_errors_total', { agent: 'code-gen' });
    counter('se_agent_errors_total', { agent: 'code-gen' });
    const m = registry.get('se_agent_errors_total');
    const key = 'agent=code-gen';
    assert.equal(m.series.get(key), 2);
  });

  it('increments by N when supplied', () => {
    counter('se_agent_tokens_total', { agent: 'a' }, 500);
    counter('se_agent_tokens_total', { agent: 'a' }, 250);
    const m = registry.get('se_agent_tokens_total');
    assert.equal(m.series.get('agent=a'), 750);
  });

  it('isolates by label set', () => {
    counter('se_agent_errors_total', { agent: 'a' });
    counter('se_agent_errors_total', { agent: 'b' });
    counter('se_agent_errors_total', { agent: 'b' });
    const m = registry.get('se_agent_errors_total');
    assert.equal(m.series.get('agent=a'), 1);
    assert.equal(m.series.get('agent=b'), 2);
  });

  it('silently ignores unknown metric name', () => {
    // Should not throw.
    counter('nonexistent_metric', { foo: 'bar' });
  });

  it('silently ignores type mismatch (counter() on a gauge)', () => {
    counter('se_agent_rag_chunks', { collection: 'c' }, 5);
    // No effect: gauge series should be empty.
    const m = registry.get('se_agent_rag_chunks');
    assert.equal(m.series.size, 0);
  });

  it('missing label coerces to empty string in key', () => {
    counter('se_agent_invocations_total', { agent: 'a' });  // no terminatedBy
    const m = registry.get('se_agent_invocations_total');
    const keys = [...m.series.keys()];
    assert.equal(keys[0], 'agent=a,terminatedBy=');
  });

  it('rejects negative, non-finite, and non-numeric deltas', () => {
    const name = 'test_agent_counter_invalid_values';
    registerCounter(name, { help: 'invalid values', labels: ['agent'] });
    for (const value of [-1, NaN, Infinity, -Infinity, '2']) {
      counter(name, { agent: String(value) }, value);
    }
    assert.equal(registry.get(name).series.size, 0);

    counter(name, { agent: 'valid' }, 2);
    assert.equal(registry.get(name).series.get('agent=valid'), 2);
  });
});

// ── gauge ─────────────────────────────────────────────────────

describe('gauge', () => {
  it('sets a value (does not accumulate)', () => {
    gauge('se_agent_rag_chunks', { collection: 'c1' }, 100);
    gauge('se_agent_rag_chunks', { collection: 'c1' }, 250);
    const m = registry.get('se_agent_rag_chunks');
    assert.equal(m.series.get('collection=c1'), 250);
  });

  it('isolates by label set', () => {
    gauge('se_agent_rag_chunks', { collection: 'a' }, 10);
    gauge('se_agent_rag_chunks', { collection: 'b' }, 20);
    const m = registry.get('se_agent_rag_chunks');
    assert.equal(m.series.get('collection=a'), 10);
    assert.equal(m.series.get('collection=b'), 20);
  });

  it('silently ignores type mismatch (gauge() on a counter)', () => {
    gauge('se_agent_errors_total', { agent: 'a' }, 42);
    const m = registry.get('se_agent_errors_total');
    assert.equal(m.series.size, 0);
  });

  it('rejects non-finite values while retaining finite negative gauges', () => {
    const name = 'test_agent_gauge_invalid_values';
    registerGauge(name, { help: 'invalid values', labels: ['collection'] });
    for (const value of [NaN, Infinity, -Infinity, '2']) {
      gauge(name, { collection: String(value) }, value);
    }
    assert.equal(registry.get(name).series.size, 0);

    gauge(name, { collection: 'delta' }, -2);
    assert.equal(registry.get(name).series.get('collection=delta'), -2);
  });
});

// ── observe (histogram) ──────────────────────────────────────

describe('observe', () => {
  it('initialises bucket counts on first observation', () => {
    observe('se_agent_duration_ms', { agent: 'a', terminatedBy: 'final' }, 75);
    const m = registry.get('se_agent_duration_ms');
    const rec = m.series.get('agent=a,terminatedBy=final');
    assert.equal(rec.count, 1);
    assert.equal(rec.sum, 75);
    // 75 falls into the 100ms bucket and all higher buckets.
    assert.equal(rec.buckets.get(50), 0);   // 75 > 50
    assert.equal(rec.buckets.get(100), 1);  // 75 <= 100
    assert.equal(rec.buckets.get(250), 1);
    assert.equal(rec.buckets.get(60000), 1);
  });

  it('accumulates count + sum across multiple observations', () => {
    observe('se_agent_duration_ms', { agent: 'a', terminatedBy: 'final' }, 100);
    observe('se_agent_duration_ms', { agent: 'a', terminatedBy: 'final' }, 200);
    observe('se_agent_duration_ms', { agent: 'a', terminatedBy: 'final' }, 300);
    const m = registry.get('se_agent_duration_ms');
    const rec = m.series.get('agent=a,terminatedBy=final');
    assert.equal(rec.count, 3);
    assert.equal(rec.sum, 600);
  });

  it('values larger than the largest bucket still increment count + sum', () => {
    observe('se_agent_duration_ms', { agent: 'a', terminatedBy: 'final' }, 999_999);
    const m = registry.get('se_agent_duration_ms');
    const rec = m.series.get('agent=a,terminatedBy=final');
    assert.equal(rec.count, 1);
    assert.equal(rec.sum, 999_999);
    // None of the explicit buckets contains the value.
    for (const b of m.buckets) {
      assert.equal(rec.buckets.get(b), 0);
    }
  });

  it('silently ignores unknown histogram name', () => {
    observe('nonexistent_histogram', { foo: 'bar' }, 50);
    // Should not throw.
  });

  it('rejects negative, non-finite, and non-numeric observations', () => {
    const name = 'test_agent_histogram_invalid_values';
    registerHistogram(name, {
      help: 'invalid values',
      labels: ['agent'],
      buckets: [10],
    });
    for (const value of [-1, NaN, Infinity, -Infinity, '2']) {
      observe(name, { agent: String(value) }, value);
    }
    assert.equal(registry.get(name).series.size, 0);

    observe(name, { agent: 'valid' }, 2);
    const record = registry.get(name).series.get('agent=valid');
    assert.equal(record.count, 1);
    assert.equal(record.sum, 2);
  });
});

describe('per-family series cap', () => {
  it('uses a finite bounded default', () => {
    registerCounter('test_agent_default_series_cap', {
      help: 'h',
      labels: ['value'],
    });
    const family = registry.get('test_agent_default_series_cap');
    assert.ok(Number.isInteger(family.maxSeries));
    assert.ok(family.maxSeries >= 1 && family.maxSeries <= 10_000);
  });

  it('folds counter overflow into a deterministic __other__ series', () => {
    registerCounter('test_agent_counter_cap', {
      help: 'h',
      labels: ['agent'],
      maxSeries: 3,
    });
    for (const agent of ['a', 'b', 'c', 'd']) {
      counter('test_agent_counter_cap', { agent });
    }
    counter('test_agent_counter_cap', { agent: 'a' }, 2);

    const family = registry.get('test_agent_counter_cap');
    assert.equal(family.series.size, 3);
    assert.equal(family.series.get('agent=a'), 3);
    assert.equal(family.series.get('agent=b'), 1);
    assert.equal(family.series.get('agent=__other__'), 2);
  });

  it('folds histogram overflow into a deterministic __other__ series', () => {
    registerHistogram('test_agent_histogram_cap', {
      help: 'h',
      labels: ['agent'],
      buckets: [10],
      maxSeries: 2,
    });
    observe('test_agent_histogram_cap', { agent: 'a' }, 1);
    observe('test_agent_histogram_cap', { agent: 'b' }, 2);
    observe('test_agent_histogram_cap', { agent: 'c' }, 3);

    const family = registry.get('test_agent_histogram_cap');
    assert.equal(family.series.size, 2);
    assert.equal(family.series.get('agent=a').count, 1);
    assert.equal(family.series.get('agent=__other__').count, 2);
    assert.equal(family.series.get('agent=__other__').sum, 5);
  });

  it('bounds gauges by dropping later new label sets while allowing updates', () => {
    registerGauge('test_agent_gauge_cap', {
      help: 'h',
      labels: ['collection'],
      maxSeries: 2,
    });
    gauge('test_agent_gauge_cap', { collection: 'a' }, 1);
    gauge('test_agent_gauge_cap', { collection: 'b' }, 2);
    gauge('test_agent_gauge_cap', { collection: 'c' }, 3);
    gauge('test_agent_gauge_cap', { collection: 'a' }, 4);

    const family = registry.get('test_agent_gauge_cap');
    assert.equal(family.series.size, 2);
    assert.equal(family.series.get('collection=a'), 4);
    assert.equal(family.series.get('collection=b'), 2);
    assert.equal(family.series.has('collection=c'), false);
    assert.equal(family.series.has('collection=__other__'), false);
  });
});

// ── renderText ────────────────────────────────────────────────

describe('renderText', () => {
  it('includes HELP + TYPE lines for every registered metric', () => {
    const out = renderText();
    assert.match(out, /# HELP se_agent_invocations_total/);
    assert.match(out, /# TYPE se_agent_invocations_total counter/);
    assert.match(out, /# HELP se_agent_duration_ms/);
    assert.match(out, /# TYPE se_agent_duration_ms histogram/);
    assert.match(out, /# HELP se_agent_rag_chunks/);
    assert.match(out, /# TYPE se_agent_rag_chunks gauge/);
  });

  it('renders counter values with labels', () => {
    counter('se_agent_errors_total', { agent: 'my-agent' }, 3);
    const out = renderText();
    assert.match(out, /se_agent_errors_total\{agent="my-agent"\} 3/);
  });

  it('renders gauge values with labels', () => {
    gauge('se_agent_rag_chunks', { collection: 'docs' }, 99);
    const out = renderText();
    assert.match(out, /se_agent_rag_chunks\{collection="docs"\} 99/);
  });

  it('renders histogram with bucket, sum, count lines + le="+Inf"', () => {
    observe('se_agent_duration_ms', { agent: 'a', terminatedBy: 'final' }, 80);
    const out = renderText();
    assert.match(out, /se_agent_duration_ms_bucket\{.*le="50"\} 0/);
    assert.match(out, /se_agent_duration_ms_bucket\{.*le="100"\} 1/);
    assert.match(out, /se_agent_duration_ms_bucket\{.*le="\+Inf"\} 1/);
    assert.match(out, /se_agent_duration_ms_sum\{.*\} 80/);
    assert.match(out, /se_agent_duration_ms_count\{.*\} 1/);
  });

  it('escapes CR/LF, backslashes, and quotes without creating sample lines', () => {
    counter('se_agent_errors_total', { agent: 'a\r\ninjected 1"\\c' });
    const out = renderText();
    assert.equal(out.includes('\r'), false);
    assert.equal(out.split('\n').some((line) => line.startsWith('injected 1')), false);
    assert.ok(out.includes('se_agent_errors_total{agent="a\\ninjected 1\\"\\\\c"} 1'));
  });

  it('ends with a newline', () => {
    const out = renderText();
    assert.ok(out.endsWith('\n'));
  });
});

// ── recordAgentRun ────────────────────────────────────────────

describe('recordAgentRun', () => {
  it('increments se_agent_invocations_total with agent + terminatedBy', () => {
    recordAgentRun({ agent: 'planner', result: { terminatedBy: 'final', stats: {} } });
    const m = registry.get('se_agent_invocations_total');
    assert.equal(m.series.get('agent=planner,terminatedBy=final'), 1);
  });

  it('bumps se_agent_errors_total when terminatedBy === "error"', () => {
    recordAgentRun({ agent: 'planner', result: { terminatedBy: 'error', stats: {} } });
    const m = registry.get('se_agent_errors_total');
    assert.equal(m.series.get('agent=planner'), 1);
  });

  it('does NOT bump errors when terminatedBy is something else', () => {
    recordAgentRun({ agent: 'planner', result: { terminatedBy: 'final', stats: {} } });
    const m = registry.get('se_agent_errors_total');
    assert.equal(m.series.size, 0);
  });

  it('terminatedBy defaults to "unknown" when missing', () => {
    recordAgentRun({ agent: 'planner', result: {} });
    const m = registry.get('se_agent_invocations_total');
    assert.equal(m.series.get('agent=planner,terminatedBy=unknown'), 1);
  });

  it('records token totals (prompt + completion)', () => {
    recordAgentRun({
      agent: 'planner',
      result: {
        terminatedBy: 'final',
        stats: { approxPromptTokens: 200, approxCompletionTokens: 50 },
      },
    });
    assert.equal(registry.get('se_agent_tokens_total').series.get('agent=planner'), 250);
  });

  it('records tool cache hits', () => {
    recordAgentRun({
      agent: 'planner',
      result: { terminatedBy: 'final', stats: { toolCacheHits: 7 } },
    });
    assert.equal(registry.get('se_agent_tool_cache_hits_total').series.get('agent=planner'), 7);
  });

  it('observes duration', () => {
    recordAgentRun({
      agent: 'planner',
      result: { terminatedBy: 'final', stats: { durationMs: 1500 } },
    });
    const m = registry.get('se_agent_duration_ms');
    const rec = m.series.get('agent=planner,terminatedBy=final');
    assert.equal(rec.count, 1);
    assert.equal(rec.sum, 1500);
  });

  it('handles missing stats safely (zeros)', () => {
    recordAgentRun({ agent: 'planner', result: { terminatedBy: 'final' } });
    assert.equal(registry.get('se_agent_tokens_total').series.get('agent=planner'), 0);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/agents/metrics');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      '_reset', 'counter', 'gauge', 'observe',
      'recordAgentRun', 'registerCounter', 'registerGauge',
      'registerHistogram', 'registry', 'renderText',
    ]);
  });
});
