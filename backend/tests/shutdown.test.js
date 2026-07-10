'use strict';

const assert = require('node:assert/strict');
const { describe, test, beforeEach } = require('node:test');

const shutdownReg = require('../src/utils/shutdown');

beforeEach(() => {
  shutdownReg._resetForTests();
});

describe('shutdown — register + run', () => {
  test('register requires name and fn', () => {
    assert.throws(() => shutdownReg.register('', () => {}), TypeError);
    assert.throws(() => shutdownReg.register('x', 'nope'), TypeError);
  });

  test('hooks execute in reverse-LIFO', async () => {
    const order = [];
    shutdownReg.register('a', () => { order.push('a'); });
    shutdownReg.register('b', () => { order.push('b'); });
    shutdownReg.register('c', () => { order.push('c'); });
    const r = await shutdownReg.shutdown('test');
    assert.deepEqual(order, ['c', 'b', 'a']);
    assert.equal(r.ok, true);
  });

  test('register after shutdown throws', async () => {
    await shutdownReg.shutdown('first');
    assert.throws(() => shutdownReg.register('a', () => {}));
  });
});

describe('shutdown — timeouts and isolation', () => {
  test('hook exceeding its timeout is reported but does not stop others', async () => {
    const ran = [];
    shutdownReg.register('fast', () => { ran.push('fast'); });
    shutdownReg.register('slow', () => new Promise((r) => setTimeout(r, 200)), 30);
    shutdownReg.register('also-fast', () => { ran.push('also-fast'); });
    const r = await shutdownReg.shutdown();
    assert.deepEqual(ran, ['also-fast', 'fast']);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'slow');
  });

  test('throwing hook is captured, others still run', async () => {
    const ran = [];
    shutdownReg.register('a', () => { ran.push('a'); });
    shutdownReg.register('boom', () => { throw new Error('oops'); });
    shutdownReg.register('c', () => { ran.push('c'); });
    const r = await shutdownReg.shutdown();
    assert.deepEqual(ran, ['c', 'a']);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].name, 'boom');
  });
});

describe('shutdown — introspection', () => {
  test('snapshot reflects registered hooks', () => {
    shutdownReg.register('x', () => {}, 1234);
    const snap = shutdownReg.snapshot();
    assert.equal(snap.shuttingDown, false);
    assert.equal(snap.hooks.length, 1);
    assert.equal(snap.hooks[0].name, 'x');
    assert.equal(snap.hooks[0].timeoutMs, 1234);
  });

  test('isShuttingDown flips during shutdown', async () => {
    assert.equal(shutdownReg.isShuttingDown(), false);
    await shutdownReg.shutdown();
    assert.equal(shutdownReg.isShuttingDown(), true);
  });

  test('exposes TOTAL_SHUTDOWN_DEADLINE_MS = 30000', () => {
    assert.equal(shutdownReg.TOTAL_SHUTDOWN_DEADLINE_MS, 30_000);
  });

  test('production order stops advisory pool sampling before Prisma disconnect', () => {
    const order = shutdownReg.PRODUCTION_SHUTDOWN_ORDER;
    const autoscaler = order.indexOf('database_pool_autoscaler_stop');
    const prisma = order.indexOf('prisma_disconnect');
    assert.ok(autoscaler >= 0);
    assert.ok(prisma >= 0);
    assert.ok(autoscaler < prisma);
  });
});
