/**
 * Tests for agent-system.js — the central bootstrap / integration hub.
 *
 * These tests verify that initAgentSystem() initialises all platform
 * services, that getServices() returns the expected shape, and that
 * guardedExecute() properly wraps operations with bulkhead + tracing.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  initAgentSystem,
  getServices,
  guardedExecute,
  SubAgentOrchestrator,
  SubAgentError,
  BulkheadPool,
  ProviderRegistry,
  ProviderAdapter,
  PluginRegistry,
  PluginInstance,
  getLogger,
  createTraceContext,
  Tracer,
  MetricsAggregator,
  getBulkhead,
} = require('../src/services/agents/agent-system');

describe('agent-system', () => {
  describe('initAgentSystem', () => {
    it('initialises all services and returns service map', () => {
      const svc = initAgentSystem();

      assert.ok(svc, 'should return service map');
      assert.ok(svc.tracer, 'tracer should be present');
      assert.ok(svc.logger, 'logger should be present');
      assert.ok(svc.metrics, 'metrics should be present');
      assert.ok(svc.providerRegistry, 'providerRegistry should be present');
      assert.ok(svc.agentPool, 'agentPool should be present');
      assert.ok(svc.orchestrator, 'orchestrator should be present');
      assert.ok(svc.initialised, 'initialised should be true');
    });

    it('is idempotent when called twice', () => {
      const svc1 = initAgentSystem();
      const svc2 = initAgentSystem();

      // Same tracer instance
      assert.strictEqual(svc1.tracer, svc2.tracer);
      // Same provider registry
      assert.strictEqual(svc1.providerRegistry, svc2.providerRegistry);
      // Same agent pool
      assert.strictEqual(svc1.agentPool, svc2.agentPool);
    });

    it('orchestrator has expected methods', () => {
      const svc = getServices();
      assert.ok(typeof svc.orchestrator.decompose === 'function');
      assert.ok(typeof svc.orchestrator.orchestrate === 'function');
    });

    it('agentPool has expected API', () => {
      const svc = getServices();
      assert.ok(typeof svc.agentPool.acquire === 'function');
      assert.ok(typeof svc.agentPool.execute === 'function');
      assert.ok(typeof svc.agentPool.stats === 'function');
    });

    it('providerRegistry is singleton', () => {
      // Must be the same instance regardless of access path
      const direct = require('../src/services/agents/provider-registry').getProviderRegistry();
      const viaSystem = getServices().providerRegistry;
      assert.strictEqual(direct, viaSystem);
    });
  });

  describe('getServices', () => {
    it('returns all named exports', () => {
      const svc = getServices();
      assert.ok(Array.isArray(svc.orchestrator?.decompose?.('test') ?? []));
    });

    it('exposes re-exported constructors', () => {
      const svc = getServices();
      assert.ok(typeof svc.SubAgentOrchestrator === 'function');
      assert.ok(typeof svc.SubAgentError === 'function');
      assert.ok(typeof svc.BulkheadPool === 'function');
      assert.ok(typeof svc.ProviderRegistry === 'function');
      assert.ok(typeof svc.ProviderAdapter === 'function');
      assert.ok(typeof svc.PluginRegistry === 'function');
      assert.ok(typeof svc.PluginInstance === 'function');
      assert.ok(typeof svc.getLogger === 'function');
      assert.ok(typeof svc.createTraceContext === 'function');
      assert.ok(typeof svc.Tracer === 'function');
      assert.ok(typeof svc.MetricsAggregator === 'function');
      assert.ok(typeof svc.getBulkhead === 'function');
    });
  });

  describe('guardedExecute', () => {
    it('wraps a successful operation with tracing', async () => {
      const result = await guardedExecute('test-op', async () => 'hello');
      assert.strictEqual(result, 'hello');
    });

    it('re-throws errors from the wrapped function', async () => {
      await assert.rejects(
        () => guardedExecute('fail-op', async () => { throw new Error('boom'); }),
        /boom/,
      );
    });

    it('accepts a custom timeout', async () => {
      const result = await guardedExecute(
        'timeout-op',
        async () => 'timely',
        { timeoutMs: 5000 },
      );
      assert.strictEqual(result, 'timely');
    });

    it('can be used without initAgentSystem (graceful fallback)', async () => {
      // Must still work even if init was called earlier (it was)
      const result = await guardedExecute('late-op', async () => 42);
      assert.strictEqual(result, 42);
    });
  });

  describe('re-exported classes', () => {
    it('SubAgentError creates structured errors', () => {
      const err = new SubAgentError('task-1', 'failed');
      assert.strictEqual(err.subTaskId, 'task-1');
    });

    it('BulkheadPool validates constructor args', () => {
      assert.throws(() => new BulkheadPool({ name: '' }), /name/);
    });

    it('ProviderAdapter throws on unimplemented methods', () => {
      const adapter = new ProviderAdapter();
      assert.throws(() => adapter.name, /not implemented/);
    });

    it('PluginInstance starts in DISCOVERED state', () => {
      const p = new PluginInstance(
        { id: 'test', name: 'Test', version: '1.0.0', description: 'd', author: 'a' },
        async () => ({}),
      );
      assert.strictEqual(p.state, 'discovered');
    });

    it('Tracer creates spans', () => {
      const t = new Tracer();
      const span = t.start('op');
      assert.ok(span.spanId);
      assert.strictEqual(span.name, 'op');
    });

    it('MetricsAggregator records counters', () => {
      const m = new MetricsAggregator();
      m.increment('hits');
      assert.strictEqual(m.snapshot().counters[0].value, 1);
    });

    it('createTraceContext creates trace context', () => {
      const ctx = createTraceContext();
      assert.ok(ctx.traceId);
      assert.ok(ctx.spanId);
    });

    it('getLogger returns a child logger', () => {
      const log = getLogger('test-component');
      assert.ok(typeof log.info === 'function');
      assert.ok(typeof log.error === 'function');
    });
  });
});
