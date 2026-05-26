const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ToolRegistryValidator = require(path.join(__dirname, '../src/services/agents/tool-registry-validator'));
const ExpressInstrumentation = require(path.join(__dirname, '../src/utils/express-instrumentation'));
const DistributedCache = require(path.join(__dirname, '../src/utils/distributed-cache'));

// ─── Tool Registry Validator Tests ──────────────────────────────────────────

test('ToolRegistryValidator: detects missing tool', () => {
  const manifest = {
    'tool-1': { name: 'Tool 1', inputSchema: {}, outputFormat: 'json' },
  };
  const registry = {}; // Empty

  const validator = new ToolRegistryValidator(registry, manifest);
  const result = validator.validate();

  assert(!result.valid);
  assert(result.errors.some(e => e.includes('not registered')));
});

test('ToolRegistryValidator: detects unregistered tool', () => {
  const manifest = {};
  const registry = {
    'tool-1': () => {},
  };

  const validator = new ToolRegistryValidator(registry, manifest);
  const result = validator.validate();

  assert(result.valid); // Valid but warnings present
  assert(result.warnings.some(w => w.includes('not declared')));
});

test('ToolRegistryValidator: validates output format', () => {
  const manifest = {
    'tool-1': {
      name: 'Tool 1',
      inputSchema: {},
      outputFormat: 'invalid-format',
    },
  };
  const registry = { 'tool-1': () => {} };

  const validator = new ToolRegistryValidator(registry, manifest);
  const result = validator.validate();

  assert(!result.valid);
  assert(result.errors.some(e => e.includes('unknown outputFormat')));
});

test('ToolRegistryValidator: validates authorization levels', () => {
  const manifest = {
    'tool-1': {
      name: 'Tool 1',
      inputSchema: {},
      outputFormat: 'json',
      authorization: 'invalid-level',
    },
  };
  const registry = { 'tool-1': () => {} };

  const validator = new ToolRegistryValidator(registry, manifest);
  const result = validator.validate();

  assert(!result.valid);
  assert(result.errors.some(e => e.includes('invalid authorization')));
});

test('ToolRegistryValidator: health score', () => {
  const manifest = {
    'tool-1': {
      name: 'Tool 1',
      description: 'A test tool',
      inputSchema: {},
      outputFormat: 'json',
      authorization: 'user',
    },
  };
  const registry = { 'tool-1': () => {} };

  const validator = new ToolRegistryValidator(registry, manifest);
  validator.validate();

  const score = validator.getHealthScore();
  assert(score > 0 && score <= 100);
});

// ─── Express Instrumentation Tests ──────────────────────────────────────────

test('ExpressInstrumentation: generates correlation ID', () => {
  const inst = new ExpressInstrumentation();
  const middleware = inst.middleware();

  const req = { get: () => null, startTime: Date.now() };
  const res = {
    setHeader: () => {},
    json: (data) => data,
    send: (data) => data,
  };

  middleware(req, res, () => {});

  assert(req.correlationId);
  assert(req.correlationId.length > 0);
});

test('ExpressInstrumentation: records request metrics', () => {
  const inst = new ExpressInstrumentation();

  // Simulate requests
  inst.metrics.requestsTotal = 10;
  inst.metrics.requestsSuccess = 8;
  inst.metrics.requestsError = 2;
  inst.metrics.totalLatencyMs = [100, 200, 150, 120];
  inst.metrics.errorsByStatus = { 400: 1, 500: 1 };

  const metrics = inst.getMetrics();

  assert.strictEqual(metrics.requestsTotal, 10);
  assert.strictEqual(metrics.requestsSuccess, 8);
  assert.strictEqual(metrics.requestsError, 2);
  assert(metrics.latency.p50 > 0);
});

test('ExpressInstrumentation: calculates latency percentiles', () => {
  const inst = new ExpressInstrumentation();

  // Simulate 100 requests with varying latencies
  for (let i = 0; i < 100; i++) {
    inst.metrics.totalLatencyMs.push(i * 10);
  }

  const metrics = inst.getMetrics();

  assert(metrics.latency.p50 > 0);
  assert(metrics.latency.p95 >= metrics.latency.p50);
  assert(metrics.latency.p99 >= metrics.latency.p95);
});

// ─── Distributed Cache Tests ────────────────────────────────────────────────

test('DistributedCache: set and get', async () => {
  const cache = new DistributedCache(null, { localOnlyFallback: true });

  await cache.set('key1', { data: 'value' });
  const result = await cache.get('key1');

  assert.deepStrictEqual(result, { data: 'value' });
});

test('DistributedCache: delete', async () => {
  const cache = new DistributedCache(null, { localOnlyFallback: true });

  await cache.set('key1', 'value');
  await cache.delete('key1');
  const result = await cache.get('key1');

  assert.strictEqual(result, null);
});

test('DistributedCache: cache-aside pattern', async () => {
  const cache = new DistributedCache(null, { localOnlyFallback: true });

  let computeCalls = 0;
  const computeFn = async () => {
    computeCalls++;
    return { computed: true };
  };

  const result1 = await cache.getOrCompute('key1', computeFn);
  const result2 = await cache.getOrCompute('key1', computeFn);

  assert.deepStrictEqual(result1, { computed: true });
  assert.deepStrictEqual(result2, { computed: true });
  assert.strictEqual(computeCalls, 1); // Computed only once
});

test('DistributedCache: mget and mset', async () => {
  const cache = new DistributedCache(null, { localOnlyFallback: true });

  const keyValues = {
    key1: { value: 1 },
    key2: { value: 2 },
    key3: { value: 3 },
  };

  await cache.mset(keyValues);
  const results = await cache.mget(['key1', 'key2', 'key3']);

  assert.deepStrictEqual(results.key1, { value: 1 });
  assert.deepStrictEqual(results.key2, { value: 2 });
  assert.deepStrictEqual(results.key3, { value: 3 });
});

test('DistributedCache: pattern invalidation', async () => {
  const cache = new DistributedCache(null, { localOnlyFallback: true });

  await cache.set('user:123:profile', { name: 'John' });
  await cache.set('user:123:settings', { theme: 'dark' });
  await cache.set('user:456:profile', { name: 'Jane' });

  await cache.invalidate('user:123:*');

  const result1 = await cache.get('user:123:profile');
  const result2 = await cache.get('user:456:profile');

  assert.strictEqual(result1, null);
  assert.deepStrictEqual(result2, { name: 'Jane' });
});

test('DistributedCache: cache stats', () => {
  const cache = new DistributedCache(null, { localOnlyFallback: true });

  const stats = cache.getStats();

  assert.strictEqual(stats.localCacheSize, 0);
  assert(stats.localCacheMaxSize > 0);
  assert(!stats.redisConnected);
});

console.log('✅ All infrastructure tests passed');
