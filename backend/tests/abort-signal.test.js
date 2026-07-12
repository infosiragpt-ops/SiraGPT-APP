const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  bindRequestAbort,
  isAbortError,
  signalWithTimeout,
  throwIfAborted,
} = require('../src/utils/abort-signal');

test('bindRequestAbort aborts work and removes listeners after a client disconnect', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableFinished = false;

  const binding = bindRequestAbort(req, res);
  req.emit('aborted');

  assert.equal(binding.signal.aborted, true);
  assert.equal(isAbortError(binding.signal.reason), true);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('finish'), 0);
});

test('bindRequestAbort cleans up after a normal response without aborting work', () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableFinished = true;

  const binding = bindRequestAbort(req, res);
  res.emit('finish');

  assert.equal(binding.signal.aborted, false);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('finish'), 0);
});

test('signalWithTimeout preserves an upstream user cancellation', () => {
  const controller = new AbortController();
  const signal = signalWithTimeout(controller.signal, 10000);
  controller.abort();

  assert.equal(signal.aborted, true);
  assert.throws(() => throwIfAborted(signal), (error) => isAbortError(error));
});
