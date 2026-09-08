'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { isClientSocketGone, createClientGoneWriter } = require('../src/services/ai/sse-client-gone');
const ad = require('../src/services/agent-runner/engine-adapter');

function consumeBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    // express.json() resolves on 'end'; Node auto-destroys the request stream
    // right after, so give that a tick before the route "runs".
    req.on('end', () => setImmediate(() => resolve(body)));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('a consumed JSON body does not count as a gone client (Node >= 16 req.destroyed)', async () => {
  const seen = {};
  const server = http.createServer(async (req, res) => {
    await consumeBody(req);
    seen.reqDestroyed = req.destroyed;
    seen.gone = isClientSocketGone(req, res);
    let tripped = false;
    const writer = createClientGoneWriter(req, res, () => { tripped = true; });
    const rec = ad.destroySseOnClientClose(req, writer);
    seen.adapterCalledDestroy = rec.destroyed;
    seen.tripped = tripped;
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write('data: hello\n\n');
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  const body = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } },
      (res) => {
        let out = '';
        res.on('data', (chunk) => { out += chunk; });
        res.on('end', () => resolve(out));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ prompt: 'hola' }));
  });
  await new Promise((resolve) => server.close(resolve));

  assert.equal(seen.reqDestroyed, true, 'precondition: Node destroys req once the body is consumed');
  assert.equal(seen.adapterCalledDestroy, true, 'the 3H64 helper still fires on req.destroyed');
  assert.equal(seen.gone, false, 'an open socket is not a gone client');
  assert.equal(seen.tripped, false, 'the socket-aware writer must not mark the client gone');
  assert.equal(body, 'data: hello\n\ndata: [DONE]\n\n');
});

test('a real client disconnect is still detected', async () => {
  let resolveGone;
  const gone = new Promise((resolve) => { resolveGone = resolve; });
  const server = http.createServer(async (req, res) => {
    await consumeBody(req);
    createClientGoneWriter(req, res, () => resolveGone('writer'));
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(': ping\n\n');
    res.on('close', () => {
      if (!res.writableEnded) resolveGone(isClientSocketGone(req, res) ? 'socket' : 'not-gone');
    });
    // Never ends on purpose — the client hangs up.
  });
  const port = await listen(server);
  const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => {
    res.on('data', () => request.destroy());
  });
  request.on('error', () => {});
  request.end('{}');
  const how = await gone;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(how === 'socket' || how === 'writer', `expected the disconnect to be detected, got ${how}`);
});

test('generate route and shared SSE writer only trust the socket for client-gone', () => {
  const ai = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  const sse = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'sse-writer.js'), 'utf8');
  assert.match(ai, /createClientGoneWriter\(req, res, function \(\) \{ clientGone = true; \}\)/);
  assert.doesNotMatch(
    ai,
    /destroySseOnClientClose\(req, \{\s*close: function \(\) \{ clientGone = true; \}/,
    'the raw clientGone writer marked every generate as detached at entry',
  );
  assert.doesNotMatch(ai, /writer: res,/, 'never hand the live response to the 3H64 destroyer');
  assert.match(sse, /createClientGoneWriter\(options\.req, res/);
});
