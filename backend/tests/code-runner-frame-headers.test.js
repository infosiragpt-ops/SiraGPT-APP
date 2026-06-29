'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { PassThrough, Writable } = require('node:stream');
const request = require('supertest');

const { buildRouteTestApp, mockResolvedModule, reloadModule } = require('./http-test-utils');

test('code runner proxy allows same-origin iframe even when auth rejects', async () => {
  const app = buildRouteTestApp('/api/code-runner', reloadModule('../src/routes/code-runner'));

  const res = await request(app).get('/api/code-runner/run-1/proxy/');

  assert.equal(res.status, 401);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'");
});


test('token app proxy forwards the full Vite base path upstream', async () => {
  const hostRunnerPath = require.resolve('../src/services/code/host-runner');
  const restoreHostRunner = mockResolvedModule(hostRunnerPath, {
    enabled: () => true,
    startAllowed: () => true,
    getRunForProxy: () => ({ port: 43123 }),
    getStatus: () => null,
    stopRun: () => {},
  });

  const originalRequest = http.request;
  let upstreamOptions = null;
  http.request = (...args) => {
    const [options, callback] = args;
    if (options && options.hostname === '127.0.0.1' && Number(options.port) === 43123) {
      upstreamOptions = options;
      const upstream = new PassThrough();
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'text/javascript' };
      process.nextTick(() => {
        callback(upstream);
        upstream.end('ok');
      });
      return new Writable({ write(_chunk, _encoding, done) { done(); } });
    }
    return originalRequest.apply(http, args);
  };

  try {
    const app = buildRouteTestApp('/api/code-runner', reloadModule('../src/routes/code-runner'));
    const res = await request(app)
      .get('/api/code-runner/run-1/abcdef1234/app/@vite/client?direct=1')
      .set('Origin', 'null');

    assert.equal(res.status, 200);
    assert.equal(upstreamOptions.path, '/api/code-runner/run-1/abcdef1234/app/@vite/client?direct=1');
    assert.equal(upstreamOptions.port, 43123);
  } finally {
    http.request = originalRequest;
    restoreHostRunner();
  }
});
