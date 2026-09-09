'use strict';

/**
 * agentes-coding/export + deploy — zip/tarball + Coolify/Dokploy stub
 * (AGENTES_CODING_V2 Phase 3g). Injectable HTTP only; no real Coolify,
 * no Daytona, no host dump.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');

const sessionExport = require('../src/services/agentes-coding/export');
const archive = require('../src/services/agentes-coding/export/archive');
const sessionDeploy = require('../src/services/agentes-coding/deploy');
const deployClient = require('../src/services/agentes-coding/deploy/client');
const allowlist = require('../src/services/agentes-coding/deploy/allowlist');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');
const { jailRelPath } = require('../src/services/agentes-coding/coding-sandbox/path-jail');

const ON = { AGENTES_CODING_V2: '1' };
const COOLIFY = 'https://coolify.test';

let express = null;
let createAgentesCodingRouter = null;
try {
  express = require('express');
  ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
} catch (_) {
  express = null;
  createAgentesCodingRouter = null;
}

function sandbox(extra = {}) {
  return createCodingSandbox({
    env: { ...ON, ...(extra.env || {}) },
    autoGc: false,
    ...extra,
  });
}

async function seeded(files = {
  'src/app.ts': 'export const n = 1;\n',
  'README.md': '# demo\n',
}) {
  const sb = sandbox();
  const session = await sb.createSession();
  for (const [p, body] of Object.entries(files)) {
    await sb.writeFile(session.id, p, body);
  }
  return { sb, session };
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(
    err.message,
    /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|ruta|export|despliegue|allowlist|válid|tiempo|Tope|archivo|proveedor|cliente/i,
  );
  return true;
}

function fakeHttp(impl) {
  const calls = [];
  const run = async (req) => {
    calls.push(req);
    if (typeof impl === 'function') return impl(req, calls);
    return impl || { ok: true, status: 200, body: { ok: true } };
  };
  run.calls = calls;
  return run;
}

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('implementation stays a native stub (no banned vendors, no /code, no dump)', () => {
  const roots = [
    path.join(__dirname, '../src/services/agentes-coding/export'),
    path.join(__dirname, '../src/services/agentes-coding/deploy'),
  ];
  for (const root of roots) {
    for (const file of fs.readdirSync(root)) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i, file);
      assert.doesNotMatch(src, /require\(['"]archiver['"]\)/, file);
      assert.doesNotMatch(src, /sk-[A-Za-z0-9]{10,}/, file);
      assert.doesNotMatch(src, /globalThis\.fetch|require\(['"]node-fetch['"]\)/, file);
    }
  }
});

test('error catalog includes export/deploy codes in Spanish', () => {
  for (const code of [
    'E_EXPORT_FAILED',
    'E_EXPORT_NOT_FOUND',
    'E_DEPLOY_DENIED',
    'E_DEPLOY_FAILED',
    'E_DEPLOY_NOT_FOUND',
  ]) {
    assert.ok(CATALOG[code], code);
    assert.match(CATALOG[code].message, /[áéíóúñÁÉÍÓÚÑ]|export|despliegue|allowlist|artefacto|intención|proveedor/i);
  }
  assert.match(CATALOG.E_FLAG_OFF.message, /desactiv/i);
});

test('exportForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => sessionExport.exportForRequest(sb, 'csb_x', {}, { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('deployForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => sessionDeploy.deployForRequest(sb, 'csb_x', {}, { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('export zip of a jailed workspace returns metadata + artifact path', async () => {
  const { sb, session } = await seeded();
  const out = await sessionExport.exportSession(sb, session.id, { env: ON, format: 'zip' });
  assert.equal(out.ok, true);
  assert.equal(out.export.format, 'zip');
  assert.ok(out.export.bytes > 0);
  assert.match(out.export.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.export.fileCount, 2);
  assert.equal(jailRelPath(out.export.artifactPath), out.export.artifactPath);
  assert.match(out.export.artifactPath, /^\.sira\/exports\/exp_[a-f0-9]+\.zip$/);
  const got = await sessionExport.getExport(sb, session.id, out.export.id, { raw: true });
  assert.equal(got.buffer[0], 0x50);
  assert.equal(got.buffer[1], 0x4b);
  assert.ok(got.buffer.includes(Buffer.from('src/app.ts')));
  assert.equal(out.export.contentBase64, undefined);
});

test('export tar.gz is gzip-wrapped and lists the same files', async () => {
  const { sb, session } = await seeded();
  const out = await sessionExport.exportSession(sb, session.id, { env: ON, format: 'tar.gz' });
  assert.equal(out.export.format, 'tar.gz');
  const got = await sessionExport.getExport(sb, session.id, out.export.id, { raw: true });
  assert.equal(got.buffer[0], 0x1f);
  assert.equal(got.buffer[1], 0x8b);
  const tar = zlib.gunzipSync(got.buffer);
  assert.ok(tar.includes(Buffer.from('README.md')));
});

test('export path filter is jailed and rejects traversal', async () => {
  const { sb, session } = await seeded({
    'src/app.ts': 'a',
    'docs/note.md': 'b',
  });
  await assert.rejects(
    () => sessionExport.exportSession(sb, session.id, { env: ON, path: '../etc/passwd' }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
  const onlySrc = await sessionExport.exportSession(sb, session.id, { env: ON, path: 'src' });
  assert.equal(onlySrc.export.fileCount, 1);
  assert.equal(onlySrc.export.files[0].path, 'src/app.ts');
});

test('export size cap is E_QUOTA in Spanish', async () => {
  const { sb, session } = await seeded({ 'big.txt': 'x'.repeat(1500) });
  await assert.rejects(
    () => sessionExport.exportSession(sb, session.id, { env: ON, maxBytes: 1024 }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('export file-count cap is E_QUOTA', async () => {
  const files = {};
  for (let i = 0; i < 4; i += 1) files[`f${i}.txt`] = 'n';
  const { sb, session } = await seeded(files);
  await assert.rejects(
    () => sessionExport.exportSession(sb, session.id, { env: ON, maxFiles: 2 }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('export skips .git internals and missing export id is Spanish 404', async () => {
  const { sb, session } = await seeded({
    'src/app.ts': 'ok',
    '.git/HEAD': 'ref: refs/heads/main\n',
  });
  const out = await sessionExport.exportSession(sb, session.id, { env: ON });
  assert.equal(out.export.fileCount, 1);
  assert.equal(out.export.files[0].path, 'src/app.ts');
  await assert.rejects(
    () => sessionExport.getExport(sb, session.id, 'exp_missing'),
    (err) => spanishError(err, 'E_EXPORT_NOT_FOUND'),
  );
});

test('empty workspace still exports a valid empty zip', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  const out = await sessionExport.exportSession(sb, session.id, { env: ON });
  assert.equal(out.export.fileCount, 0);
  assert.ok(out.export.bytes >= 22);
});

test('unknown export format is E_PARAMS in Spanish', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionExport.exportSession(sb, session.id, { env: ON, format: 'rar' }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('deploy stub records intent without any HTTP call', async () => {
  const { sb, session } = await seeded();
  const client = fakeHttp({ ok: true, status: 200 });
  const out = await sessionDeploy.recordIntent(sb, session.id, {
    env: ON,
    name: 'mi app',
    httpClient: client,
  });
  assert.equal(out.ok, true);
  assert.equal(out.deploy.status, 'registrado');
  assert.match(out.deploy.message, /[áéíóúñ]|registrad|proveedor/i);
  assert.equal(out.deploy.provider, 'stub');
  assert.equal(out.deploy.live, false);
  assert.equal(client.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(out), /sk-|Bearer |x-api-key/i);
});

test('live deploy without allowlist is E_DEPLOY_DENIED', async () => {
  const { sb, session } = await seeded();
  const client = fakeHttp({ ok: true, status: 200 });
  await assert.rejects(
    () => sessionDeploy.recordIntent(sb, session.id, {
      env: ON,
      provider: 'coolify',
      baseUrl: COOLIFY,
      live: true,
      httpClient: client,
    }),
    (err) => spanishError(err, 'E_DEPLOY_DENIED'),
  );
  assert.equal(client.calls.length, 0);
});

test('live deploy without injectable client is denied (never global fetch)', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionDeploy.recordIntent(sb, session.id, {
      env: { ...ON, AGENTES_CODING_DEPLOY_BASE_URLS: COOLIFY },
      provider: 'dokploy',
      baseUrl: COOLIFY,
      live: true,
    }),
    (err) => spanishError(err, 'E_DEPLOY_DENIED'),
  );
});

test('injectable client runs only against an allowlisted origin', async () => {
  const { sb, session } = await seeded();
  const client = fakeHttp({ ok: true, status: 202, body: { queued: true } });
  const out = await sessionDeploy.recordIntent(sb, session.id, {
    env: { ...ON, AGENTES_CODING_DEPLOY_BASE_URLS: COOLIFY },
    provider: 'coolify',
    baseUrl: `${COOLIFY}/unused/path`,
    appId: 'app-1',
    name: 'demo',
    live: true,
    token: 'test-token-not-a-secret-pattern',
    httpClient: client,
  });
  assert.equal(out.deploy.status, 'enviado');
  assert.match(out.deploy.message, /enviad/i);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].url, `${COOLIFY}/api/v1/deploy`);
  assert.equal(client.calls[0].headers.Authorization, 'Bearer test-token-not-a-secret-pattern');
  assert.equal(out.deploy.request.headers.Authorization, 'Bearer [redacted]');
  assert.doesNotMatch(JSON.stringify(out), /test-token-not-a-secret-pattern/);
});

test('dokploy request uses x-api-key and application.deploy path', () => {
  const req = deployClient.buildDeployRequest({
    provider: 'dokploy',
    baseUrl: COOLIFY,
    appId: 'abc',
    token: 'k',
  });
  assert.equal(req.url, `${COOLIFY}/api/application.deploy`);
  assert.equal(req.headers['x-api-key'], 'k');
  assert.equal(req.body.applicationId, 'abc');
  const redacted = deployClient.redactRequest(req);
  assert.equal(redacted.headers['x-api-key'], '[redacted]');
});

test('credentials in the deploy URL are denied', () => {
  assert.throws(
    () => allowlist.normalizeOrigin('https://user:pass@coolify.test'),
    (err) => spanishError(err, 'E_DEPLOY_DENIED'),
  );
  assert.equal(allowlist.parseAllowlist({ AGENTES_CODING_DEPLOY_BASE_URLS: 'file:///etc' }).length, 0);
});

test('live deploy remote 5xx is E_DEPLOY_FAILED and still recorded', async () => {
  const { sb, session } = await seeded();
  const client = fakeHttp({ ok: false, status: 503 });
  await assert.rejects(
    () => sessionDeploy.recordIntent(sb, session.id, {
      env: { ...ON, AGENTES_CODING_DEPLOY_BASE_URLS: COOLIFY },
      provider: 'coolify',
      baseUrl: COOLIFY,
      live: true,
      httpClient: client,
    }),
    (err) => spanishError(err, 'E_DEPLOY_FAILED'),
  );
  const list = await sessionDeploy.listDeploys(sb, session.id);
  assert.equal(list.deploys.length, 1);
  assert.equal(list.deploys[0].status, 'error');
});

test('missing deploy id is E_DEPLOY_NOT_FOUND', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionDeploy.getDeploy(sb, session.id, 'dep_nope'),
    (err) => spanishError(err, 'E_DEPLOY_NOT_FOUND'),
  );
});

test('jailRelPath still owns export path filters', () => {
  assert.throws(() => jailRelPath('../x'), (e) => e.code === 'E_PATH_ESCAPE');
  assert.equal(sessionExport.skipExportPath('.git/HEAD'), true);
  assert.equal(sessionExport.skipExportPath('src/app.ts'), false);
});

test('archive helpers emit zip/tar magic without extra deps', () => {
  const zip = archive.buildZip([{ path: 'a.txt', data: 'hi' }]);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const tgz = archive.buildTarGz([{ path: 'a.txt', data: 'hi' }]);
  assert.equal(tgz[0], 0x1f);
  assert.equal(tgz[1], 0x8b);
  assert.equal(archive.crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('POST /sessions/:id/export and /deploy are 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const paths = [
      ['POST', '/api/agentes-coding/sessions/csb_x/export'],
      ['GET', '/api/agentes-coding/sessions/csb_x/export'],
      ['POST', '/api/agentes-coding/sessions/csb_x/deploy'],
      ['GET', '/api/agentes-coding/sessions/csb_x/deploy'],
    ];
    for (const [method, urlPath] of paths) {
      const sendBody = method === 'POST';
      const { status, body } = await new Promise((resolve, reject) => {
        const headers = { connection: 'close' };
        if (sendBody) headers['Content-Type'] = 'application/json';
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }));
        });
        req.on('error', reject);
        req.end(sendBody ? '{}' : undefined);
      });
      assert.equal(status, 404, `${method} ${urlPath}`);
      assert.equal(body.error, 'not_found');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP export + deploy stub when flag is on', { skip: !express }, async () => {
  const { sb, session } = await seeded();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (_req, _res, next) => next(),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (method, urlPath, body) => new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const exported = await request('POST', `/api/agentes-coding/sessions/${session.id}/export`, {
      format: 'zip',
    });
    assert.equal(exported.status, 201);
    assert.equal(exported.json.ok, true);
    assert.equal(exported.json.export.format, 'zip');
    const listed = await request('GET', `/api/agentes-coding/sessions/${session.id}/export`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.exports.length, 1);
    const deployed = await request('POST', `/api/agentes-coding/sessions/${session.id}/deploy`, {
      name: 'demo',
    });
    assert.equal(deployed.status, 201);
    assert.equal(deployed.json.deploy.status, 'registrado');
    assert.match(deployed.json.deploy.message, /registrad/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts /export and /deploy behind the flag helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/export/);
  assert.match(src, /\/sessions\/:id\/deploy/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i);
  assert.doesNotMatch(src, /sk-[A-Za-z0-9]{8,}/);
});
