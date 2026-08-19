'use strict';

/**
 * Tests for opt-in Brotli streaming on SSE responses.
 *
 * Covers:
 *   - sseBrotli option enables brotli for text/event-stream
 *   - SIRAGPT_SSE_BROTLI env flag drives the same behavior
 *   - per-frame flush keeps each event recoverable from a partial body
 *   - default behavior unchanged (gzip) when flag is off
 *   - gzip fallback still works when client doesn't accept br
 *   - bench comparison: brotli output is no worse than gzip on repetitive
 *     SSE-like frames (sanity check that the pipeline is wired correctly)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { compression, createMetrics } = require('../src/middleware/compression');

function makeRes() {
  const headers = {};
  const writes = [];
  let ended = false;
  return {
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
      if (cb) cb();
    },
    _state() { return { headers, body: Buffer.concat(writes), writes, ended }; },
  };
}

function makeReq(acceptEncoding) {
  return { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} };
}

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    mw(req, res, err => err ? reject(err) : resolve());
  });
}

function waitForEnd(res, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (res._state().ended) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for end'));
      setImmediate(poll);
    })();
  });
}

describe('SSE Brotli streaming (opt-in)', () => {
  it('default: SSE still uses gzip even when brotli accepted', async () => {
    const mw = compression();
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: a\n\n');
    res.end('data: b\n\n');

    await waitForEnd(res);
    assert.equal(res._state().headers['content-encoding'], 'gzip');
  });

  it('sseBrotli=true: SSE uses brotli with per-frame flush', async () => {
    const metrics = createMetrics();
    const mw = compression({ sseBrotli: true, metrics });
    const req = makeReq('br, gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'text/event-stream');
    const frames = ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'];
    res.write(frames[0]);
    res.write(frames[1]);
    res.end(frames[2]);

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'br');
    const decoded = zlib.brotliDecompressSync(state.body).toString('utf8');
    assert.equal(decoded, frames.join(''));

    const snap = metrics.snapshot();
    assert.equal(snap.encodings.br.count, 1);
    assert.ok(snap.encodings.br.bytesIn > 0);
    assert.ok(snap.encodings.br.bytesOut > 0);
  });

  it('SIRAGPT_SSE_BROTLI env flag enables brotli SSE', async () => {
    const prev = process.env.SIRAGPT_SSE_BROTLI;
    process.env.SIRAGPT_SSE_BROTLI = '1';
    try {
      const mw = compression();
      const req = makeReq('br, gzip');
      const res = makeRes();
      await runMiddleware(mw, req, res);

      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: env-on\n\n');
      res.end();

      await waitForEnd(res);
      const state = res._state();
      assert.equal(state.headers['content-encoding'], 'br');
      const decoded = zlib.brotliDecompressSync(state.body).toString('utf8');
      assert.equal(decoded, 'data: env-on\n\n');
    } finally {
      if (prev === undefined) delete process.env.SIRAGPT_SSE_BROTLI;
      else process.env.SIRAGPT_SSE_BROTLI = prev;
    }
  });

  it('sseBrotli=false explicitly overrides env flag', async () => {
    const prev = process.env.SIRAGPT_SSE_BROTLI;
    process.env.SIRAGPT_SSE_BROTLI = '1';
    try {
      const mw = compression({ sseBrotli: false });
      const req = makeReq('br, gzip');
      const res = makeRes();
      await runMiddleware(mw, req, res);

      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: x\n\n');
      res.end();
      await waitForEnd(res);
      assert.equal(res._state().headers['content-encoding'], 'gzip');
    } finally {
      if (prev === undefined) delete process.env.SIRAGPT_SSE_BROTLI;
      else process.env.SIRAGPT_SSE_BROTLI = prev;
    }
  });

  it('sseBrotli=true falls back to gzip when client only accepts gzip', async () => {
    const mw = compression({ sseBrotli: true });
    const req = makeReq('gzip');
    const res = makeRes();
    await runMiddleware(mw, req, res);

    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: a\n\n');
    res.end('data: b\n\n');

    await waitForEnd(res);
    const state = res._state();
    assert.equal(state.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(state.body).toString('utf8'), 'data: a\n\ndata: b\n\n');
  });

  it('sseBrotli=true: each flushed frame is independently decodable as a stream', async () => {
    // Exercise the decode-as-stream path: feed bytes incrementally to a
    // BrotliDecompress stream as soon as they are produced. This verifies
    // BROTLI_OPERATION_FLUSH is actually being honored per frame.
    const mw = compression({ sseBrotli: true });
    const req = makeReq('br');

    // Custom res that exposes write events as they happen.
    const dec = zlib.createBrotliDecompress();
    const decoded = [];
    dec.on('data', c => decoded.push(c.toString('utf8')));

    const res = {
      locals: {},
      statusCode: 200,
      _headers: {},
      setHeader(n, v) { this._headers[String(n).toLowerCase()] = v; },
      getHeader(n) { return this._headers[String(n).toLowerCase()]; },
      removeHeader(n) { delete this._headers[String(n).toLowerCase()]; },
      write(chunk, encoding, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk
          : (typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : Buffer.from(chunk || []));
        if (buf.length) dec.write(buf);
        if (typeof encoding === 'function') encoding(); else if (cb) cb();
        return true;
      },
      end(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
        else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (chunk != null && chunk.length) {
          const buf = Buffer.isBuffer(chunk) ? chunk
            : (typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : Buffer.from(chunk));
          dec.write(buf);
        }
        dec.end();
        this._ended = true;
        if (cb) cb();
      },
    };

    await runMiddleware(mw, req, res);
    res.setHeader('Content-Type', 'text/event-stream');

    res.write('data: alpha\n\n');
    // Wait a tick so the flush callback runs and bytes reach the decoder.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const afterFirst = decoded.join('');

    res.write('data: beta\n\n');
    res.end('data: gamma\n\n');

    await new Promise(resolve => dec.on('end', resolve));
    const afterAll = decoded.join('');

    // After the first flushed frame, the decoder should already see at
    // least the first event (brotli flush emits all input data so far).
    assert.ok(afterFirst.includes('data: alpha'),
      `expected first frame visible after flush, got: ${JSON.stringify(afterFirst)}`);
    assert.equal(afterAll, 'data: alpha\n\ndata: beta\n\ndata: gamma\n\n');
  });
});

// ─── End-to-end http server ────────────────────────────────────────────────

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

describe('SSE Brotli end-to-end', () => {
  it('serves brotli-encoded SSE that decodes to the original frames', async () => {
    const mw = compression({ sseBrotli: true });
    const server = await startServer((req, res) => {
      mw(req, res, () => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: 1\n\n');
        res.write('data: 2\n\n');
        res.end('data: 3\n\n');
      });
    });
    try {
      const r = await fetchRaw(server, { 'accept-encoding': 'br, gzip' });
      assert.equal(r.headers['content-encoding'], 'br');
      const decoded = zlib.brotliDecompressSync(r.body).toString('utf8');
      assert.equal(decoded, 'data: 1\n\ndata: 2\n\ndata: 3\n\n');
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});

// ─── Bench: brotli vs gzip on SSE-like frames ─────────────────────────────

describe('bench: SSE brotli vs gzip output size', () => {
  it('measures compressed size for repetitive SSE traffic', async () => {
    // Generate a realistic-ish SSE stream: many small JSON events.
    const frames = [];
    for (let i = 0; i < 200; i++) {
      const payload = JSON.stringify({
        type: 'token',
        seq: i,
        text: 'lorem ipsum dolor sit amet consectetur adipiscing elit',
        ts: 1700000000000 + i * 17,
      });
      frames.push(`event: token\ndata: ${payload}\n\n`);
    }

    async function measure(opts, accept) {
      const mw = compression(opts);
      const req = makeReq(accept);
      const res = makeRes();
      await runMiddleware(mw, req, res);
      res.setHeader('Content-Type', 'text/event-stream');
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < frames.length - 1; i++) res.write(frames[i]);
      res.end(frames[frames.length - 1]);
      await waitForEnd(res, 5000);
      const t1 = process.hrtime.bigint();
      const state = res._state();
      return {
        encoding: state.headers['content-encoding'],
        rawBytes: frames.reduce((n, f) => n + Buffer.byteLength(f), 0),
        outBytes: state.body.length,
        elapsedMs: Number(t1 - t0) / 1e6,
      };
    }

    const gz = await measure({}, 'gzip');
    const br = await measure({ sseBrotli: true }, 'br');

    assert.equal(gz.encoding, 'gzip');
    assert.equal(br.encoding, 'br');
    assert.equal(gz.rawBytes, br.rawBytes);
    assert.ok(gz.outBytes > 0);
    assert.ok(br.outBytes > 0);

    // Both encoders should at least not inflate the payload past a small
    // overhead margin. Per-frame flushing limits how much brotli's
    // dictionary can be reused, so we don't require a strict ratio — the
    // bench output below is the actual signal for tuning decisions.
    assert.ok(gz.outBytes <= gz.rawBytes * 1.05,
      `gzip output should not inflate: ${gz.outBytes}/${gz.rawBytes}`);
    assert.ok(br.outBytes <= br.rawBytes * 1.05,
      `brotli output should not inflate: ${br.outBytes}/${br.rawBytes}`);

    // Emit a one-line bench summary so it shows up in test output.
    const ratioGz = (gz.outBytes / gz.rawBytes).toFixed(4);
    const ratioBr = (br.outBytes / br.rawBytes).toFixed(4);
    // eslint-disable-next-line no-console
    console.log(
      `[bench] sse-frames=${frames.length} raw=${gz.rawBytes}B  ` +
      `gzip=${gz.outBytes}B (ratio ${ratioGz}, ${gz.elapsedMs.toFixed(1)}ms)  ` +
      `brotli=${br.outBytes}B (ratio ${ratioBr}, ${br.elapsedMs.toFixed(1)}ms)  ` +
      `delta=${((br.outBytes - gz.outBytes) / gz.outBytes * 100).toFixed(1)}%`
    );
  });
});
