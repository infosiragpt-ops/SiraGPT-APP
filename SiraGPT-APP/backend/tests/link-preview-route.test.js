'use strict';

/**
 * Route tests for /api/link-preview — fully offline. The router is built via
 * createRouter with injected fetchImpl + lookupImpl, so no network and no DNS
 * are ever touched. Each scenario swaps the mock behaviour through mutable
 * refs; URLs are unique per test so the in-router cache never cross-talks
 * (except in the explicit cache-hit test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createRouter, _internals } = require('../src/routes/link-preview');

// --- mutable mock behaviour ------------------------------------------------

let fetchCalls = [];
let fetchBehavior = async () => { throw new Error('fetchBehavior not set'); };
let lookupBehavior = async () => [{ address: '93.184.216.34', family: 4 }];

const fetchImpl = (...args) => {
  fetchCalls.push(args);
  return fetchBehavior(...args);
};
const lookupImpl = (...args) => lookupBehavior(...args);

// Short timeout so the timeout test stays fast; mocked fetches resolve
// immediately so the budget never trips elsewhere.
const router = createRouter({ fetchImpl, lookupImpl, timeoutMs: 80 });

let server;
let baseURL;

before(async () => {
  const app = express();
  app.use('/api/link-preview', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  fetchCalls = [];
  lookupBehavior = async () => [{ address: '93.184.216.34', family: 4 }];
});

function request(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseURL}${path}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function previewPath(url) {
  return `/api/link-preview/?url=${encodeURIComponent(url)}`;
}

/** Build a fetch-Response-like mock with a real getReader() body stream. */
function htmlResponse(html, { finalUrl, contentType = 'text/html; charset=utf-8', ok = true, status = 200 } = {}) {
  const data = Buffer.from(html, 'utf8');
  let consumed = false;
  return {
    ok,
    status,
    url: finalUrl,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: new Uint8Array(data) };
          },
          async cancel() {},
        };
      },
    },
  };
}

// --- bad input ---------------------------------------------------------------

test('400 on missing, unparsable and non-http(s) urls', async () => {
  for (const path of [
    '/api/link-preview/',
    previewPath('not a url at all'),
    previewPath('ftp://example.com/file'),
    previewPath('javascript:alert(1)'),
  ]) {
    const { status, json } = await request(path);
    assert.equal(status, 400, `expected 400 for ${path}`);
    assert.equal(json.error, 'invalid_url');
  }
  assert.equal(fetchCalls.length, 0);
});

// --- SSRF guard: literal hosts ------------------------------------------------

test('403 blocked_host for localhost / private / metadata literals, fetch never called', async () => {
  const blocked = [
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://127.8.9.10:8080/x',
    'http://0.0.0.0/',
    'http://10.0.0.5/internal',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/router',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://[::1]/',
    'http://printer.local/',
    'http://service.internal/api',
  ];
  for (const url of blocked) {
    const { status, json } = await request(previewPath(url));
    assert.equal(status, 403, `expected 403 for ${url}`);
    assert.equal(json.error, 'blocked_host');
  }
  assert.equal(fetchCalls.length, 0, 'no upstream fetch may happen for blocked hosts');
});

test('public 172.x outside 16-31 is NOT blocked at the host check', () => {
  assert.equal(_internals.isBlockedHost('172.15.0.1'), false);
  assert.equal(_internals.isBlockedHost('172.32.0.1'), false);
  assert.equal(_internals.isBlockedHost('8.8.8.8'), false);
  assert.equal(_internals.isBlockedHost('example.com'), false);
});

// --- SSRF guard: DNS re-check ---------------------------------------------------

test('403 blocked_host when DNS resolves a public-looking name to a private IP', async () => {
  lookupBehavior = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.1.2.3', family: 4 }, // rebinding attempt
  ];
  const { status, json } = await request(previewPath('https://rebind.example.test/'));
  assert.equal(status, 403);
  assert.equal(json.error, 'blocked_host');
  assert.equal(fetchCalls.length, 0);
});

test('403 blocked_host when DNS resolves to a private IPv6 address', async () => {
  lookupBehavior = async () => [{ address: 'fd00::1', family: 6 }];
  const { status, json } = await request(previewPath('https://rebind-v6.example.test/'));
  assert.equal(status, 403);
  assert.equal(json.error, 'blocked_host');
  assert.equal(fetchCalls.length, 0);
});

// --- happy path -------------------------------------------------------------------

test('og parse happy path: title + image + favicon resolved absolute vs final URL', async () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="  Una página de ejemplo  ">
    <meta property="og:image" content="/img/cover.png">
    <link rel="icon" href="assets/fav.svg">
    <title>fallback title (ignored)</title>
  </head><body>hola</body></html>`;
  fetchBehavior = async () => htmlResponse(html, { finalUrl: 'https://example.com/articles/42' });

  const { status, json } = await request(previewPath('https://example.com/articles/42'));
  assert.equal(status, 200);
  assert.deepEqual(json, {
    url: 'https://example.com/articles/42',
    title: 'Una página de ejemplo',
    imageUrl: 'https://example.com/img/cover.png',
    faviconUrl: 'https://example.com/articles/assets/fav.svg',
  });
  assert.equal(fetchCalls.length, 1);
  // The upstream fetch must follow redirects with an abort signal attached.
  const [, init] = fetchCalls[0];
  assert.equal(init.redirect, 'follow');
  assert.ok(init.signal, 'fetch must receive an AbortSignal');
});

test('missing og tags fall back to <title> and origin/favicon.ico; title capped at 200', async () => {
  const longTitle = 'T'.repeat(300);
  const html = `<html><head><title>${longTitle}</title></head><body></body></html>`;
  fetchBehavior = async () => htmlResponse(html, { finalUrl: 'https://plain.example.org/deep/page' });

  const { status, json } = await request(previewPath('https://plain.example.org/deep/page'));
  assert.equal(status, 200);
  assert.equal(json.title, 'T'.repeat(200));
  assert.equal(json.imageUrl, null);
  assert.equal(json.faviconUrl, 'https://plain.example.org/favicon.ico');
});

// --- content-type gate -----------------------------------------------------------

test('non-html content-type is rejected with 502', async () => {
  fetchBehavior = async () => htmlResponse('{"not":"html"}', {
    finalUrl: 'https://api.example.com/data.json',
    contentType: 'application/json',
  });
  const { status, json } = await request(previewPath('https://api.example.com/data.json'));
  assert.equal(status, 502);
  assert.equal(json.error, 'fetch_failed');
});

// --- timeout ----------------------------------------------------------------------

test('timeout aborts the fetch and responds 504 { error: "timeout" }', async () => {
  fetchBehavior = (url, init) => new Promise((resolve, reject) => {
    // Hang forever; only the router's abort budget can release us.
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const { status, json } = await request(previewPath('https://slow.example.net/'));
  assert.equal(status, 504);
  assert.deepEqual(json, { error: 'timeout' });
});

// --- network error -----------------------------------------------------------------

test('network failure responds 502 { error: "fetch_failed" }', async () => {
  fetchBehavior = async () => { throw new Error('ECONNRESET'); };
  const { status, json } = await request(previewPath('https://down.example.net/'));
  assert.equal(status, 502);
  assert.equal(json.error, 'fetch_failed');
});

// --- redirect landing on a private host ----------------------------------------------

test('redirect chain ending on a private final URL is blocked post-fetch', async () => {
  fetchBehavior = async () => htmlResponse('<html><head><title>x</title></head></html>', {
    finalUrl: 'http://169.254.169.254/latest/meta-data/',
  });
  const { status, json } = await request(previewPath('https://redirector.example.com/'));
  assert.equal(status, 403);
  assert.equal(json.error, 'blocked_host');
});

// --- cache -------------------------------------------------------------------------

test('second call for the same URL is served from cache with cached:true', async () => {
  const html = '<html><head><meta property="og:title" content="Cacheada"></head></html>';
  fetchBehavior = async () => htmlResponse(html, { finalUrl: 'https://cache.example.com/post' });

  const first = await request(previewPath('https://cache.example.com/post'));
  assert.equal(first.status, 200);
  assert.equal(first.json.title, 'Cacheada');
  assert.equal(first.json.cached, undefined);

  const second = await request(previewPath('https://cache.example.com/post'));
  assert.equal(second.status, 200);
  assert.equal(second.json.title, 'Cacheada');
  assert.equal(second.json.cached, true);

  assert.equal(fetchCalls.length, 1, 'upstream must be fetched exactly once');
});

// --- internals: capped reader --------------------------------------------------------

test('readBodyCapped stops at the byte cap', async () => {
  const big = 'a'.repeat(_internals.MAX_BODY_BYTES + 10_000);
  const response = htmlResponse(big, { finalUrl: 'https://big.example.com/' });
  const text = await _internals.readBodyCapped(response, _internals.MAX_BODY_BYTES);
  assert.equal(Buffer.byteLength(text, 'utf8'), _internals.MAX_BODY_BYTES);
});
