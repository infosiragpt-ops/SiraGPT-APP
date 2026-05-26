/**
 * Tests for performance-tracer.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Tracer, MetricsAggregator } = require('../src/services/agents/performance-tracer');

describe('Tracer', () => {
  it('start creates a span with metadata', () => {
    const tracer = new Tracer({ service: 'test-service' });
    const span = tracer.start('test-operation');
    assert.ok(span.spanId);
    assert.ok(span.traceId);
    assert.strictEqual(span.name, 'test-operation');
    assert.strictEqual(span.parentSpanId, null);
    assert.strictEqual(span.status, 'ok');
  });

  it('end records duration', () => {
    const tracer = new Tracer();
    const span = tracer.start('quick-op');
    tracer.end(span);
    assert.ok(span.endTime > 0);
    assert.ok(span.durationMs >= 0);
    assert.strictEqual(span.status, 'ok');
  });

  it('end with error status', () => {
    const tracer = new Tracer();
    const span = tracer.start('fail-op');
    tracer.end(span, { status: 'error' });
    assert.strictEqual(span.status, 'error');
  });

  it('child span inherits parent traceId', () => {
    const tracer = new Tracer();
    const parent = tracer.start('parent');
    const child = tracer.start('child', parent.spanId);
    assert.strictEqual(child.traceId, parent.traceId);
    assert.strictEqual(child.parentSpanId, parent.spanId);
    assert.notStrictEqual(child.spanId, parent.spanId);
  });

  it('trace wraps function, records span', async () => {
    const tracer = new Tracer();
    const { result, span } = await tracer.trace('wrapped', async () => 42);
    assert.strictEqual(result, 42);
    assert.strictEqual(span.name, 'wrapped');
    assert.strictEqual(span.status, 'ok');
  });

  it('trace re-throws errors but records the span', async () => {
    const tracer = new Tracer();
    await assert.rejects(
      tracer.trace('failing', async () => { throw new Error('nope'); }),
      /nope/
    );
    const spans = tracer.snapshot();
    const span = spans.find(s => s.name === 'failing');
    assert.ok(span, 'Should have recorded the error span');
    assert.strictEqual(span.status, 'error');
  });

  it('snapshot returns completed spans only', async () => {
    const tracer = new Tracer();
    tracer.start('no-end');
    await tracer.trace('completed', async () => 'done');
    const spans = tracer.snapshot();
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, 'completed');
  });

  it('snapshot filters by traceId', async () => {
    const tracer = new Tracer();
    const { span } = await tracer.trace('in-trace', async () => 'ok');
    await tracer.trace('other', async () => 'ok');
    const filtered = tracer.snapshot(span.traceId);
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every(s => s.traceId === span.traceId));
  });

  it('summary aggregates by operation name', async () => {
    const tracer = new Tracer();
    await tracer.trace('research', async () => 'done');
    await tracer.trace('research', async () => 'done');
    await tracer.trace('write', async () => 'done');
    const summary = tracer.summary();
    assert.strictEqual(summary.totalSpans, 3);
    assert.strictEqual(summary.uniqueOperations, 2);
    const research = summary.operations.find(o => o.name === 'research');
    assert.strictEqual(research.count, 2);
  });

  it('gauge records metric values', () => {
    const tracer = new Tracer();
    tracer.gauge('memory_usage', 512, { unit: 'MB' });
    const metric = tracer._spans.find(s => s.name === '__metric:memory_usage');
    assert.ok(metric);
    assert.strictEqual(metric.status, 'metric');
    assert.strictEqual(metric.attributes.value, 512);
  });

  it('reset clears all spans', async () => {
    const tracer = new Tracer();
    await tracer.trace('temp', async () => 'ok');
    assert.strictEqual(tracer.snapshot().length, 1);
    tracer.reset();
    assert.strictEqual(tracer.snapshot().length, 0);
  });

  it('noop mode when disabled', () => {
    const tracer = new Tracer({ enabled: false });
    const span = tracer.start('noop');
    assert.strictEqual(span._noop, true);
    tracer.end(span);
  });

  it('error marks span without ending it', () => {
    const tracer = new Tracer();
    const span = tracer.start('risky');
    tracer.error(span, new Error('partial failure'), { attempt: 1 });
    assert.strictEqual(span.status, 'error');
    assert.strictEqual(span.attributes.attempt, 1);
    tracer.end(span, { status: 'ok' });
    assert.strictEqual(span.status, 'ok');
  });
});

describe('MetricsAggregator', () => {
  it('increment records counter values', () => {
    const agg = new MetricsAggregator({ windowMs: 10000 });
    agg.increment('api_calls');
    agg.increment('api_calls', 2);
    const snap = agg.snapshot();
    const counter = snap.counters.find(c => c.name === 'api_calls');
    assert.strictEqual(counter.value, 3);
  });

  it('timing records and computes percentiles', () => {
    const agg = new MetricsAggregator();
    agg.timing('llm_latency', 100);
    agg.timing('llm_latency', 200);
    agg.timing('llm_latency', 300);
    agg.timing('llm_latency', 400);
    agg.timing('llm_latency', 500);
    const snap = agg.snapshot();
    const timing = snap.timings.find(t => t.name === 'llm_latency');
    assert.strictEqual(timing.count, 5);
    assert.strictEqual(timing.min, 100);
    assert.strictEqual(timing.max, 500);
    assert.strictEqual(timing.avg, 300);
    assert.ok(timing.p50 >= 200 && timing.p50 <= 400);
  });

  it('reset clears all data', () => {
    const agg = new MetricsAggregator();
    agg.increment('calls');
    agg.timing('latency', 50);
    assert.strictEqual(agg.snapshot().counters.length, 1);
    agg.reset();
    assert.strictEqual(agg.snapshot().counters.length, 0);
    assert.strictEqual(agg.snapshot().timings.length, 0);
  });

  it('tags differentiate counters', () => {
    const agg = new MetricsAggregator();
    agg.increment('api_calls', 1, { provider: 'openai' });
    agg.increment('api_calls', 2, { provider: 'anthropic' });
    const snap = agg.snapshot();
    assert.strictEqual(snap.counters.length, 2);
    const openai = snap.counters.find(c => c.tags.provider === 'openai');
    assert.strictEqual(openai.value, 1);
  });
});
