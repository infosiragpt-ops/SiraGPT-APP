'use strict';

// Prod 2026-10-03: every SIGTERM logged `shutdown_step_fail · http_server_close
// timed out after 5000ms` because server.close() waits for keep-alive
// sockets (keepAliveTimeout = 120 s) and open SSE streams. closeHttpServer
// must resolve inside the grace window with those sockets cut.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const { closeHttpServer, DEFAULT_GRACE_MS, graceFromEnv } = require('../src/utils/http-server-close');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.keepAliveTimeout = 120_000;
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('closes within the grace window while an SSE stream and an idle keep-alive socket are open', async () => {
  const server = await listen((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write('data: hello\n\n');
      return; // never ends
    }
    res.writeHead(200, { Connection: 'keep-alive' });
    res.end('ok');
  });
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true });

  // One idle keep-alive socket …
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  // … and one SSE stream that stays open.
  const sseClosed = new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/sse' }, (res) => {
      res.on('data', () => {});
      res.on('close', resolve);
      res.on('end', resolve);
    });
    req.on('error', resolve);
  });
  await new Promise((r) => setTimeout(r, 50));

  const cuts = [];
  const t0 = Date.now();
  const outcome = await closeHttpServer(server, { graceMs: 150, onCut: (n) => cuts.push(n) });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2000, `must settle inside the budget, took ${elapsed} ms`);
  assert.equal(outcome.closed, true);
  assert.ok(outcome.cut >= 1, 'the SSE socket was cut');
  assert.deepEqual(cuts, [outcome.cut]);
  await sseClosed;
  assert.equal(server.listening, false);
  agent.destroy();
  await new Promise((resolve) => {
    const probe = net.connect(port, '127.0.0.1');
    probe.on('error', () => resolve());
    probe.on('connect', () => { probe.destroy(); resolve(); });
  });
});

test('a server with no connections resolves via the close callback before the grace timer', async () => {
  const server = await listen((_req, res) => res.end('ok'));
  const t0 = Date.now();
  const outcome = await closeHttpServer(server, { graceMs: 5000 });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(outcome, { closed: true, cut: 0 });
});

test('never rejects: a server whose close() throws resolves closed:false', async () => {
  const outcome = await closeHttpServer({ close() { throw new Error('boom'); } }, { graceMs: 10 });
  assert.deepEqual(outcome, { closed: false, cut: 0 });
  assert.deepEqual(await closeHttpServer(null), { closed: false, cut: 0 });
});

test('grace comes from SIRAGPT_HTTP_CLOSE_GRACE_MS and stays under the 5 s step budget by default', () => {
  assert.equal(graceFromEnv({}), DEFAULT_GRACE_MS);
  assert.ok(DEFAULT_GRACE_MS < 5000);
  assert.equal(graceFromEnv({ SIRAGPT_HTTP_CLOSE_GRACE_MS: '800' }), 800);
  assert.equal(graceFromEnv({ SIRAGPT_HTTP_CLOSE_GRACE_MS: '-1' }), DEFAULT_GRACE_MS);
});

test('index.js registers http_server_close through closeHttpServer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /shutdownRegistry\.register\('http_server_close', \(\) => closeHttpServer\(server/);
  assert.match(src, /require\('\.\/src\/utils\/http-server-close'\)/);
});
