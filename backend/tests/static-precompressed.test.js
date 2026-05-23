'use strict';

/**
 * Tests for middleware/static-precompressed.js
 *
 * Spins up a real http.Server with the middleware mounted, populates a
 * temp directory with original + .br / .gz siblings, and exercises the
 * negotiation matrix end-to-end.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const {
  servePrecompressed,
  selectEncoding,
  parseAcceptEncoding,
  resolveSafePath,
  inferContentType,
} = require('../src/middleware/static-precompressed');

// ─── Helpers ────────────────────────────────────────────────────────────────

async function makeTempRoot() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'static-precompressed-'));
  return dir;
}

async function writeAssetTriplet(root, relPath, body) {
  const full = path.join(root, relPath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, body);
  await fsp.writeFile(full + '.br', zlib.brotliCompressSync(Buffer.from(body)));
  await fsp.writeFile(full + '.gz', zlib.gzipSync(Buffer.from(body)));
}

function buildServer(middleware, fallback) {
  const fallbackHandler = fallback || ((req, res) => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('not found');
  });
  return http.createServer((req, res) => {
    // Express-like req.path = pathname without query.
    const u = new URL(req.url, 'http://localhost');
    req.path = u.pathname;
    middleware(req, res, (err) => {
      if (err) {
        res.statusCode = 500;
        res.end(String(err && err.message ? err.message : err));
        return;
      }
      fallbackHandler(req, res);
    });
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Pure helper tests ──────────────────────────────────────────────────────

describe('static-precompressed: helpers', () => {
  it('parseAcceptEncoding handles q-values and `*` wildcard', () => {
    assert.deepEqual(parseAcceptEncoding(''), []);
    assert.deepEqual(parseAcceptEncoding('br, gzip;q=0.5, *;q=0'),
      [{ name: 'br', q: 1 }, { name: 'gzip', q: 0.5 }, { name: '*', q: 0 }]);
  });

  it('selectEncoding picks server-priority winner among allowed', () => {
    assert.equal(selectEncoding('gzip, br', ['br', 'gzip']), 'br');
    assert.equal(selectEncoding('gzip;q=0.9, br;q=0.5', ['br', 'gzip']), 'gzip');
    assert.equal(selectEncoding('br;q=0', ['br', 'gzip']), null);
    assert.equal(selectEncoding('*;q=0.8', ['br', 'gzip']), 'br');
    assert.equal(selectEncoding('identity', ['br', 'gzip']), null);
  });

  it('inferContentType maps common static extensions', () => {
    assert.equal(inferContentType('foo.html'), 'text/html; charset=utf-8');
    assert.equal(inferContentType('foo.JS'), 'application/javascript; charset=utf-8');
    assert.equal(inferContentType('foo.svg'), 'image/svg+xml');
    assert.equal(inferContentType('foo.unknown'), 'application/octet-stream');
  });

  it('resolveSafePath rejects traversal and null bytes', () => {
    const root = path.resolve('/tmp/whatever-root');
    assert.equal(resolveSafePath(root, '/../etc/passwd'), null);
    assert.equal(resolveSafePath(root, '/foo\0bar'), null);
    const ok = resolveSafePath(root, '/sub/file.js');
    assert.equal(ok, path.join(root, 'sub', 'file.js'));
  });

  it('throws on missing root or unsupported encoding', () => {
    assert.throws(() => servePrecompressed({}), /root/);
    assert.throws(
      () => servePrecompressed({ root: '/tmp', encodings: ['lzma'] }),
      /unsupported encoding/,
    );
  });
});

// ─── End-to-end via real http server ────────────────────────────────────────

describe('static-precompressed: end-to-end', () => {
  let root;
  let server;
  let port;
  let fallbackCalls = 0;

  before(async () => {
    root = await makeTempRoot();

    // Big enough to make compression worthwhile.
    const bigBody = 'a'.repeat(4096) + '\nhello\n';
    await writeAssetTriplet(root, 'app.js', bigBody);
    await writeAssetTriplet(root, 'styles/site.css', '.x { color: red; }\n'.repeat(200));

    // File with only an original (no precompressed siblings).
    await fsp.writeFile(path.join(root, 'plain.txt'), 'plaintext');
    // Stray .br with no source — must NOT be served.
    await fsp.writeFile(path.join(root, 'orphan.js.br'),
      zlib.brotliCompressSync(Buffer.from('orphan')));

    const middleware = servePrecompressed({ root });
    server = buildServer(middleware, (req, res) => {
      fallbackCalls += 1;
      res.statusCode = 200;
      res.setHeader('X-Fallback', '1');
      res.setHeader('Content-Type', 'text/plain');
      res.end('FALLBACK');
    });
    port = await listen(server);
  });

  after(async () => {
    if (server) await close(server);
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  it('serves .br when client accepts brotli', async () => {
    const r = await request(port, '/app.js', { 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.match(r.headers['vary'] || '', /accept-encoding/i);
    assert.ok(r.headers['etag'] && r.headers['etag'].startsWith('W/"'));
    const decoded = zlib.brotliDecompressSync(r.body).toString('utf8');
    assert.match(decoded, /hello/);
    assert.equal(Number(r.headers['content-length']), r.body.length);
  });

  it('falls back to .gz when brotli is disallowed', async () => {
    const r = await request(port, '/app.js', { 'accept-encoding': 'gzip, br;q=0' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    const decoded = zlib.gunzipSync(r.body).toString('utf8');
    assert.match(decoded, /hello/);
  });

  it('passes through to next() when no Accept-Encoding matches', async () => {
    const before = fallbackCalls;
    const r = await request(port, '/app.js', { 'accept-encoding': 'identity' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-fallback'], '1');
    assert.equal(fallbackCalls, before + 1);
    assert.equal(r.body.toString('utf8'), 'FALLBACK');
  });

  it('passes through when no precompressed sibling exists', async () => {
    const r = await request(port, '/plain.txt', { 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-fallback'], '1');
    assert.equal(r.headers['content-encoding'], undefined);
  });

  it('does NOT serve a stray .br without a matching source file', async () => {
    const r = await request(port, '/orphan.js', { 'accept-encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-fallback'], '1');
  });

  it('rejects path traversal — falls through to next()', async () => {
    const r = await request(port, '/../package.json', { 'accept-encoding': 'br' });
    // The url resolver normalizes to /package.json by the time it reaches
    // the server, so the negative test that matters is the explicit
    // resolveSafePath unit test above. Here we just verify no precompressed
    // hit is served outside root.
    assert.notEqual(r.headers['content-encoding'], 'br');
  });

  it('HEAD returns headers without body', async () => {
    const r = await request(port, '/app.js', { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.ok(Number(r.headers['content-length']) > 0);
    assert.equal(r.body.length, 0);
  });

  it('honors If-None-Match with the weak ETag → 304', async () => {
    const first = await request(port, '/app.js', { 'accept-encoding': 'br' });
    assert.equal(first.status, 200);
    const etag = first.headers['etag'];
    assert.ok(etag);
    const second = await request(port, '/app.js', {
      'accept-encoding': 'br',
      'if-none-match': etag,
    });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
  });

  it('skips when an upstream Content-Encoding is already set', async () => {
    const middleware = servePrecompressed({ root });
    const upstream = (req, res, next) => {
      res.setHeader('Content-Encoding', 'identity');
      next();
    };
    let fellThrough = false;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      req.path = u.pathname;
      upstream(req, res, () => {
        middleware(req, res, () => {
          fellThrough = true;
          res.statusCode = 200;
          res.end('downstream');
        });
      });
    });
    const p = await listen(srv);
    try {
      const r = await request(p, '/app.js', { 'accept-encoding': 'br' });
      assert.equal(r.status, 200);
      assert.equal(fellThrough, true);
      assert.equal(r.headers['content-encoding'], 'identity');
    } finally {
      await close(srv);
    }
  });

  it('non-GET/HEAD methods fall through', async () => {
    // Use the same mounted server; POST should hit fallback.
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/app.js', method: 'POST',
        headers: { 'accept-encoding': 'br', 'content-length': '0' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.headers['x-fallback'], '1');
  });

  it('respects custom encodings list (gzip-only)', async () => {
    const mw = servePrecompressed({ root, encodings: ['gzip'] });
    const srv = buildServer(mw);
    const p = await listen(srv);
    try {
      const r = await request(p, '/app.js', { 'accept-encoding': 'br, gzip' });
      assert.equal(r.headers['content-encoding'], 'gzip');
    } finally {
      await close(srv);
    }
  });

  it('invokes the setHeaders hook with metadata', async () => {
    let captured = null;
    const mw = servePrecompressed({
      root,
      setHeaders: (res, filePath, info) => {
        captured = { filePath, info };
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    const srv = buildServer(mw);
    const p = await listen(srv);
    try {
      const r = await request(p, '/styles/site.css', { 'accept-encoding': 'br' });
      assert.equal(r.headers['content-encoding'], 'br');
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.ok(captured && captured.info && captured.info.encoding === 'br');
      assert.ok(captured.filePath.endsWith(path.join('styles', 'site.css')));
    } finally {
      await close(srv);
    }
  });

  it('handles nested paths and infers content-type from original ext', async () => {
    const r = await request(port, '/styles/site.css', { 'accept-encoding': 'br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['content-type'], 'text/css; charset=utf-8');
  });
});
