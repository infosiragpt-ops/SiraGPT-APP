/**
 * Tests for structured-logger.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  StructuredLogger, getLogger, generateTraceId, createTraceContext, _resetLoggers,
} = require('../src/services/agents/structured-logger');

describe('StructuredLogger', () => {
  it('creates logger with component name', () => {
    const log = new StructuredLogger('test-component');
    assert.strictEqual(log.component, 'test-component');
  });

  it('throws without component name', () => {
    assert.throws(() => new StructuredLogger(), /component is required/);
    assert.throws(() => new StructuredLogger(''), /component is required/);
  });

  it('_log emits JSON line via transport', () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'debug', transport: line => lines.push(JSON.parse(line)) });
    log.info('test message', { key: 'value' });
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'info');
    assert.strictEqual(lines[0].component, 'test');
    assert.strictEqual(lines[0].message, 'test message');
    assert.strictEqual(lines[0].data.key, 'value');
  });

  it('respects minimum level (suppresses debug when min=info)', () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'info', transport: line => lines.push(JSON.parse(line)) });
    log.debug('should be suppressed');
    log.info('should appear');
    assert.strictEqual(lines.length, 1);
  });

  it('withTrace adds traceId to entries', () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'info', transport: line => lines.push(JSON.parse(line)) });
    const traced = log.withTrace({ traceId: 'trace-123' });
    traced.info('traced message');
    assert.strictEqual(lines[0].traceId, 'trace-123');
  });

  it('child creates sub-logger with merged base data', () => {
    const lines = [];
    const log = new StructuredLogger('parent', { level: 'info', transport: line => lines.push(JSON.parse(line)) });
    const child = log.child({ subId: 'child-1' });
    child.info('child message');
    assert.strictEqual(lines[0].data.subId, 'child-1');
  });

  it('timed wraps async function with start/end logging', async () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'info', transport: line => lines.push(JSON.parse(line)) });
    const result = await log.timed('test-op', async () => { await new Promise(r => setTimeout(r, 5)); return 42; });
    assert.strictEqual(result, 42);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].data.phase, 'start');
    assert.strictEqual(lines[1].data.phase, 'end');
    assert.ok(lines[1].data.durationMs >= 5);
  });

  it('timed logs error and re-throws', async () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'error', transport: line => lines.push(JSON.parse(line)) });
    await assert.rejects(log.timed('fail-op', async () => { throw new Error('task failed'); }), /task failed/);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].data.phase, 'error');
  });

  it('error objects are serialized properly', () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'error', transport: line => lines.push(JSON.parse(line)) });
    log.error('An error occurred', { error: new Error('something broke') });
    assert.strictEqual(lines[0].error.name, 'Error');
    assert.strictEqual(lines[0].error.message, 'something broke');
    assert.ok(lines[0].error.stack);
  });

  it('redacts sensitive values before serializing agent log data', () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'info', transport: line => lines.push(JSON.parse(line)) });
    log.info('provider call', {
      provider: {
        request: {
          headers: { authorization: 'Bearer leaked-token' },
          credentials: { apiKey: 'deep-api-key', clientSecret: 'deep-client-secret' },
        },
      },
      safe: 'visible',
    });
    assert.strictEqual(lines[0].data.provider.request.headers.authorization, '[REDACTED]');
    assert.strictEqual(lines[0].data.provider.request.credentials.apiKey, '[REDACTED]');
    assert.strictEqual(lines[0].data.provider.request.credentials.clientSecret, '[REDACTED]');
    assert.strictEqual(lines[0].data.safe, 'visible');
  });

  it('redacts sensitive values before pretty-printing agent log data', () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      const log = new StructuredLogger('test', { level: 'info', pretty: true });
      log.info('pretty redaction', { nested: { token: 'pretty-token' } });
    } finally {
      process.stdout.write = originalWrite;
    }
    const output = writes.join('');
    assert.match(output, /\[REDACTED\]/);
    assert.doesNotMatch(output, /pretty-token/);
  });

  it('fatal level is always emitted', () => {
    const lines = [];
    const log = new StructuredLogger('test', { level: 'fatal', transport: line => lines.push(JSON.parse(line)) });
    log.fatal('critical error');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'fatal');
  });

  it('pretty-print mode does not throw', () => {
    const log = new StructuredLogger('test', { level: 'info', pretty: true });
    log.info('pretty message', { data: 123 });
    log.error('pretty error', { error: new Error('test') });
    assert.ok(true);
  });
});

describe('getLogger (singleton factory)', () => {
  it('returns same instance for same component', () => {
    const a = getLogger('my-component');
    const b = getLogger('my-component');
    assert.strictEqual(a, b);
    _resetLoggers();
  });
});

describe('generateTraceId', () => {
  it('generates unique trace IDs', () => {
    const a = generateTraceId();
    const b = generateTraceId();
    assert.notStrictEqual(a, b);
    assert.ok(a.length >= 16);
  });
});

describe('createTraceContext', () => {
  it('creates context with traceId and spanId', () => {
    const ctx = createTraceContext();
    assert.ok(ctx.traceId);
    assert.ok(ctx.spanId);
    assert.strictEqual(ctx.parentSpanId, null);
  });

  it('inherits traceId from parent context', () => {
    const parent = createTraceContext();
    const child = createTraceContext(parent);
    assert.strictEqual(child.traceId, parent.traceId);
    assert.notStrictEqual(child.spanId, parent.spanId);
    assert.strictEqual(child.parentSpanId, parent.spanId);
  });
});
