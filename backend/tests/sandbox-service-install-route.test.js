'use strict';

// The remote sandbox microservice (services/sandbox) exposes
// POST /v1/sessions/:id/install for the backend's remote driver. Its own
// server.test.js is not part of CI, so the install contract is pinned here:
// re-validation of every field, the sandbox host's SANDBOX_PIP_NETWORK is
// authoritative over the client, the host network namespace is refused, and
// only a container-backed session can install.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SANDBOX_API_KEY = 'install-route-test-key';
process.env.SANDBOX_MAX_CONCURRENCY = '8';
delete process.env.SANDBOX_PIP_NETWORK;

const { buildServer, validateInstallBody, sessions } = require('../../services/sandbox/server');

const auth = { Authorization: `Bearer ${process.env.SANDBOX_API_KEY}`, 'Content-Type': 'application/json' };

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('validateInstallBody re-checks every field and the operator owns the installer network', (t) => {
  t.after(() => { delete process.env.SANDBOX_PIP_NETWORK; });
  const ok = validateInstallBody({ requirements: ['numpy==2.1'], allow: ['numpy'] });
  assert.equal(ok.value.network, 'bridge', 'default network');
  assert.equal(validateInstallBody({ requirements: ['numpy'], allow: ['numpy'], network: 'iliagpt-app' }).value.network, 'iliagpt-app');
  for (const body of [
    { requirements: [], allow: [] },
    { requirements: ['git+https://x/y'], allow: ['numpy'] },
    { requirements: ['numpy==1.0.tar.gz'], allow: ['numpy'] },
    { requirements: ['--index-url=https://evil'], allow: ['numpy'] },
    { requirements: ['numpy'], allow: ['Numpy; rm'] },
    { requirements: ['numpy'], allow: ['numpy'], indexUrl: 'ftp://x; rm -rf /' },
    { requirements: ['numpy'], allow: ['numpy'], network: 'host' },
    { requirements: ['numpy'], allow: ['numpy'], network: 'bad net' },
    { requirements: ['numpy'], allow: ['numpy'], tmpSize: '1g; echo' },
  ]) assert.ok(validateInstallBody(body).error, JSON.stringify(body));
  // The sandbox host's setting wins over whatever a client asks for.
  process.env.SANDBOX_PIP_NETWORK = 'pip-egress';
  assert.equal(validateInstallBody({ requirements: ['numpy'], allow: ['numpy'], network: 'bridge' }).value.network, 'pip-egress');
  // …and even the operator cannot hand the installer the host namespace.
  process.env.SANDBOX_PIP_NETWORK = 'host';
  assert.match(validateInstallBody({ requirements: ['numpy'], allow: ['numpy'] }).error, /network/);
});

test('POST /v1/sessions/:id/install authenticates, validates, needs a container and returns the installer verdict', async () => {
  sessions.clear();
  let captured = null;
  const server = buildServer({
    isDockerAvailable: async () => true,
    createSession: async () => ({ name: 'sira-doc-test', destroy: async () => {} }),
    installRunner: async (opts) => { captured = opts; return { ok: true, code: 'ok', installed: [{ name: 'numpy', version: '2.1' }], bytes: 10, durationMs: 5, detail: '' }; },
  });
  const base = await listen(server);
  try {
    const created = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: JSON.stringify({ workspaceKey: 'chat1' }) });
    const { sessionId } = await created.json();
    const install = (body, headers = auth) => fetch(`${base}/v1/sessions/${sessionId}/install`, { method: 'POST', headers, body: JSON.stringify(body) });

    const unauth = await install({}, { 'Content-Type': 'application/json' });
    assert.equal(unauth.status, 401);
    const bad = await install({ requirements: ['git+https://x'], allow: ['numpy'] });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_install_request');
    const hostNet = await install({ requirements: ['numpy'], allow: ['numpy'], network: 'host' });
    assert.equal(hostNet.status, 400);
    assert.equal(captured, null, 'nothing ran for a rejected request');

    const ok = await install({ requirements: ['numpy==2.1'], allow: ['numpy'], indexUrl: 'https://devpi.local/simple/', network: 'bridge', timeoutMs: 1, maxBytes: 1, tmpSize: '2g' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).code, 'ok');
    assert.equal(captured.kind, 'docker');
    assert.equal(captured.containerName, 'sira-doc-test');
    assert.deepEqual(captured.requirements, ['numpy==2.1']);
    assert.equal(captured.allowJson, '["numpy"]');
    assert.equal(captured.indexUrl, 'https://devpi.local/simple/');
    assert.equal(captured.network, 'bridge');
    assert.equal(captured.timeoutMs, 30_000, 'clamped');
    assert.equal(captured.maxBytes, 10 * 1024 * 1024, 'clamped');
    assert.equal(captured.tmpSize, '2g');
    await fetch(`${base}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
  } finally {
    await close(server);
    sessions.clear();
  }

  // A session without a container name (no docker container) cannot install.
  const nameless = buildServer({ isDockerAvailable: async () => true, createSession: async () => ({ destroy: async () => {} }) });
  const base2 = await listen(nameless);
  try {
    const created = await fetch(`${base2}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    const { sessionId } = await created.json();
    const res = await fetch(`${base2}/v1/sessions/${sessionId}/install`, { method: 'POST', headers: auth, body: JSON.stringify({ requirements: ['numpy'], allow: ['numpy'] }) });
    assert.equal(res.status, 409);
    await fetch(`${base2}/v1/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
  } finally {
    await close(nameless);
    sessions.clear();
  }
});
