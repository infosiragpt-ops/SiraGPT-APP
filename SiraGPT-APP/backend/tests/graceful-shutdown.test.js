'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createShutdownRegistry } = require('../src/utils/graceful-shutdown');

function later(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('createShutdownRegistry — basic', () => {
  test('register + shutdown invokes hook', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    let fired = false;
    reg.register('a', async () => { fired = true; });
    const r = await reg.shutdown('test');
    assert.equal(fired, true);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  test('register rejects bad input', () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    assert.throws(() => reg.register('', () => {}), TypeError);
    assert.throws(() => reg.register('x', 'nope'), TypeError);
  });

  test('register after shutdown throws', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    await reg.shutdown();
    assert.throws(() => reg.register('a', () => {}));
  });
});

describe('createShutdownRegistry — order', () => {
  test('hooks run in reverse-LIFO (last registered, first executed)', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    const order = [];
    reg.register('first', () => { order.push('first'); });
    reg.register('second', () => { order.push('second'); });
    reg.register('third', () => { order.push('third'); });
    await reg.shutdown();
    assert.deepEqual(order, ['third', 'second', 'first']);
  });
});

describe('createShutdownRegistry — error isolation', () => {
  test('throwing hook reported but others still run', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    const ran = [];
    reg.register('a', () => { ran.push('a'); });
    reg.register('boom', () => { throw new Error('oops'); });
    reg.register('c', () => { ran.push('c'); });
    const r = await reg.shutdown();
    assert.deepEqual(ran, ['c', 'a']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'boom');
    assert.equal(r.ok, false);
  });

  test('hook past deadline is reported (timeout)', async () => {
    const reg = createShutdownRegistry({ attachSignals: false, deadlineMs: 30 });
    reg.register('slow', () => later(100));
    const r = await reg.shutdown();
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error.message, /timed out/);
  });
});

describe('createShutdownRegistry — onLog sink', () => {
  test('fires per hook plus shutdown_start/end', async () => {
    const events = [];
    const reg = createShutdownRegistry({
      attachSignals: false,
      onLog: (e) => events.push(e.name),
    });
    reg.register('a', () => {});
    reg.register('b', () => {});
    await reg.shutdown();
    assert.deepEqual(events, ['_shutdown_start', 'b', 'a', '_shutdown_end']);
  });

  test('throwing onLog is swallowed', async () => {
    const reg = createShutdownRegistry({
      attachSignals: false,
      onLog: () => { throw new Error('sink bad'); },
    });
    reg.register('a', () => {});
    const r = await reg.shutdown();
    assert.equal(r.ok, true);
  });
});

describe('createShutdownRegistry — lifecycle', () => {
  test('shutdown is idempotent (returns same result)', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    reg.register('a', () => {});
    const r1 = await reg.shutdown();
    const r2 = await reg.shutdown();
    assert.equal(r1, r2);
  });

  test('isShuttingDown flips true', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    assert.equal(reg.isShuttingDown(), false);
    const p = reg.shutdown();
    assert.equal(reg.isShuttingDown(), true);
    await p;
  });

  test('snapshot reports hook count + deadline + signals', () => {
    const reg = createShutdownRegistry({ attachSignals: false, deadlineMs: 5000 });
    reg.register('a', () => {});
    reg.register('b', () => {});
    const s = reg.snapshot();
    assert.equal(s.hooks, 2);
    assert.equal(s.deadlineMs, 5000);
    assert.ok(Array.isArray(s.signals));
  });

  test('unregister removes hook before shutdown', async () => {
    const reg = createShutdownRegistry({ attachSignals: false });
    let fired = false;
    const off = reg.register('once', () => { fired = true; });
    off();
    await reg.shutdown();
    assert.equal(fired, false);
  });
});
