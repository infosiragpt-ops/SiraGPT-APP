'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createTypedEventBus, TypedBusError } = require('../src/utils/typed-event-bus');
const s = require('../src/utils/mini-schema');

describe('createTypedEventBus — basic pub/sub', () => {
  test('on + emit fires handler with payload', () => {
    const bus = createTypedEventBus({});
    const seen = [];
    bus.on('hello', (p) => seen.push(p));
    const r = bus.emit('hello', { msg: 'world' });
    assert.equal(r.ok, true);
    assert.equal(r.delivered, 1);
    assert.deepEqual(seen, [{ msg: 'world' }]);
  });

  test('emit with no subscribers returns delivered:0', () => {
    const bus = createTypedEventBus({});
    const r = bus.emit('orphan', {});
    assert.equal(r.ok, true);
    assert.equal(r.delivered, 0);
  });

  test('unsubscribe stops further deliveries', () => {
    const bus = createTypedEventBus({});
    let n = 0;
    const off = bus.on('x', () => n++);
    bus.emit('x'); bus.emit('x');
    off();
    bus.emit('x');
    assert.equal(n, 2);
  });

  test('once handler fires exactly once', () => {
    const bus = createTypedEventBus({});
    let n = 0;
    bus.once('x', () => n++);
    bus.emit('x'); bus.emit('x'); bus.emit('x');
    assert.equal(n, 1);
  });
});

describe('register + schema validation', () => {
  test('valid payload passes through', () => {
    const bus = createTypedEventBus({});
    bus.register('user.created', s.object({ id: s.string(), age: s.number().int() }));
    let seen = null;
    bus.on('user.created', (p) => { seen = p; });
    const r = bus.emit('user.created', { id: 'u1', age: 30 });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, { id: 'u1', age: 30 });
  });

  test('invalid payload is rejected before fan-out', () => {
    const bus = createTypedEventBus({});
    bus.register('user.created', s.object({ id: s.string(), age: s.number().int() }));
    let n = 0;
    bus.on('user.created', () => n++);
    const r = bus.emit('user.created', { id: 'u1', age: 'old' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema_invalid');
    assert.ok(r.errors.length >= 1);
    assert.equal(n, 0);
  });

  test('events without registered schema pass through unchanged', () => {
    const bus = createTypedEventBus({});
    let seen = null;
    bus.on('legacy', (p) => { seen = p; });
    bus.emit('legacy', { whatever: true });
    assert.deepEqual(seen, { whatever: true });
  });

  test('register rejects bad input', () => {
    const bus = createTypedEventBus({});
    assert.throws(() => bus.register('', s.string()), TypedBusError);
    assert.throws(() => bus.register('x', null), TypedBusError);
    assert.throws(() => bus.register('x', { not: 'a-schema' }), TypedBusError);
  });
});

describe('error isolation', () => {
  test('throwing handler reported via onError; others still fire', () => {
    const errs = [];
    const bus = createTypedEventBus({ onError: (e) => errs.push(e.message) });
    let other = 0;
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => { other += 1; });
    const r = bus.emit('x');
    assert.equal(r.ok, true);
    assert.equal(other, 1);
    assert.deepEqual(errs, ['boom']);
  });

  test('throwing onError is swallowed', () => {
    const bus = createTypedEventBus({ onError: () => { throw new Error('sink bad'); } });
    bus.on('x', () => { throw new Error('boom'); });
    bus.emit('x'); // must not throw
  });
});

describe('snapshot', () => {
  test('counts emitted/delivered/dropped/schemaRejected', () => {
    const bus = createTypedEventBus({});
    bus.register('typed', s.string());
    bus.on('typed', () => {});
    bus.emit('typed', 'ok');     // 1 delivered
    bus.emit('typed', 42);       // schema reject
    bus.emit('', {});            // bad event → dropped
    const s2 = bus.snapshot();
    assert.equal(s2.emitted, 3);
    assert.equal(s2.delivered, 1);
    assert.equal(s2.schemaRejected, 1);
    assert.equal(s2.dropped, 1);
  });
});
