'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getOpencodeConfig, isOpencodeConfigured, basicAuthHeader } = require('../src/services/opencode/opencode-config');
const { createOpencodeClient, OpencodeHttpError } = require('../src/services/opencode/opencode-client');

function fakeFetch(response = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      json: async () => (response.body !== undefined ? response.body : { ok: true }),
    };
  };
  fn.calls = calls;
  return fn;
}

// ── config ────────────────────────────────────────────────────────────────
test('isOpencodeConfigured is false without a server URL', () => {
  assert.equal(isOpencodeConfigured({ env: {} }), false);
});

test('getOpencodeConfig enables + normalises a valid URL', () => {
  const cfg = getOpencodeConfig({ env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/' } });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:4096'); // trailing slash stripped
  assert.equal(cfg.username, 'opencode'); // default
});

test('getOpencodeConfig rejects an invalid URL', () => {
  const cfg = getOpencodeConfig({ env: { OPENCODE_SERVER_URL: 'not a url' } });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'invalid_url');
});

test('basicAuthHeader is null without a password and Basic-encoded with one', () => {
  assert.equal(basicAuthHeader({ username: 'opencode', password: '' }), null);
  const h = basicAuthHeader({ username: 'opencode', password: 'pw' });
  assert.equal(h, 'Basic ' + Buffer.from('opencode:pw').toString('base64'));
});

// ── client ──────────────────────────────────────────────────────────────────
test('createOpencodeClient returns null when not configured', () => {
  assert.equal(createOpencodeClient({ env: {} }), null);
});

test('prompt() POSTs the message-parts shape with auth to the right URL', async () => {
  const fetchImpl = fakeFetch({ body: { id: 'm1' } });
  const client = createOpencodeClient({
    env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:4096', OPENCODE_SERVER_PASSWORD: 'pw' },
    fetchImpl,
  });
  await client.prompt('s1', 'hola');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:4096/session/s1/message');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Basic ' + Buffer.from('opencode:pw').toString('base64'));
  assert.deepEqual(JSON.parse(call.init.body).parts, [{ type: 'text', text: 'hola' }]);
});

test('createSession + listSessions hit /session; readFile passes the path query', async () => {
  const fetchImpl = fakeFetch({ body: {} });
  const client = createOpencodeClient({ env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' }, fetchImpl });
  await client.createSession();
  await client.listSessions();
  await client.readFile('src/index.ts');
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:4096/session');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[1].init.method, 'GET');
  assert.equal(fetchImpl.calls[2].url, 'http://127.0.0.1:4096/file?path=src%2Findex.ts');
  // no password → no Authorization header
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});

test('a non-ok response throws OpencodeHttpError carrying the status', async () => {
  const fetchImpl = fakeFetch({ ok: false, status: 500, body: { error: 'boom' } });
  const client = createOpencodeClient({ env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' }, fetchImpl });
  await assert.rejects(() => client.ping(), (err) => {
    assert.ok(err instanceof OpencodeHttpError);
    assert.equal(err.status, 500);
    assert.deepEqual(err.body, { error: 'boom' });
    return true;
  });
});

test('eventStreamUrl points at the SSE endpoint (/api/event, verified live)', () => {
  const client = createOpencodeClient({ env: { OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' }, fetchImpl: fakeFetch() });
  assert.equal(client.eventStreamUrl(), 'http://127.0.0.1:4096/api/event');
});
