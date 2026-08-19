'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { debounce, throttle } = require('../src/utils/throttle-debounce');

function later(ms) { return new Promise((r) => setTimeout(r, ms)); }

describe('debounce — basic', () => {
  test('only the LAST call within the window fires', async () => {
    let calls = 0;
    let lastArg = null;
    const fn = debounce((x) => { calls += 1; lastArg = x; }, 30);
    fn(1); fn(2); fn(3);
    await later(60);
    assert.equal(calls, 1);
    assert.equal(lastArg, 3);
  });

  test('rejects bad args', () => {
    assert.throws(() => debounce(null, 10), TypeError);
    assert.throws(() => debounce(() => {}, -1), TypeError);
  });

  test('cancel drops pending invocation', async () => {
    let calls = 0;
    const fn = debounce(() => calls++, 20);
    fn();
    fn.cancel();
    await later(40);
    assert.equal(calls, 0);
  });

  test('flush runs pending immediately', () => {
    let calls = 0;
    const fn = debounce(() => calls++, 1000);
    fn();
    fn.flush();
    assert.equal(calls, 1);
  });

  test('leading:true fires on first call', async () => {
    let calls = 0;
    const fn = debounce(() => calls++, 30, { leading: true });
    fn();
    assert.equal(calls, 1);
    await later(50);
  });

  test('pending() reports timer state', async () => {
    const fn = debounce(() => {}, 30);
    fn();
    assert.equal(fn.pending(), true);
    fn.cancel();
    assert.equal(fn.pending(), false);
  });
});

describe('throttle — basic', () => {
  test('first call fires immediately (leading default)', () => {
    let calls = 0;
    const fn = throttle(() => calls++, 100);
    fn();
    assert.equal(calls, 1);
  });

  test('subsequent calls within window are coalesced', async () => {
    let calls = 0;
    const fn = throttle(() => calls++, 30);
    fn(); fn(); fn();
    assert.equal(calls, 1);
    await later(60);
    // trailing fires once at end of window with last args
    assert.ok(calls >= 1 && calls <= 2);
    fn.cancel();
  });

  test('after window opens, next call fires', async () => {
    let calls = 0;
    const fn = throttle(() => calls++, 20);
    fn();
    await later(40);
    fn();
    assert.ok(calls >= 2);
  });

  test('leading:false delays the first call to trailing edge', async () => {
    let calls = 0;
    const fn = throttle(() => calls++, 30, { leading: false });
    fn();
    assert.equal(calls, 0);
    await later(60);
    assert.equal(calls, 1);
  });

  test('cancel + flush behave like debounce', async () => {
    let calls = 0;
    const fn = throttle(() => calls++, 1000, { leading: false });
    fn();
    fn.flush();
    assert.equal(calls, 1);
    fn();
    fn.cancel();
    await later(50);
    assert.equal(calls, 1);
  });

  test('rejects bad args', () => {
    assert.throws(() => throttle('nope', 10), TypeError);
    assert.throws(() => throttle(() => {}, NaN), TypeError);
  });
});

describe('this binding', () => {
  test('debounced fn preserves this binding', async () => {
    const obj = { v: 7, run: function () { return this.v; } };
    const wrapped = debounce(obj.run, 10);
    let result;
    wrapped.call(obj);
    await later(20);
    // Re-call to capture the most recent return value via flush
    wrapped.call(obj);
    result = wrapped.flush();
    assert.equal(result, 7);
  });
});
