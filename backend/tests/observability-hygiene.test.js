'use strict';

/**
 * Observability hygiene (production log audit 2026-10-08):
 *  - react-agent required `../codex/model-telemetry` (nonexistent `src/codex`),
 *    so every LLM turn of the react agent silently skipped telemetry;
 *  - the request logger was mounted AFTER the rate limiters: a 429 storm left
 *    zero lines in Admin → Logs;
 *  - a client that closed mid-response logged exactly like a completed one;
 *  - `unhandledRejection` printed `[object Object]` for non-Error reasons and
 *    dropped the `cause` chain (undici code, provider request id).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');

const { buildRequestLogger } = require('../src/middleware/request-logger');
const { summarizeJson } = require('../src/services/observability/live-logs/classify');
const { describeErrorChain, DEFAULT_MAX_LEN } = require('../src/utils/error-chain');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('react-agent telemetry require path', () => {
  test('resolves to the real codex module', () => {
    const src = read('src/services/react-agent.js');
    assert.doesNotMatch(src, /require\('\.\.\/codex\/model-telemetry'\)/, 'src/codex does not exist');
    const uses = src.match(/require\('\.\/codex\/model-telemetry'\)\.recordLlmTurn\(/g) || [];
    assert.ok(uses.length >= 3, `expected the three recordLlmTurn sites, got ${uses.length}`);
    assert.ok(require.resolve('../src/services/codex/model-telemetry'));
  });
});

describe('index.js mount order', () => {
  test('the request logger is mounted before every rate limiter', () => {
    const src = read('index.js');
    const loggerAt = src.indexOf('app.use(requestLogger);');
    assert.ok(loggerAt > 0);
    for (const mount of ["app.use('/api/auth', authLimiter);", "app.use('/api/', apiLimiter);", "app.use('/api/agent', expensiveLimiter);"]) {
      const at = src.indexOf(mount);
      assert.ok(at > 0, `${mount} exists`);
      assert.ok(loggerAt < at, `request logger must be mounted before ${mount}`);
    }
    assert.equal((src.match(/app\.use\(requestLogger\);/g) || []).length, 1);
  });

  test('unhandledRejection names the root cause through describeErrorChain', () => {
    const src = read('index.js');
    const at = src.indexOf("process.on('unhandledRejection'");
    const block = src.slice(at, at + 1500);
    assert.match(block, /describeErrorChain\(reason\)/);
    // The old inline formatter (`reason.name: reason.message`, else String(reason)).
    assert.doesNotMatch(block, /\$\{reason\.name\}: \$\{reason\.message\}/);
  });
});

describe('request-logger: aborted responses', () => {
  function mockReq() {
    return { method: 'POST', url: '/api/ai/generate', originalUrl: '/api/ai/generate', headers: {}, socket: { remoteAddress: '1.2.3.4' }, ip: '1.2.3.4' };
  }

  test("'close' before 'finish' marks the line aborted; a finished response does not", () => {
    const captured = [];
    const mw = buildRequestLogger({ logger: (p) => captured.push(p), now: () => 1000 });

    const aborted = new EventEmitter();
    aborted.statusCode = 200;
    aborted.writableFinished = false;
    mw(mockReq(), aborted, () => {});
    aborted.emit('close');

    const finished = new EventEmitter();
    finished.statusCode = 200;
    finished.writableFinished = true;
    mw(mockReq(), finished, () => {});
    finished.emit('finish');
    finished.emit('close');

    assert.equal(captured.length, 2);
    assert.equal(captured[0].aborted, true);
    assert.equal(Object.prototype.hasOwnProperty.call(captured[1], 'aborted'), false);
  });

  test('a real client that disconnects mid-stream produces aborted:true', async () => {
    const captured = [];
    const app = express();
    app.use(buildRequestLogger({ logger: (p) => captured.push(p) }));
    app.get('/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: hello\n\n'); // headers flushed, response never ended by us
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${server.address().port}/stream`, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', reject);
      });
      const deadline = Date.now() + 2000;
      while (!captured.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0].aborted, true);
    assert.equal(captured[0].path, '/stream');
  });

  test('Admin → Logs summarises an aborted line as «cliente cerró»', () => {
    const base = { method: 'POST', path: '/api/ai/generate', status: 200, durMs: 40000 };
    assert.equal(summarizeJson({ ...base, aborted: true }), 'POST /api/ai/generate → 200 (40000 ms) · cliente cerró');
    assert.equal(summarizeJson(base), 'POST /api/ai/generate → 200 (40000 ms)');
    assert.doesNotMatch(summarizeJson({ aborted: true, msg: 'queue drained' }), /cliente cerró/);
  });
});

describe('describeErrorChain', () => {
  test('walks the cause chain with code, status and provider request id', () => {
    const root = Object.assign(new Error('connect timeout'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' });
    const mid = new TypeError('fetch failed', { cause: root });
    const top = Object.assign(new Error('Connection error.', { cause: mid }), { name: 'APIConnectionError', requestID: 'req_123' });
    assert.equal(
      describeErrorChain(top),
      'APIConnectionError: Connection error. [req=req_123] ← TypeError: fetch failed ← ConnectTimeoutError: connect timeout [code=UND_ERR_CONNECT_TIMEOUT]',
    );
    const withStatus = Object.assign(new Error('Too Many Requests'), { status: 429, code: 'rate_limited' });
    assert.equal(describeErrorChain(withStatus), 'Error: Too Many Requests [code=rate_limited status=429]');
  });

  test('non-Error reasons are inspected, never [object Object]', () => {
    assert.equal(describeErrorChain({ code: 'E1', message: 'x' }), "{ code: 'E1', message: 'x' }");
    assert.equal(describeErrorChain('plain string'), 'plain string');
    assert.equal(describeErrorChain(undefined), 'undefined');
    assert.equal(describeErrorChain(null), 'null');
    assert.equal(describeErrorChain(42), '42');
  });

  test('is cycle-safe, depth-bounded, redacted and capped', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    assert.equal(describeErrorChain(a), 'Error: a ← Error: b ← [circular cause]');

    let deep = new Error('L0');
    for (let i = 1; i <= 10; i++) deep = new Error(`L${i}`, { cause: deep });
    const text = describeErrorChain(deep, { maxDepth: 3 });
    assert.equal(text.split(' ← ').length, 3);

    const leaky = new Error('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 rejected');
    assert.doesNotMatch(describeErrorChain(leaky), /abcdefghijklmnopqrstuvwxyz0123456789/);

    const long = new Error('x'.repeat(2000));
    const capped = describeErrorChain(long);
    assert.ok(capped.length <= DEFAULT_MAX_LEN);
    assert.ok(capped.endsWith('…'));
  });
});
