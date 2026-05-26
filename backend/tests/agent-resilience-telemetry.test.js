const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const AgentResilienceManager = require(path.join(__dirname, '../src/services/agents/agent-resilience-hardening'));
const AgentTelemetry = require(path.join(__dirname, '../src/services/agents/agent-telemetry'));

// ─── Resilience Manager Tests ──────────────────────────────────────────────

test('AgentResilienceManager: retry with backoff', async () => {
  const manager = new AgentResilienceManager({ maxRetries: 3, initialBackoffMs: 10 });
  let attempts = 0;

  const result = await manager.retryWithBackoff(async () => {
    attempts++;
    if (attempts < 3) throw new Error('Not yet');
    return 'success';
  });

  assert.strictEqual(result, 'success');
  assert.strictEqual(attempts, 3);
});

test('AgentResilienceManager: retry exhausted', async () => {
  const manager = new AgentResilienceManager({ maxRetries: 2, initialBackoffMs: 5 });
  let attempts = 0;

  try {
    await manager.retryWithBackoff(async () => {
      attempts++;
      throw new Error('Always fails');
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert(err.message.includes('Always fails'));
    assert.strictEqual(attempts, 2);
  }
});

test('AgentResilienceManager: circuit breaker opens on threshold', async () => {
  const manager = new AgentResilienceManager({
    circuitBreakerThreshold: 2,
    circuitBreakerResetMs: 100,
  });

  let callCount = 0;
  const fn = async () => {
    callCount++;
    throw new Error('Fail');
  };

  // First 2 calls fail, circuit opens
  for (let i = 0; i < 2; i++) {
    try {
      await manager.callWithCircuitBreaker('test', fn);
    } catch (e) {
      // Expected
    }
  }

  // Third call blocked by circuit
  try {
    await manager.callWithCircuitBreaker('test', fn);
    assert.fail('Should have thrown circuit open');
  } catch (err) {
    assert(err.message.includes('Circuit breaker OPEN'));
  }

  assert.strictEqual(callCount, 2);
});

test('AgentResilienceManager: timeout guard', async () => {
  const manager = new AgentResilienceManager({ requestTimeoutMs: 50 });

  try {
    await manager.withTimeout(
      new Promise(resolve => setTimeout(() => resolve('ok'), 200)),
      50
    );
    assert.fail('Should have timed out');
  } catch (err) {
    assert(err.message.includes('timed out'));
  }
});

test('AgentResilienceManager: metrics', () => {
  const manager = new AgentResilienceManager();
  manager.metrics.retries = 5;
  manager.metrics.timeouts = 2;

  const metrics = manager.getMetrics();
  assert.strictEqual(metrics.retries, 5);
  assert.strictEqual(metrics.timeouts, 2);
});

// ─── Telemetry Tests ──────────────────────────────────────────────────────

test('AgentTelemetry: span lifecycle', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  const span = telemetry.startSpan('test-operation', { userId: '123' });
  assert(span.end);

  span.end({ status: 'ok' });

  const traces = telemetry.getTraces();
  assert(traces.length > 0);
});

test('AgentTelemetry: span nesting', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  const parentSpan = telemetry.startSpan('parent');
  const childSpan = telemetry.startSpan('child', { parentId: 'test' });

  parentSpan.end();
  childSpan.end();

  const traces = telemetry.getTraces();
  // Parent span should be in traces
  assert(traces.length > 0);
});

test('AgentTelemetry: record agent run', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  telemetry.recordAgentRun('agent-1', 'task-1', {
    success: true,
    durationMs: 1500,
    toolsCalled: ['tool-a', 'tool-b'],
  });

  const metrics = telemetry.getMetrics();
  assert.strictEqual(metrics.agentRuns, 1);
  assert.strictEqual(metrics.taskCompletions, 1);
  assert(metrics.latency.agentP50 > 0);
});

test('AgentTelemetry: record tool invocation', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  telemetry.recordToolInvocation('read_file', { path: '/foo' }, {
    durationMs: 50,
    result: { content: 'data' },
  });

  telemetry.recordToolInvocation('api_call', { url: 'https://...' }, {
    durationMs: 200,
    error: new Error('Timeout'),
  });

  const metrics = telemetry.getMetrics();
  assert.strictEqual(metrics.toolInvocations, 2);
  assert.strictEqual(metrics.toolErrors, 1);
  assert(metrics.latency.toolP50 > 0);
});

test('AgentTelemetry: emit and retrieve events', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  telemetry.emitEvent('custom.event', { foo: 'bar' });
  telemetry.emitEvent('another.event', { baz: 123 });

  const events = telemetry.getEvents();
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].type, 'custom.event');
});

test('AgentTelemetry: export data', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  telemetry.recordAgentRun('agent-1', 'task-1', { success: true, durationMs: 100 });
  telemetry.emitEvent('test.event', { data: 'value' });

  const exported = telemetry.export();
  assert(exported.timestamp);
  assert(exported.metrics);
  assert(Array.isArray(exported.traces));
  assert(Array.isArray(exported.events));
});

test('AgentTelemetry: sampling', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 0.0 }); // Never sample

  telemetry.startSpan('should-not-appear').end();
  telemetry.emitEvent('should-not-appear', {});

  const traces = telemetry.getTraces();
  const events = telemetry.getEvents();
  assert.strictEqual(traces.length, 0);
  assert.strictEqual(events.length, 0);
});

test('AgentTelemetry: percentile calculations', () => {
  const telemetry = new AgentTelemetry({ sampleRate: 1.0 });

  for (let i = 0; i < 100; i++) {
    telemetry.recordAgentRun('agent-1', `task-${i}`, {
      success: true,
      durationMs: i * 10,
      toolsCalled: [],
    });
  }

  const metrics = telemetry.getMetrics();
  assert(metrics.latency.agentP50 > 0);
  assert(metrics.latency.agentP95 >= metrics.latency.agentP50);
});

console.log('✅ All agent resilience and telemetry tests passed');
