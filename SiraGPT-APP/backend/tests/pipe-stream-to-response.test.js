'use strict';

// Unit tests for pipeStreamToResponse — the guard that stops a single failed
// file download (R2/S3 drop, cache file unlinked mid-stream, disk error) from
// becoming an unhandled stream 'error' → process.exit(1) backend crash.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { pipeStreamToResponse } = require('../src/utils/pipe-stream-to-response');

function fakeStream() {
  const s = new EventEmitter();
  s.piped = null;
  s.pipe = (dest) => { s.piped = dest; return dest; };
  return s;
}

function fakeRes({ headersSent = false } = {}) {
  const calls = { status: null, json: null, destroyed: undefined };
  const res = {
    headersSent,
    status(code) { calls.status = code; return res; },
    json(body) { calls.json = body; return res; },
    destroy(err) { calls.destroyed = err; },
    calls,
  };
  return res;
}

// Silence (and capture) the error log the guard emits on the failure paths.
let logged;
const realErr = console.error;
beforeEach(() => { logged = []; console.error = (...a) => { logged.push(a); }; });
afterEach(() => { console.error = realErr; });

describe('[UNIT] pipeStreamToResponse', () => {
  test('happy path pipes the stream to res and returns the pipe result', () => {
    const s = fakeStream();
    const res = fakeRes();
    const ret = pipeStreamToResponse(s, res, 'native-pdf');
    assert.equal(s.piped, res, 'stream is piped to res');
    assert.equal(ret, res, 'returns the pipe() result');
    assert.equal(res.calls.status, null, 'no error response on happy path');
  });

  test('error BEFORE headers sent → 500 JSON, no throw, no crash', () => {
    const s = fakeStream();
    const res = fakeRes({ headersSent: false });
    pipeStreamToResponse(s, res, 'native-pdf');
    // Emitting "error" with a listener attached must NOT throw (that is the
    // whole point — a bare pipe would let this become an uncaughtException).
    assert.doesNotThrow(() => s.emit('error', new Error('boom')));
    assert.equal(res.calls.status, 500);
    assert.deepEqual(res.calls.json, { error: 'Stream error' });
    assert.equal(res.calls.destroyed, undefined, 'must not destroy before headers');
    assert.equal(logged.length, 1, 'logged the stream error once');
  });

  test('error AFTER headers sent → destroy the truncated response, no second send', () => {
    const s = fakeStream();
    const res = fakeRes({ headersSent: true });
    pipeStreamToResponse(s, res, 'rendered-pdf');
    const err = new Error('mid-stream disk error');
    assert.doesNotThrow(() => s.emit('error', err));
    assert.equal(res.calls.status, null, 'must not try to set a status after headers');
    assert.equal(res.calls.destroyed, err, 'destroys the response with the error');
  });

  test('the error listener is attached BEFORE pipe (error emitted at once is handled)', () => {
    const s = fakeStream();
    let pipedAt = -1;
    let listenerAt = -1;
    let n = 0;
    const origOn = s.on.bind(s);
    s.on = (ev, cb) => { if (ev === 'error') listenerAt = n++; return origOn(ev, cb); };
    s.pipe = () => { pipedAt = n++; return fakeRes(); };
    const res = fakeRes();
    pipeStreamToResponse(s, res);
    assert.ok(listenerAt >= 0 && listenerAt < pipedAt, `error listener (${listenerAt}) must be attached before pipe (${pipedAt})`);
  });

  test('tolerates a res that throws on status() (already torn down)', () => {
    const s = fakeStream();
    const res = { headersSent: false, status() { throw new Error('ERR_STREAM_DESTROYED'); }, destroy() {}, pipe() {} };
    s.pipe = (d) => d;
    pipeStreamToResponse(s, res);
    assert.doesNotThrow(() => s.emit('error', new Error('boom')), 'guard swallows a torn-down response');
  });
});
