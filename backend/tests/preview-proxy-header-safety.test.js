'use strict';

// Regression guard: the same-origin preview reverse-proxies must never leak the
// caller's SiraGPT session credentials to the untrusted dev server, and must
// never let that untrusted origin set cookies back on the SiraGPT origin. Both
// code-runner.js and github.js route through these shared helpers.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpstreamRequestHeaders,
  isForwardableResponseHeader,
} = require('../src/utils/proxy-headers');

test('buildUpstreamRequestHeaders strips SiraGPT credentials before the dev server', () => {
  const headers = buildUpstreamRequestHeaders(
    {
      cookie: 'session=secret-session',
      authorization: 'Bearer secret-token',
      'proxy-authorization': 'Basic x',
      'user-agent': 'Mozilla/5.0',
      'x-forwarded-for': '203.0.113.7',
      accept: 'text/html',
      host: 'siragpt.com',
      'content-length': '123',
    },
    4321,
  );

  // Credentials must never reach the untrusted dev server.
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['proxy-authorization'], undefined);
  // Non-credential headers are forwarded unchanged.
  assert.equal(headers['user-agent'], 'Mozilla/5.0');
  assert.equal(headers['x-forwarded-for'], '203.0.113.7');
  assert.equal(headers.accept, 'text/html');
  // host is rewritten to the private dev server; content-length is dropped.
  assert.equal(headers.host, '127.0.0.1:4321');
  assert.equal(headers['content-length'], undefined);
});

test('buildUpstreamRequestHeaders strips credentials case-insensitively + hop-by-hop', () => {
  const headers = buildUpstreamRequestHeaders(
    { Cookie: 'session=secret', Authorization: 'Bearer t', Connection: 'keep-alive' },
    5555,
  );
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Connection, undefined);
  assert.equal(headers.host, '127.0.0.1:5555');
});

test('buildUpstreamRequestHeaders tolerates missing headers', () => {
  const headers = buildUpstreamRequestHeaders(undefined, 7000);
  assert.deepEqual(headers, { host: '127.0.0.1:7000' });
});

test('isForwardableResponseHeader blocks Set-Cookie, hop-by-hop, and CSP', () => {
  assert.equal(isForwardableResponseHeader('set-cookie'), false);
  assert.equal(isForwardableResponseHeader('connection'), false);
  assert.equal(isForwardableResponseHeader('transfer-encoding'), false);
  assert.equal(isForwardableResponseHeader('content-security-policy'), false);
  // Ordinary response headers still pass through.
  assert.equal(isForwardableResponseHeader('content-type'), true);
  assert.equal(isForwardableResponseHeader('cache-control'), true);
});
