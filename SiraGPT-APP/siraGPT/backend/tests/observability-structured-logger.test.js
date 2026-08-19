'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createStructuredLogger, LEVELS } = require('../src/services/observability/structured-logger');

function collect() {
  const lines = [];
  return {
    sink: (l) => lines.push(JSON.parse(l)),
    lines,
  };
}

describe('createStructuredLogger — level filter', () => {
  test('emits at and above configured level', () => {
    const c = collect();
    const log = createStructuredLogger({ level: 'warn', sink: c.sink });
    log.trace('t'); log.debug('d'); log.info('i');
    log.warn('w'); log.error('e'); log.fatal('f');
    assert.deepEqual(c.lines.map((l) => l.level), ['warn', 'error', 'fatal']);
  });

  test('default level is info', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink });
    log.debug('d'); log.info('i');
    assert.equal(c.lines.length, 1);
    assert.equal(c.lines[0].level, 'info');
  });
});

describe('createStructuredLogger — fields and bindings', () => {
  test('msg and fields land in the JSON line', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink });
    log.info('hello', { a: 1, b: 'x' });
    assert.equal(c.lines[0].msg, 'hello');
    assert.equal(c.lines[0].a, 1);
    assert.equal(c.lines[0].b, 'x');
  });

  test('bindings are baked into every line', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink, bindings: { service: 'siragpt' } });
    log.info('x');
    assert.equal(c.lines[0].service, 'siragpt');
  });

  test('child logger inherits + extends bindings', () => {
    const c = collect();
    const parent = createStructuredLogger({ sink: c.sink, bindings: { service: 's' } });
    const child = parent.child({ tenantId: 't1' });
    child.info('hi');
    assert.equal(c.lines[0].service, 's');
    assert.equal(c.lines[0].tenantId, 't1');
  });
});

describe('createStructuredLogger — redaction', () => {
  test('PII in msg is redacted', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink });
    log.info('contact alice@example.com asap');
    assert.match(c.lines[0].msg, /\[REDACTED:email\]/);
  });

  test('deep object fields are redacted', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink });
    log.info('event', { user: { email: 'bob@example.com' } });
    assert.match(c.lines[0].user.email, /\[REDACTED:email\]/);
  });

  test('withRedactor swaps the redactor', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink });
    const noisy = log.withRedactor((s) => `R:${s}`);
    noisy.info('hello');
    assert.equal(c.lines[0].msg, 'R:hello');
  });
});

describe('createStructuredLogger — sampling', () => {
  test('rate=0 drops everything', () => {
    const c = collect();
    const log = createStructuredLogger({
      sink: c.sink, level: 'trace',
      samplingRates: { trace: 0 },
    });
    for (let i = 0; i < 10; i++) log.trace('x');
    assert.equal(c.lines.length, 0);
    assert.equal(log.snapshot().dropped, 10);
  });

  test('rate=1 emits all', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink, level: 'trace', samplingRates: { trace: 1 } });
    for (let i = 0; i < 5; i++) log.trace('x');
    assert.equal(c.lines.length, 5);
  });

  test('rate=0.5 with seeded rng emits roughly half', () => {
    const c = collect();
    let n = 0;
    const log = createStructuredLogger({
      sink: c.sink, level: 'trace',
      samplingRates: { trace: 0.5 },
      rng: () => (n++ % 2 === 0 ? 0.1 : 0.9),
    });
    for (let i = 0; i < 100; i++) log.trace('x');
    assert.ok(c.lines.length >= 40 && c.lines.length <= 60, `got ${c.lines.length}`);
  });
});

describe('createStructuredLogger — robustness', () => {
  test('throwing sink is swallowed', () => {
    const log = createStructuredLogger({ sink: () => { throw new Error('sink bad'); } });
    log.info('x'); // must not throw
  });

  test('non-string msg is stringified + redacted', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink });
    log.info(42);
    assert.equal(typeof c.lines[0].msg, 'string');
  });

  test('snapshot exposes counters + level + bindings copy', () => {
    const c = collect();
    const log = createStructuredLogger({ sink: c.sink, level: 'warn', bindings: { svc: 'a' } });
    log.warn('x');
    const s = log.snapshot();
    assert.equal(s.emitted, 1);
    assert.equal(s.level, 'warn');
    assert.deepEqual(s.bindings, { svc: 'a' });
  });
});

describe('LEVELS export', () => {
  test('contains the canonical six levels in order', () => {
    assert.deepEqual([...LEVELS], ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });
});
