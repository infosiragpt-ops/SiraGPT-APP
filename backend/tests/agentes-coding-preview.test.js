'use strict';

/**
 * agentes-coding/preview — signed exposePort + localhost metadata
 * (AGENTES_CODING_V2 Phase 3e). Injectable networking; no real bind,
 * no Daytona, no /code revival.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const preview = require('../src/services/agentes-coding/preview');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { createNetworkPolicy } = require('../src/services/agentes-coding/coding-sandbox/network');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');

let express = null;
let createAgentesCodingRouter = null;
try {
  express = require('express');
  ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
} catch (_) {
  express = null;
  createAgentesCodingRouter = null;
}

const ON = { AGENTES_CODING_V2: '1' };
const SECRET = 'test-preview-secret-32b!';

function sandbox(extra = {}) {
  return createCodingSandbox({
    env: { ...ON, ...(extra.env || {}) },
    autoGc: false,
    previewSecret: extra.previewSecret || SECRET,
    now: extra.now,
    driver: extra.driver,
    docker: extra.docker,
    networkHook: extra.networkHook,
    mapPort: extra.mapPort,
    previewTtlMs: extra.previewTtlMs,
    previewPublicBase: extra.previewPublicBase,
  });
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(
    err.message,
    /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|puerto|previa|caduc|inválid|Tope|token|publicar|exponer/i,
  );
  return true;
}

function tokenFromUrl(url) {
  const parts = String(url).split('/preview/');
  return decodeURIComponent(parts[1] || '');
}

test('flag off is E_FLAG_OFF in Spanish', async () => {
  const sb = createCodingSandbox({ env: {}, autoGc: false, previewSecret: SECRET });
  await assert.rejects(() => sb.exposePort('csb_x', 5173), (err) => spanishError(err, 'E_FLAG_OFF'));
});

test('exposePort denied by default without allowlist', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  await assert.rejects(() => sb.exposePort(session.id, 5173), (err) => spanishError(err, 'E_PORT_DENIED'));
});

test('host allowlist alone does not grant exposePort', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ networkAllowlist: ['127.0.0.1', 'localhost'] });
  await assert.rejects(() => sb.exposePort(session.id, 5173), (err) => spanishError(err, 'E_PORT_DENIED'));
});

test('port allowlist publishes a signed ephemeral URL', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [5173] });
  const exposed = await sb.exposePort(session.id, 5173);
  assert.equal(exposed.port, 5173);
  assert.equal(exposed.published, true);
  assert.equal(exposed.host, '127.0.0.1');
  assert.equal(exposed.hostPort, 5173);
  assert.match(exposed.url, new RegExp(`/sessions/${session.id}/preview/`));
  assert.ok(exposed.expiresAt > Date.now());
  assert.doesNotMatch(exposed.url, /OpenSandbox|e2b\.dev|daytona|model_id/i);
});

test('env AGENTES_CODING_PREVIEW_PORTS allowlists DEV ports', async () => {
  const sb = sandbox({ env: { AGENTES_CODING_PREVIEW_PORTS: '3000,5173' } });
  const session = await sb.createSession();
  const exposed = await sb.exposePort(session.id, 3000);
  assert.equal(exposed.port, 3000);
  assert.equal(exposed.published, true);
});

test('invalid port is E_PARAMS in Spanish', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [80] });
  await assert.rejects(() => sb.exposePort(session.id, 0), (err) => spanishError(err, 'E_PARAMS'));
  await assert.rejects(() => sb.exposePort(session.id, 70000), (err) => spanishError(err, 'E_PARAMS'));
  await assert.rejects(() => sb.exposePort(session.id, 'abc'), (err) => spanishError(err, 'E_PARAMS'));
});

test('injected mapPort supplies localhost-mapped metadata (no real bind)', async () => {
  const calls = [];
  const sb = sandbox({
    mapPort: ({ port, session }) => {
      calls.push({ port, driver: session.driver });
      return { host: '127.0.0.1', hostPort: 18000 + port, published: true, bind: false };
    },
  });
  const session = await sb.createSession({ previewPorts: [4173] });
  const exposed = await sb.exposePort(session.id, 4173);
  assert.equal(exposed.hostPort, 22173);
  assert.equal(exposed.host, '127.0.0.1');
  assert.equal(calls[0].driver, 'memory');
});

test('docker driver uses injectable inspectPort mapper', async () => {
  const docker = {
    async exec(args) {
      if (args[0] === 'run' || args[0] === 'rm') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const sb = sandbox({
    driver: 'docker',
    docker,
    mapPort: ({ port }) => ({ host: '127.0.0.1', hostPort: 19000 + port, published: true }),
  });
  const session = await sb.createSession({ previewPorts: [8080] });
  assert.equal(session.driver, 'docker');
  const exposed = await sb.exposePort(session.id, 8080);
  assert.equal(exposed.driver, 'docker');
  assert.equal(exposed.hostPort, 27080);
  assert.equal(exposed.published, true);
});

test('listPorts and unexposePort', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [5173, 4173] });
  await sb.exposePort(session.id, 5173);
  await sb.exposePort(session.id, 4173);
  const listed = sb.listPorts(session.id);
  assert.deepEqual(listed.map((p) => p.port).sort(), [4173, 5173]);
  const gone = sb.unexposePort(session.id, 5173);
  assert.equal(gone.ok, true);
  assert.deepEqual(sb.listPorts(session.id).map((p) => p.port), [4173]);
  assert.throws(() => sb.unexposePort(session.id, 5173), (err) => spanishError(err, 'E_PORT_DENIED'));
});

test('resolvePreview accepts the signed token and rejects tampering', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [5173] });
  const exposed = await sb.exposePort(session.id, 5173);
  const token = tokenFromUrl(exposed.url);
  const resolved = sb.resolvePreview(session.id, token);
  assert.equal(resolved.port, 5173);
  assert.equal(resolved.url, exposed.url);
  assert.throws(
    () => sb.resolvePreview(session.id, `${token}x`),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('expired preview token is E_PREVIEW_EXPIRED', async () => {
  let t = 1_000_000;
  const sb = sandbox({ now: () => t, previewTtlMs: 60_000 });
  const session = await sb.createSession({ previewPorts: [5173], ttlMs: 3_600_000 });
  const exposed = await sb.exposePort(session.id, 5173);
  const token = tokenFromUrl(exposed.url);
  t = 1_000_000 + 120_000;
  assert.throws(
    () => sb.resolvePreview(session.id, token),
    (err) => spanishError(err, 'E_PREVIEW_EXPIRED'),
  );
});

test('token for another session is E_SESSION_NOT_FOUND', async () => {
  const sb = sandbox();
  const a = await sb.createSession({ previewPorts: [5173] });
  const b = await sb.createSession({ previewPorts: [5173] });
  const exposed = await sb.exposePort(a.id, 5173);
  assert.throws(
    () => sb.resolvePreview(b.id, tokenFromUrl(exposed.url)),
    (err) => spanishError(err, 'E_SESSION_NOT_FOUND'),
  );
});

test('unexposed port rejects a still-valid token', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [5173] });
  const exposed = await sb.exposePort(session.id, 5173);
  const token = tokenFromUrl(exposed.url);
  sb.unexposePort(session.id, 5173);
  assert.throws(
    () => sb.resolvePreview(session.id, token),
    (err) => spanishError(err, 'E_PORT_DENIED'),
  );
});

test('more than eight exposed ports is E_QUOTA', async () => {
  const ports = Array.from({ length: preview.MAX_EXPOSED_PORTS }, (_, i) => 4000 + i);
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [...ports, 5000] });
  for (const port of ports) await sb.exposePort(session.id, port);
  await assert.rejects(() => sb.exposePort(session.id, 5000), (err) => spanishError(err, 'E_QUOTA'));
});

test('re-expose same port refreshes the signed URL', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ previewPorts: [5173] });
  const first = await sb.exposePort(session.id, 5173);
  const second = await sb.exposePort(session.id, 5173);
  assert.equal(second.port, 5173);
  assert.notEqual(second.url, first.url);
  assert.equal(sb.listPorts(session.id).length, 1);
});

test('sign/verify helpers reject a short secret and a bad token', () => {
  assert.throws(() => preview.signPreviewToken({ sid: 'x', port: 1 }, 'short'), (e) => e.code === 'E_PREVIEW_FAILED');
  const token = preview.signPreviewToken({
    sid: 'csb_a',
    port: 80,
    iat: Date.now(),
    exp: Date.now() + 60_000,
    n: 'ab',
  }, SECRET);
  assert.equal(preview.verifyPreviewToken(token, SECRET).sid, 'csb_a');
  assert.equal(preview.verifyPreviewToken('not-a-token', SECRET), null);
});

test('HTML stub is Spanish, iframe-ready, and has no vendor ids', () => {
  const html = preview.renderPreviewStub({ port: 5173, host: '127.0.0.1', hostPort: 5173 });
  assert.match(html, /lang="es"/);
  assert.match(html, /Vista previa/);
  assert.match(html, /5173/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /OpenSandbox|E2B|Daytona|OpenRouter|model_id/i);
});

test('network policy: port allowlist allows exposePort only', () => {
  const policy = createNetworkPolicy({ portAllowlist: [5173] });
  assert.equal(policy.allows({ action: 'exposePort', port: 5173 }), true);
  assert.equal(policy.allows({ action: 'exposePort', port: 3000 }), false);
  assert.equal(policy.allows({ host: 'example.com' }), false);
  assert.deepEqual(policy.portAllowlist, [5173]);
});

test('error catalog covers preview codes in Spanish', () => {
  for (const code of ['E_PORT_DENIED', 'E_PREVIEW_EXPIRED', 'E_PREVIEW_FAILED', 'E_FLAG_OFF']) {
    assert.ok(CATALOG[code], code);
    assert.match(CATALOG[code].message, /[A-Za-záéíóúñ]/);
  }
});

test('POST /sessions/:id/preview is 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const paths = [
      '/api/agentes-coding/sessions/csb_x/preview',
      '/api/agentes-coding/sessions/csb_x/ports',
    ];
    for (const urlPath of paths) {
      const { status, body } = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }));
        });
        req.on('error', reject);
        req.end('{"port":5173}');
      });
      assert.equal(status, 404, urlPath);
      assert.equal(body.error, 'not_found');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP expose + list + resolve + HTML stub when flag is on', { skip: !express }, async () => {
  const sb = sandbox();
  const session = await sb.createSession({ userId: 'coding-owner', previewPorts: [5173] });
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (method, urlPath, body, headers = {}) => new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const created = await request('POST', `/api/agentes-coding/sessions/${session.id}/preview`, { port: 5173 });
    assert.equal(created.status, 201);
    const payload = JSON.parse(created.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.exposed.port, 5173);
    assert.match(payload.exposed.url, /\/preview\//);
    const listed = await request('GET', `/api/agentes-coding/sessions/${session.id}/ports`);
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).ports.length, 1);
    const token = tokenFromUrl(payload.exposed.url);
    const resolved = await request('GET', `/api/agentes-coding/sessions/${session.id}/preview/${token}`);
    assert.equal(resolved.status, 200);
    assert.equal(JSON.parse(resolved.body).preview.port, 5173);
    const html = await request(
      'GET',
      `/api/agentes-coding/sessions/${session.id}/preview/${token}`,
      null,
      { Accept: 'text/html' },
    );
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.match(html.body, /Vista previa/);
    assert.doesNotMatch(html.body, /OpenRouter|Daytona|model_id/);
    const denied = await request('POST', `/api/agentes-coding/sessions/${session.id}/ports`, { port: 9 });
    assert.equal(denied.status, 403);
    assert.equal(JSON.parse(denied.body).error, 'E_PORT_DENIED');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts preview/ports and keeps flag 404 helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/preview/);
  assert.match(src, /\/sessions\/:id\/ports/);
  assert.match(src, /resolvePreview/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i);
});

test('unknown session is E_SESSION_NOT_FOUND', async () => {
  const sb = sandbox();
  await assert.rejects(() => sb.exposePort('csb_missing', 5173), (err) => spanishError(err, 'E_SESSION_NOT_FOUND'));
});

test('mapPort throw becomes E_PREVIEW_FAILED in Spanish', async () => {
  const sb = sandbox({
    mapPort: () => {
      throw new Error('mapper down');
    },
  });
  const session = await sb.createSession({ previewPorts: [5173] });
  await assert.rejects(() => sb.exposePort(session.id, 5173), (err) => spanishError(err, 'E_PREVIEW_FAILED'));
});
