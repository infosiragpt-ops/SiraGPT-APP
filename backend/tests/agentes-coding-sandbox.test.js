'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  createCodingSandbox,
  CodingSandboxError,
  resolveDriverName,
} = require('../src/services/agentes-coding/coding-sandbox');
const { createNetworkPolicy, FORBIDDEN_DOCKER_NETWORKS } = require('../src/services/agentes-coding/coding-sandbox/network');
const { jailRelPath } = require('../src/services/agentes-coding/coding-sandbox/path-jail');
const { buildDockerRunArgs, assertSafeDockerArgs } = require('../src/services/agentes-coding/coding-sandbox/docker-local');
const { resolveLimits, dockerLimitArgs } = require('../src/services/agentes-coding/coding-sandbox/limits');
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

function sandbox(extra = {}) {
  return createCodingSandbox({
    env: { ...ON, ...(extra.env || {}) },
    autoGc: false,
    now: extra.now,
    driver: extra.driver,
    docker: extra.docker,
    networkHook: extra.networkHook,
    image: extra.image,
  });
}

function expectCode(fn, code) {
  return fn().then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (err) => {
      assert.ok(err instanceof CodingSandboxError, err && err.stack);
      assert.equal(err.code, code);
      assert.match(err.message, /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|Docker|ruta|Red|puerto|Tope|tiempo/i);
    },
  );
}

test('resolveDriverName defaults to memory and maps docker aliases', () => {
  assert.equal(resolveDriverName({}), 'memory');
  assert.equal(resolveDriverName({ AGENTES_CODING_SANDBOX_DRIVER: 'docker' }), 'docker');
  assert.equal(resolveDriverName({ AGENTES_CODING_SANDBOX_DRIVER: 'DOCKER-LOCAL' }), 'docker');
});

test('createSession refuses when flag is off', async () => {
  const sb = createCodingSandbox({ env: {}, autoGc: false });
  await expectCode(() => sb.createSession(), 'E_FLAG_OFF');
});

test('exec refuses when flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await expectCode(() => sb.exec('csb_x', 'echo hi'), 'E_FLAG_OFF');
});

test('createSession works when flag is on (memory driver)', async () => {
  const sb = sandbox();
  const session = await sb.createSession({ userId: 'u1' });
  assert.equal(session.driver, 'memory');
  assert.equal(session.userId, 'u1');
  assert.match(session.id, /^csb_/);
  assert.equal(session.limits.cpus, '1');
  assert.equal(session.limits.memory, '512m');
  assert.equal(session.limits.pids, 64);
  assert.ok(session.expiresAt > session.createdAt);
});

test('writeFile + readFile roundtrip', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  await sb.writeFile(session.id, 'src/app.ts', 'export const n = 1;\n');
  const buf = await sb.readFile(session.id, 'src/app.ts');
  assert.equal(buf.toString('utf8'), 'export const n = 1;\n');
});

test('listFiles returns written paths', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  await sb.writeFile(session.id, 'a.txt', 'a');
  await sb.writeFile(session.id, 'dir/b.txt', 'b');
  const all = await sb.listFiles(session.id, '.');
  assert.deepEqual(all.map((f) => f.path), ['a.txt', 'dir/b.txt']);
  const nested = await sb.listFiles(session.id, 'dir');
  assert.deepEqual(nested.map((f) => f.path), ['dir/b.txt']);
});

test('path escape ../ is E_PATH_ESCAPE with Spanish copy', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  await expectCode(() => sb.readFile(session.id, '../etc/passwd'), 'E_PATH_ESCAPE');
  await expectCode(() => sb.writeFile(session.id, '/etc/passwd', 'x'), 'E_PATH_ESCAPE');
  await expectCode(() => sb.writeFile(session.id, 'foo\\bar', 'x'), 'E_PATH_ESCAPE');
});

test('jailRelPath rejects NUL and absolute windows paths', () => {
  assert.throws(() => jailRelPath('ok/\0no'), (e) => e.code === 'E_PATH_ESCAPE');
  assert.throws(() => jailRelPath('C:\\windows'), (e) => e.code === 'E_PATH_ESCAPE');
  assert.equal(jailRelPath('/workspace/src/a.ts'), 'src/a.ts');
});

test('destroy then exec fails E_SESSION_NOT_FOUND', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  await sb.destroy(session.id);
  await expectCode(() => sb.exec(session.id, 'true'), 'E_SESSION_NOT_FOUND');
});

test('TTL expiry destroys the session', async () => {
  let t = 1_000;
  const sb = sandbox({ now: () => t });
  const session = await sb.createSession({ ttlMs: 50 });
  t = 2_000;
  await expectCode(() => sb.listFiles(session.id), 'E_SESSION_EXPIRED');
});

test('activity extends TTL', async () => {
  let t = 10_000;
  const sb = sandbox({ now: () => t });
  const session = await sb.createSession({ ttlMs: 1_000 });
  t = 10_800;
  await sb.writeFile(session.id, 'keep.txt', 'x');
  t = 11_500;
  const files = await sb.listFiles(session.id);
  assert.equal(files[0].path, 'keep.txt');
});

test('exec returns stdout/stderr/exitCode via injectable impl', async () => {
  const sb = sandbox();
  const session = await sb.createSession({
    execImpl: async (cmd) => ({ stdout: `ran:${cmd}`, stderr: '', exitCode: 0 }),
  });
  const out = await sb.exec(session.id, 'echo hi');
  assert.equal(out.ok, true);
  assert.equal(out.stdout, 'ran:echo hi');
  assert.equal(out.exitCode, 0);
});

test('exec timeout is E_TIMEOUT shape (exit 124)', async () => {
  const sb = sandbox();
  const session = await sb.createSession({
    timeoutMs: 20,
    execImpl: () => new Promise(() => { /* hang */ }),
  });
  const out = await sb.exec(session.id, 'sleep 9', { timeoutMs: 20 });
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.exitCode, 124);
  assert.match(out.stderr, /tiempo máximo/);
});

test('network deny-by-default', () => {
  const policy = createNetworkPolicy();
  assert.equal(policy.mode, 'deny');
  assert.equal(policy.allows({ host: 'example.com' }), false);
  assert.deepEqual(policy.dockerNetworkArgs(), ['--network', 'none']);
});

test('network allowlist permits listed host only', () => {
  const policy = createNetworkPolicy({ allowlist: ['registry.npmjs.org', '*.github.com'] });
  assert.equal(policy.mode, 'allowlist');
  assert.equal(policy.allows({ host: 'registry.npmjs.org' }), true);
  assert.equal(policy.allows({ host: 'codeload.github.com' }), true);
  assert.equal(policy.allows({ host: 'evil.example' }), false);
  assert.deepEqual(policy.dockerNetworkArgs(), ['--network', 'siragpt-coding-sandbox']);
});

test('network hook cannot pick host or bridge', () => {
  const policy = createNetworkPolicy({
    hook: () => ({ allowed: true, dockerNetwork: 'host' }),
  });
  assert.throws(() => policy.decide({ host: 'x' }), (e) => e.code === 'E_NETWORK_DENIED');
  assert.ok(FORBIDDEN_DOCKER_NETWORKS.has('bridge'));
});

test('CPU/RAM limit stubs are applied to docker argv', () => {
  const limits = resolveLimits({ cpus: '0.5', memory: '256m', pids: 32 }, ON);
  const args = buildDockerRunArgs({
    name: 'sira-csb-test',
    image: 'siragpt-coding-sandbox:dev',
    limits,
    networkArgs: ['--network', 'none'],
  });
  assert.ok(args.includes('--memory'));
  assert.ok(args.includes('256m'));
  assert.ok(args.includes('--cpus'));
  assert.ok(args.includes('0.5'));
  assert.ok(args.includes('--pids-limit'));
  assert.ok(args.includes('32'));
  assert.ok(args.includes('--security-opt'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('--cap-drop'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('10001:10001'));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(!args.includes('--privileged'));
  const limitArgs = dockerLimitArgs(limits);
  assert.ok(limitArgs.includes('--tmpfs'));
});

test('docker driver createSession uses injectable stub and records argv', async () => {
  const calls = [];
  const docker = {
    async exec(args) {
      calls.push(args);
      return { stdout: 'cid\n', stderr: '', exitCode: 0 };
    },
  };
  const sb = sandbox({ driver: 'docker', docker });
  const session = await sb.createSession();
  assert.equal(session.driver, 'docker');
  assert.ok(session.containerName.startsWith('sira-csb-'));
  assert.equal(calls[0][0], 'run');
  assert.ok(calls[0].includes('--network'));
  assert.ok(calls[0].includes('none'));
  assert.ok(calls[0].includes('sleep'));
});

test('docker driver exec uses docker exec', async () => {
  const calls = [];
  const docker = {
    async exec(args) {
      calls.push(args);
      if (args[0] === 'run') return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
  };
  const sb = sandbox({ driver: 'docker', docker });
  const session = await sb.createSession();
  const out = await sb.exec(session.id, 'node -v');
  assert.equal(out.stdout, 'ok\n');
  const execCall = calls.find((a) => a[0] === 'exec');
  assert.ok(execCall);
  assert.ok(execCall.includes('-w'));
  assert.ok(execCall.includes('/workspace'));
});

test('docker driver destroy uses docker rm -f', async () => {
  const calls = [];
  const docker = {
    async exec(args) {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const sb = sandbox({ driver: 'docker', docker });
  const session = await sb.createSession();
  await sb.destroy(session.id);
  const rm = calls.find((a) => a[0] === 'rm' && a.includes('-f'));
  assert.ok(rm);
});

test('docker unavailable (ENOENT) is E_PROVIDER in Spanish', async () => {
  const docker = {
    async exec() {
      const err = new Error('spawn docker ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  };
  const sb = sandbox({ driver: 'docker', docker });
  await expectCode(() => sb.createSession(), 'E_PROVIDER');
});

test('exposePort denied by default', async () => {
  const sb = sandbox();
  const session = await sb.createSession();
  await expectCode(() => sb.exposePort(session.id, 5173), 'E_PORT_DENIED');
});

test('exposePort allowed by network hook', async () => {
  const sb = sandbox({
    networkHook: ({ action }) => action === 'exposePort',
    previewSecret: 'test-preview-secret-32b!',
  });
  const session = await sb.createSession();
  const exposed = await sb.exposePort(session.id, 5173);
  assert.equal(exposed.port, 5173);
  assert.equal(exposed.published, true);
  assert.match(exposed.url, /\/api\/agentes-coding\/sessions\/.+\/preview\//);
  assert.equal(exposed.host, '127.0.0.1');
  assert.equal(exposed.hostPort, 5173);
});

test('max sessions quota', async () => {
  const sb = sandbox({ env: { AGENTES_CODING_SANDBOX_MAX_SESSIONS: '1' } });
  await sb.createSession();
  await expectCode(() => sb.createSession(), 'E_QUOTA');
});

test('writeFile size cap is E_QUOTA', async () => {
  const sb = sandbox({ env: { AGENTES_CODING_SANDBOX_MAX_FILE_BYTES: '8' } });
  const session = await sb.createSession();
  await expectCode(() => sb.writeFile(session.id, 'big.bin', '0123456789'), 'E_QUOTA');
});

test('unknown session is E_SESSION_NOT_FOUND', async () => {
  const sb = sandbox();
  await expectCode(() => sb.listFiles('csb_missing'), 'E_SESSION_NOT_FOUND');
});

test('assertSafeDockerArgs blocks docker.sock', () => {
  assert.throws(
    () => assertSafeDockerArgs(['run', '-v', '/var/run/docker.sock:/var/run/docker.sock']),
    (e) => e.code === 'E_NETWORK_DENIED',
  );
});

test('error catalog codes are Spanish and cover §16 plus sandbox', () => {
  for (const code of ['E_FLAG_OFF', 'E_PARAMS', 'E_TIMEOUT', 'E_QUOTA', 'E_PROVIDER', 'E_CANCELLED']) {
    assert.ok(CATALOG[code], code);
    assert.match(CATALOG[code].message, /[A-Za-záéíóúñ]/);
  }
});

test('GET /health reports enabled:false by default', { skip: !express }, async () => {
  const app = express();
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {} }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const { status, body } = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/agentes-coding/health`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      }).on('error', reject);
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, enabled: false });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('session HTTP routes are 404 when flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/agentes-coding/sessions',
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
      req.end('{}');
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source keeps health public and 404s the rest when flag is off', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/routes/agentes-coding.js'),
    'utf8',
  );
  assert.match(src, /router\.get\('\/health'/);
  assert.match(src, /error: 'not_found'/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /authenticateToken/);
  assert.match(src, /\/sessions/);
});

test('index.js mounts /api/agentes-coding after deployments', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(src, /agentesCodingRoutes/);
  assert.match(src, /app\.use\('\/api\/agentes-coding'/);
});

test('compose overlay is profile-gated and has no docker.sock / postgres', () => {
  const compose = fs.readFileSync(
    path.join(__dirname, '../../docker-compose.coding-sandbox.yml'),
    'utf8',
  );
  assert.match(compose, /profiles:\s*\n\s*-\s*agentes-coding/);
  assert.match(compose, /siragpt-coding-sandbox/);
  assert.match(compose, /internal:\s*true/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /^\s+volumes:/m);
  assert.doesNotMatch(compose, /POSTGRES_|DATABASE_URL|REDIS_URL/);
});

test('cancelled execImpl signal is E_CANCELLED', async () => {
  const sb = sandbox();
  const ac = new AbortController();
  ac.abort();
  const session = await sb.createSession({
    execImpl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  });
  await expectCode(() => sb.exec(session.id, 'true', { signal: ac.signal }), 'E_CANCELLED');
});

test('docker write/read/list go through injectable exec', async () => {
  const files = new Map();
  const docker = {
    async exec(args) {
      if (args[0] === 'run' || args[0] === 'rm') return { stdout: '', stderr: '', exitCode: 0 };
      const script = args[args.length - 1];
      if (String(script).startsWith('mkdir -p')) {
        const m = String(script).match(/printf '%s' "([A-Za-z0-9+/=]+)"/);
        const dest = String(script).match(/> "([^"]+)"/);
        if (m && dest) {
          files.set(dest[1], Buffer.from(m[1], 'base64').toString('utf8'));
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (String(script).startsWith('cat --')) {
        const dest = String(script).match(/cat -- "([^"]+)"/);
        return { stdout: files.get(dest[1]) || '', stderr: '', exitCode: dest && files.has(dest[1]) ? 0 : 1 };
      }
      if (String(script).startsWith('find')) {
        const lines = [...files.entries()].map(([p, v]) => `${v.length} ${p}`).join('\n');
        return { stdout: lines, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const sb = sandbox({ driver: 'docker', docker });
  const session = await sb.createSession();
  await sb.writeFile(session.id, 'hello.txt', 'hola');
  const buf = await sb.readFile(session.id, 'hello.txt');
  assert.equal(buf.toString('utf8'), 'hola');
  const list = await sb.listFiles(session.id);
  assert.equal(list[0].path, 'hello.txt');
});
