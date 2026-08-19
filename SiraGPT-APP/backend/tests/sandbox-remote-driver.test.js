'use strict';

/**
 * Remote driver (sandbox/remote-driver.js) ↔ /v1/sessions microservice — offline.
 *
 * Boots the REAL services/sandbox/server.js on a random localhost port with the
 * docker session factory swapped for the backend local sandbox (no Docker),
 * then exercises the REWRITTEN executeRemote (session-per-call protocol):
 * happy path, recursive file sync up/down, helper-script hygiene, timeout,
 * error classification (auth / server / unreachable) and router fall-through
 * semantics (ONLY remote_unreachable falls through to local).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// The service refuses to start without a key — set it BEFORE requiring it.
const KEY = 'test-remote-driver-key-' + Math.random().toString(36).slice(2);
process.env.SANDBOX_API_KEY = KEY;

const { buildServer, sessions } = require('../../services/sandbox/server');
const { createSandbox } = require('../src/services/doc-agent/sandbox');
const { executeRemote, resolveRemoteConfig } = require('../src/services/sandbox/remote-driver');
const router = require('../src/services/sandbox/router');

let server;
let base;

function envFor(extra = {}) {
  return { SANDBOX_SERVICE_URL: base, SANDBOX_API_KEY: KEY, ...extra };
}

before(async () => {
  server = buildServer({
    createSession: () => createSandbox({ driver: 'local' }),
    isDockerAvailable: async () => true,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { try { server.close(); } catch (_) {} });

test('happy path: python runs remotely, result mapped, session destroyed', async () => {
  const out = await executeRemote({ language: 'python', code: 'print("hola remota")' }, envFor());
  assert.equal(out.ok, true);
  assert.equal(out.backend, 'remote');
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /hola remota/);
  assert.equal(sessions.size, 0, 'ephemeral session must be destroyed after the call');
});

test('file sync: nested workdir files go up, edits come back down, helper never leaks', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-sync-'));
  try {
    fs.mkdirSync(path.join(workdir, 'tmp/x/word'), { recursive: true });
    fs.writeFileSync(path.join(workdir, 'tmp/x/word/document.xml'), '<w:t>Informe Preliminar</w:t>');
    fs.writeFileSync(path.join(workdir, 'notes.txt'), 'base');

    // Paths are RELATIVE to the sandbox cwd (/workspace in the container,
    // the temp root under the offline local driver) — that's the tool contract.
    const out = await executeRemote({
      language: 'bash',
      code: [
        "grep -q 'Informe Preliminar' tmp/x/word/document.xml",
        "printf '<w:t>Informe Final</w:t>' > tmp/x/word/document.xml",
        'echo editado >> notes.txt',
        'echo nuevo > tmp/x/extra.txt',
      ].join('\n'),
      workdir,
    }, envFor(), {});
    assert.equal(out.ok, true, out.stderr);

    // Edits to NESTED paths must round-trip back into the local workdir.
    assert.match(fs.readFileSync(path.join(workdir, 'tmp/x/word/document.xml'), 'utf8'), /Informe Final/);
    assert.match(fs.readFileSync(path.join(workdir, 'notes.txt'), 'utf8'), /editado/);
    assert.equal(fs.readFileSync(path.join(workdir, 'tmp/x/extra.txt'), 'utf8').trim(), 'nuevo');

    // The __sira_exec helper script must never appear in the local workdir.
    const all = fs.readdirSync(workdir);
    assert.ok(!all.some((n) => n.startsWith('__sira_exec')), `helper leaked: ${all}`);

    // A SECOND call must see the previous edits (upload is recursive).
    const verify = await executeRemote({
      language: 'bash',
      code: 'cat tmp/x/word/document.xml',
      workdir,
    }, envFor());
    assert.match(verify.stdout, /Informe Final/);
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test('timeout maps to sandbox_timeout with exit 124 (never fake success)', async () => {
  const out = await executeRemote({ language: 'bash', code: 'sleep 5', timeoutMs: 1100 }, envFor());
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_timeout');
  assert.equal(out.exitCode, 124);
  assert.equal(sessions.size, 0);
});

test('401 classifies as remote_auth_error and the router does NOT fall through', async () => {
  const env = envFor({ SANDBOX_API_KEY: 'wrong-key', LOCAL_SANDBOX_ENABLED: '1' });
  const direct = await executeRemote({ language: 'bash', code: 'echo nope' }, env);
  assert.equal(direct.code, 'remote_auth_error');
  assert.equal(direct.ok, false);

  const routed = await router.executeCode({ language: 'bash', code: 'echo nope' }, env);
  assert.equal(routed.backend, 'remote', 'auth errors are terminal — must not silently run locally');
  assert.equal(routed.code, 'remote_auth_error');
});

test('connection refused classifies as remote_unreachable and router falls through to local', async () => {
  const env = { SANDBOX_SERVICE_URL: 'http://127.0.0.1:1', SANDBOX_API_KEY: 'k', LOCAL_SANDBOX_ENABLED: '1' };
  const direct = await executeRemote({ language: 'bash', code: 'echo hi' }, env);
  assert.equal(direct.code, 'remote_unreachable');

  const routed = await router.executeCode({ language: 'bash', code: 'echo hi' }, env);
  assert.equal(routed.backend, 'local', 'unreachable (and ONLY unreachable) falls through');
  assert.equal(routed.ok, true);
  assert.match(String(routed.stdout || ''), /hi/);
});

test('a 404-ing service is a remote_server_error — never parsed as success', async () => {
  // Fake service: session create works, then everything 404s (e.g. the session
  // was reaped by TTL or a service restart mid-flow).
  const fake = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/sessions') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: 'gone-soon', ttlMs: 1000 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_not_found' }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const env = {
      SANDBOX_SERVICE_URL: `http://127.0.0.1:${fake.address().port}`,
      SANDBOX_API_KEY: 'k',
      LOCAL_SANDBOX_ENABLED: '1',
    };
    const out = await executeRemote({ language: 'bash', code: 'echo x' }, env);
    assert.equal(out.ok, false, 'a 404 must NEVER be reported as a successful run');
    assert.equal(out.code, 'remote_server_error');

    const routed = await router.executeCode({ language: 'bash', code: 'echo x' }, env);
    assert.equal(routed.backend, 'remote', 'server errors are terminal — no silent local rerun');
    assert.equal(routed.code, 'remote_server_error');
  } finally {
    fake.close();
  }
});

test('node is rejected up-front (runner image has no node) without any network call', async () => {
  const out = await executeRemote(
    { language: 'node', code: 'console.log(1)' },
    { SANDBOX_SERVICE_URL: 'http://127.0.0.1:1', SANDBOX_API_KEY: 'k' }, // would explode if contacted
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'sandbox_language_not_allowed');
  assert.match(out.stderr, /python, bash/);
});

test('config reader: enabled only with both url+key; remoteOnly flag parsed', () => {
  assert.equal(resolveRemoteConfig({}).enabled, false);
  assert.equal(resolveRemoteConfig({ SANDBOX_SERVICE_URL: 'x' }).enabled, false);
  const cfg = resolveRemoteConfig({ SANDBOX_SERVICE_URL: 'x', SANDBOX_API_KEY: 'y', SANDBOX_REMOTE_ONLY: 'true' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.remoteOnly, true);
});

test('config reader: a non-numeric timeout env yields a finite default, never NaN', () => {
  // A NaN timeoutMs propagated to AbortSignal.timeout(NaN) and crashed the
  // remote exec. The reader must clamp to a finite default.
  for (const raw of ['abc', '', '  ', 'NaN']) {
    const cfg = resolveRemoteConfig({ SANDBOX_SERVICE_URL: 'x', SANDBOX_API_KEY: 'y', SANDBOX_REMOTE_TIMEOUT_MS: raw });
    assert.ok(Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0, `timeoutMs must be finite for ${JSON.stringify(raw)}, got ${cfg.timeoutMs}`);
  }
  // A valid numeric override is honoured.
  assert.equal(resolveRemoteConfig({ SANDBOX_SERVICE_URL: 'x', SANDBOX_API_KEY: 'y', SANDBOX_REMOTE_TIMEOUT_MS: '12345' }).timeoutMs, 12345);
});
