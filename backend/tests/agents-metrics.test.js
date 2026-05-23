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

  it('sanitises problematic chars (\\, ", newline) at ingestion time', () => {
    // labelKey() replaces backslash, double-quote, and newline with
    // "_" BEFORE storing in the series map. So by the time renderText
    // runs, there are no special chars left to escape — the render
    // function sees the already-cleaned value.
    counter('se_agent_errors_total', { agent: 'a"b\\c' });
    const out = renderText();
    assert.match(out, /se_agent_errors_total\{agent="a_b_c"\} 1/);
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
