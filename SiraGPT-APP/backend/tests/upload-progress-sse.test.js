'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// Stub the DB module before requiring the SSE handler so we never construct a
// real PrismaClient or hit a database.
const dbPath = require.resolve('../src/config/database');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  children: [],
  paths: [],
  exports: { file: { findMany: async () => [] } },
};

const { progressStream } = require('../src/services/upload-progress-sse');

function makeReqRes() {
  const req = new EventEmitter();
  req.user = { id: 'u1' };
  req.query = { fileIds: 'f1,f2' };
  const writes = [];
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(chunk) { writes.push(String(chunk)); return true; },
    end() { this.ended = true; },
    status() { return this; },
    json() { return this; },
  };
  return { req, res, writes };
}

test('progressStream clears both intervals and the auto-cleanup timeout on disconnect', () => {
  const realClearInterval = global.clearInterval;
  const realClearTimeout = global.clearTimeout;
  let intervalsCleared = 0;
  let timeoutsCleared = 0;
  global.clearInterval = (t) => { intervalsCleared += 1; return realClearInterval(t); };
  global.clearTimeout = (t) => { timeoutsCleared += 1; return realClearTimeout(t); };
  try {
    const { req, res } = makeReqRes();
    progressStream(req, res);

    // Client disconnects.
    req.emit('close');

    assert.ok(intervalsCleared >= 2, `both intervals must be cleared on disconnect (got ${intervalsCleared})`);
    assert.ok(timeoutsCleared >= 1, `the 5-min auto-cleanup timeout must be cleared on disconnect (got ${timeoutsCleared})`);
  } finally {
    global.clearInterval = realClearInterval;
    global.clearTimeout = realClearTimeout;
  }
});

test('progressStream rejects requests without fileIds', () => {
  const req = new EventEmitter();
  req.user = { id: 'u1' };
  req.query = {};
  let code = null;
  const res = {
    status(c) { code = c; return this; },
    json() { return this; },
    writeHead() {},
    flushHeaders() {},
    write() { return true; },
    end() {},
  };
  progressStream(req, res);
  assert.equal(code, 400);
});
