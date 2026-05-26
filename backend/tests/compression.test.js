'use strict';

/**
 * Tests for middleware/compression.js
 *
 * These tests exercise the middleware against a minimal mock res that
 * mimics the parts of Node's ServerResponse we actually use (write/end,
 * setHeader/getHeader/removeHeader). For end-to-end coverage we also
 * spin up a real http.Server and verify that a Node http client decodes
 * the body correctly through both brotli and gzip.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const {
  compression,
  parseAcceptEncoding,
  selectEncoding,
  createMetrics,
  DEFAULT_THRESHOLD,
} = require('../src/middleware/compression');

// ─── Mock res helper ────────────────────────────────────────────────────────

function makeRes() {
  const headers = {};
  const writes = [];
  let ended = false;
  let endCallback = null;
  const res = {
    locals: {},
    statusCode: 200,
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete headers[String(name).toLowerCase()]; },
    write(chunk, encoding, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk
        : (typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : Buffer.from(chunk || []));
      writes.push(buf);
      if (typeof encoding === 'function') encoding(); else if (cb) cb();
      return true;
    },
    end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
      if (chunk != null && chunk.length !== 0) {
        const buf = Buffer.isBuffer(chunk) ? chunk
          : (typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : Buffer.from(chunk));
        writes.push(buf);
      }
      ended = true;
      endCallback = cb || null;
      if (cb) cb();
    },
    _state() {
      return {
        headers,
        body: Buffer.concat(writes),
        ended,
        writes,
        endCallback,
      };
    },
  };
  return res;
}

function makeReq(acceptEncoding) {
  return { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} };
}

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    mw(req, res, err => err ? reject(err) : resolve());
  });
}

// Wait until res.ended === true (compression streams finish async).
function waitForEnd(res, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (res._state().ended) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for res.end'));
      setImmediate(poll);
    })();
  });
}

// ─── Pure helper tests ──────────────────────────────────────────────────────

describe('parseAcceptEncoding', () => {
  it('parses simple encodings', () => {
    assert.deepEqual(parseAcceptEncoding('gzip, br'), [
      { name: 'gzip', q: 1 },
      { name: 'br', q: 1 },
    ]);
  });

  it('parses q-values', () => {
    assert.deepEqual(parseAcceptEncoding('br;q=0.8, gzip;q=1.0, deflate;q=0'), [
      { name: 'br', q: 0.8 },
      { name: 'gzip', q: 1.0 },
      { name: 'deflate', q: 0 },
    ]);
  });

  it('handles empty/missing input', () => {
    assert.deepEqual(parseAcceptEncoding(''), []);
    assert.deepEqual(parseAcceptEncoding(null), []);
    assert.deepEqual(parseAcceptEncoding(undefined), []);
  });

  it('lowercases encoding names', () => {
    assert.deepEqual(parseAcceptEncoding('GZIP, BR'), [
      { name: 'gzip', q: 1 },
      { name: 'br', q: 1 },
    ]);
  });
});

describe('selectEncoding', () => {
  it('prefers brotli when both offered with equal q', () => {
    assert.equal(selectEncoding('gzip, br', ['br', 'gzip']), 'br');
  });

  it('respects q-value over server priority', () => {
    assert.equal(selectEncoding('br;q=0.5, gzip;q=1.0', ['br', 'gzip']), 'gzip');
  });

  it('returns null when no allowed encoding matches', () => {
    assert.equal(selectEncoding('deflate, identity', ['br', 'gzip']), null);
  });

  it('honors q=0 as disallowed', () => {
    assert.equal(selectEncoding('br;q=0, gzip', ['br', 'gzip']), 'gzip');
  });

  it('expands * wildcard to allowed list', () => {
    assert.equal(selectEncoding('*', ['br', 'gzip']), 'br');
  });

  it('lets specific entry override wildcard', () => {
    assert.equal(selectEncoding('*;q=1, br;q=0', ['br', 'gzip']), 'gzip');
  });

  it('returns null on empty header', () => {
    assert.equal(selectEncoding('', ['br', 'gzip']), null);
    assert.equal(selectEncoding(null, ['br', 'gzip']), null);
  });

  it('SSE mode (only gzip allowed) ignores br offer', () => {
    assert.equal(selectEncoding('br, gzip', ['gzip']), 'gzip');
    assert.equal(selectEncoding('br', ['gzip']), null);
  });
});

// ─── Metrics ────────────────────────────────────────────────────────────────

describe('createMetrics', () => {
  it('records bytes_in/bytes_out per encoding', () => {
    const m = createMetrics();
    m.record('br', 1000, 200);
    m.record('br', 2000, 500);
    m.record('gzip', 1000, 400);

    const snap = m.snapshot();
    assert.equal(snap.encodings.br.count, 2);
    assert.equal(snap.encodings.br.bytesIn, 3000);
    assert.equal(snap.encodings.br.bytesOut, 700);
    assert.ok(Math.abs(snap.encodings.br.ratio - (700 / 3000)) < 1e-9);
    assert.equal(snap.encodings.gzip.count, 1);
  });

  it('tracks skipped + bypassed counts', () => {
    const m = createMetrics();
    m.recordSkipped(100);
    m.recordSkipped(50);
    m.recordBypassed();
    const snap = m.snapshot();
    assert.equal(snap.skipped.count, 2);
    assert.equal(snap.skipped.bytes, 150);
    assert.equal(snap.bypassed.count, 1);
  });

  it('reset() clears counters', () => {
    const m = createMetrics();
    m.record('br', 1, 1);
    m.reset();
    assert.deepEqual(m.snapshot().encodings, {});
  });
});

// ─── Middleware: buffered (JSON) path ───────────────────────────────────────

describe('compression middleware (buffered/JSON)', () => {
  it('compresses JSON above threshold with brotli when preferred', async () => {
    const metrics = createMetrics();
    const mw = compression({ metrics });
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({ data: 'x'.repeat(4000) });
    res.end(body);

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'br');
    assert.ok(!state.headers['content-length'], 'content-length should be removed');
    assert.match(String(state.headers['vary']), /Accept-Encoding/i);

    const decoded = zlib.brotliDecompressSync(state.body).toString('utf8');
    assert.equal(decoded, body);

    const snap = metrics.snapshot();
    assert.equal(snap.encodings.br.count, 1);
    assert.equal(snap.encodings.br.bytesIn, Buffer.byteLength(body));
    assert.ok(snap.encodings.br.bytesOut > 0);
    assert.ok(snap.encodings.br.bytesOut < snap.encodings.br.bytesIn,
      'compressed output should be smaller than input for repetitive content');
  });

  it('falls back to gzip when client only accepts gzip', async () => {
    const mw = compression();
    const req = makeReq('gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({ data: 'y'.repeat(4000) });
    res.end(body);

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'gzip');
    const decoded = zlib.gunzipSync(state.body).toString('utf8');
    assert.equal(decoded, body);
  });

  it('does NOT compress small responses below threshold', async () => {
    const metrics = createMetrics();
    const mw = compression({ metrics });
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    const small = JSON.stringify({ ok: true });
    res.setHeader('Content-Type', 'application/json');
    res.end(small);

    await waitForEnd(res);
    const state = res._state();
    assert.ok(!state.headers['content-encoding']);
    assert.equal(state.body.toString('utf8'), small);
    assert.equal(metrics.snapshot().skipped.count, 1);
    assert.equal(metrics.snapshot().skipped.bytes, Buffer.byteLength(small));
  });

  it('respects custom threshold', async () => {
    const mw = compression({ threshold: 8 });
    const req = makeReq('gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    const body = '{"hello":"world","more":true}'; // > 8 bytes
    res.end(body);

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(state.body).toString('utf8'), body);
  });

  it('bypasses already-compressed content types (image/png)', async () => {
    const metrics = createMetrics();
    const mw = compression({ metrics });
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'image/png');
    const body = Buffer.alloc(4000, 0xab);
    res.end(body);

    await waitForEnd(res);
    const state = res._state();
    assert.ok(!state.headers['content-encoding']);
    assert.deepEqual(state.body, body);
    assert.equal(metrics.snapshot().bypassed.count, 1);
  });

  it('bypasses application/octet-stream and pdf', async () => {
    for (const ct of ['application/octet-stream', 'application/pdf', 'application/zip']) {
      const mw = compression();
      const req = makeReq('br');
      const res = makeRes();
      await runMiddleware(mw, req, res);
      res.setHeader('Content-Type', ct);
      const body = Buffer.alloc(4000, 0x01);
      res.end(body);
      await waitForEnd(res);
      assert.ok(!res._state().headers['content-encoding'], `${ct} must be bypassed`);
    }
  });

  it('does not double-compress when Content-Encoding already set', async () => {
    const mw = compression();
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip'); // pretend upstream already gzipped
    const body = Buffer.alloc(4000, 0x77);
    res.end(body);

    await waitForEnd(res);
    const state = res._state();
    // We respect the existing encoding — body must be untouched.
    assert.equal(state.headers['content-encoding'], 'gzip');
    assert.deepEqual(state.body, body);
  });

  it('passes through when Accept-Encoding is missing', async () => {
    const mw = compression();
    const req = makeReq(null);
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({ x: 'z'.repeat(4000) });
    res.end(body);

    await waitForEnd(res);
    const state = res._state();
    assert.ok(!state.headers['content-encoding']);
    assert.equal(state.body.toString('utf8'), body);
  });

  it('passes through when client does not accept br/gzip', async () => {
    const mw = compression();
    const req = makeReq('deflate, identity');
    const res = makeRes();
    await runMiddleware(mw, req, res);
    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({ x: 'z'.repeat(4000) });
    res.end(body);
    await waitForEnd(res);
    assert.ok(!res._state().headers['content-encoding']);
  });

  it('appends Accept-Encoding to existing Vary header', async () => {
    const mw = compression();
    const req = makeReq('br');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Vary', 'Origin');
    res.end(JSON.stringify({ data: 'q'.repeat(4000) }));

    await waitForEnd(res);
    const state = res._state();
    assert.match(String(state.headers['vary']), /Origin/);
    assert.match(String(state.headers['vary']), /Accept-Encoding/i);
  });

  it('weakens strong ETags when compressing', async () => {
    const mw = compression();
    const req = makeReq('br');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('ETag', '"abc123"');
    res.end(JSON.stringify({ data: 'q'.repeat(4000) }));

    await waitForEnd(res);
    assert.equal(res._state().headers['etag'], 'W/"abc123"');
  });

  it('leaves weak ETags unchanged', async () => {
    const mw = compression();
    const req = makeReq('br');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('ETag', 'W/"abc123"');
    res.end(JSON.stringify({ data: 'q'.repeat(4000) }));

    await waitForEnd(res);
    assert.equal(res._state().headers['etag'], 'W/"abc123"');
  });

  it('honors res.locals.skipCompression opt-out', async () => {
    const mw = compression();
    const req = makeReq('br, gzip');
    const res = makeRes();
    res.locals.skipCompression = true;
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({ x: 'z'.repeat(4000) });
    res.end(body);

    await waitForEnd(res);
    assert.ok(!res._state().headers['content-encoding']);
    assert.equal(res._state().body.toString('utf8'), body);
  });

  it('handles multiple write() calls before end()', async () => {
    const mw = compression();
    const req = makeReq('br');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'application/json');
    const part1 = '{"a":"' + 'a'.repeat(2000) + '"';
    const part2 = ',"b":"' + 'b'.repeat(2000) + '"}';
    res.write(part1);
    res.end(part2);

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'br');
    const decoded = zlib.brotliDecompressSync(state.body).toString('utf8');
    assert.equal(decoded, part1 + part2);
  });
});

// ─── Middleware: SSE path ───────────────────────────────────────────────────

describe('compression middleware (SSE)', () => {
  it('uses gzip even when br is preferred (SSE)', async () => {
    const mw = compression();
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: hello\n\n');
    res.write('data: world\n\n');
    res.end();

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'gzip');
    const decoded = zlib.gunzipSync(state.body).toString('utf8');
    assert.equal(decoded, 'data: hello\n\ndata: world\n\n');
  });

  it('SSE skipped entirely when client only accepts br', async () => {
    const mw = compression();
    const req = makeReq('br');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: hi\n\n');
    res.end();
    await waitForEnd(res);
    const state = res._state();
    assert.ok(!state.headers['content-encoding']);
    assert.equal(state.body.toString('utf8'), 'data: hi\n\n');
  });
});

// ─── End-to-end via real http.Server ───────────────────────────────────────

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fetchRaw(server, headers) {
  const { port, address } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path: '/', method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('compression middleware (end-to-end http)', () => {
  it('integrates with real http.Server (brotli)', async () => {
    const mw = compression();
    const big = JSON.stringify({ data: 'x'.repeat(8000) });
    const server = await startServer((req, res) => {
      mw(req, res, () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(big);
      });
    });
    try {
      const r = await fetchRaw(server, { 'accept-encoding': 'br, gzip' });
      assert.equal(r.headers['content-encoding'], 'br');
      assert.equal(zlib.brotliDecompressSync(r.body).toString('utf8'), big);
      assert.match(String(r.headers['vary'] || ''), /Accept-Encoding/i);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('integrates with real http.Server (gzip)', async () => {
    const mw = compression();
    const big = JSON.stringify({ data: 'y'.repeat(8000) });
    const server = await startServer((req, res) => {
      mw(req, res, () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(big);
      });
    });
    try {
      const r = await fetchRaw(server, { 'accept-encoding': 'gzip' });
      assert.equal(r.headers['content-encoding'], 'gzip');
      assert.equal(zlib.gunzipSync(r.body).toString('utf8'), big);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('end-to-end SSE streaming with gzip flush per chunk', async () => {
    const mw = compression();
    const server = await startServer((req, res) => {
      mw(req, res, () => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: 1\n\n');
        res.write('data: 2\n\n');
        res.end('data: 3\n\n');
      });
    });
    try {
      const r = await fetchRaw(server, { 'accept-encoding': 'gzip' });
      assert.equal(r.headers['content-encoding'], 'gzip');
      const decoded = zlib.gunzipSync(r.body).toString('utf8');
      assert.equal(decoded, 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('end-to-end below threshold passes through uncompressed', async () => {
    const mw = compression();
    const server = await startServer((req, res) => {
      mw(req, res, () => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    try {
      const r = await fetchRaw(server, { 'accept-encoding': 'br, gzip' });
      assert.ok(!r.headers['content-encoding']);
      assert.equal(r.body.toString('utf8'), '{"ok":true}');
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});

describe('DEFAULT_THRESHOLD', () => {
  it('exports a sane default', () => {
    assert.equal(DEFAULT_THRESHOLD, 1024);
  });
});
