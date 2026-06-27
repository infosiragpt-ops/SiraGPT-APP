'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deployNodeContainer,
  safeSlug,
  sanitizeSubdir,
  dbIdent,
  buildProvisionSql,
  buildCaddySnippet,
  generateDockerfile,
  buildEnvFile,
} = require('../src/services/deployments/connectors/node-container-executor');

// ── Offline harness: fake ssh/sftp deps that record commands ──────────────
function run(overrides = {}) {
  const calls = { ssh: [], sftp: [] };
  const codeFor = overrides.codeFor || (() => 0);
  const logs = [];
  const push = (l) => { for (const part of String(l).split('\n')) if (part.trim()) logs.push(part); };
  const d = {
    sshExec: {
      exec: async (conn, command) => { calls.ssh.push(command); return { code: codeFor(command) }; },
    },
    sftp: {
      uploadDir: async (cfg) => { calls.sftp.push(cfg); if (overrides.sftpThrows) throw new Error('sftp boom'); return { ok: true }; },
    },
    friendlyError: (e) => (e && e.message) || String(e),
    hasPrismaSchema: overrides.hasPrismaSchema || false,
  };
  const args = {
    d,
    conn: { host: '1.2.3.4', port: 22, username: 'root', privateKey: 'KEY' },
    localPath: '/srv/ws/app',
    buildEnv: overrides.buildEnv || {},
    slug: overrides.slug || 'my-app',
    hostname: overrides.hostname === undefined ? 'chatgpt66.com' : overrides.hostname,
    deployment: { id: 'depl_1', name: 'My App', subdomain: 'my-app', externalPort: 8080, ...(overrides.deployment || {}) },
    env: overrides.env || {},
    push,
    logs,
  };
  return { args, calls, logs };
}

const sshHas = (calls, re) => calls.ssh.some((c) => re.test(c));

// ── Pure helpers ──────────────────────────────────────────────────────────
test('safeSlug restricts to [a-z0-9-], strips shell metachars, blocks reserved', () => {
  assert.equal(safeSlug({ name: 'My App; rm -rf /' }), 'my-app-rm-rf');
  assert.equal(safeSlug({ subdomain: 'Hello_World!!' }), 'hello-world');
  assert.equal(safeSlug({ name: 'db' }), 'app-db'); // reserved → prefixed
  assert.equal(safeSlug({ name: 'siragpt-thing' }), 'app-siragpt-thing'); // siragpt* → prefixed
  assert.match(safeSlug({ id: 'cmABC123' }), /^[a-z0-9-]+$/);
});

test('dbIdent + buildProvisionSql are idempotent + injection-safe', () => {
  assert.equal(dbIdent('my-app'), 'app_my_app');
  const sql = buildProvisionSql('app_my_app', 'app_my_app', 'deadbeef');
  assert.match(sql, /CREATE ROLE "app_my_app"/);
  assert.match(sql, /IF NOT EXISTS/);
  assert.match(sql, /CREATE DATABASE "app_my_app"/);
  assert.match(sql, /\\gexec/);
  // PG15 public-schema grant so migrations can create tables.
  assert.match(sql, /\\connect "app_my_app"/);
  assert.match(sql, /GRANT ALL ON SCHEMA public TO "app_my_app"/);
});

test('buildCaddySnippet emits an explicit reverse_proxy site block', () => {
  assert.equal(buildCaddySnippet('chatgpt66.com', 'app-my-app', 8080), 'chatgpt66.com {\n\treverse_proxy app-my-app:8080\n}\n');
});

test('sanitizeSubdir strips traversal/slashes, keeps a clean monorepo path', () => {
  assert.equal(sanitizeSubdir('backend'), 'backend');
  assert.equal(sanitizeSubdir('/backend/'), 'backend');
  assert.equal(sanitizeSubdir('../../etc'), 'etc');
  assert.equal(sanitizeSubdir('apps/web; rm -rf /'), 'apps/webrm-rf');
  assert.equal(sanitizeSubdir(''), '');
});

test('container deploy: builds from a monorepo subdir (backend/)', async () => {
  const { args, calls } = run({ deployment: {} });
  args.subdir = 'backend';
  await deployNodeContainer(args);
  const buildCmd = calls.ssh.find((c) => /docker build -t siragpt-app-my-app/.test(c));
  assert.match(buildCmd, /cd \/opt\/siragpt\/apps\/my-app\/backend/, 'builds in the subdir');
  // source still uploads the WHOLE repo (so backend/ is present)
  assert.equal(calls.sftp[0].remoteDir, '/opt/siragpt/apps/my-app');
});

test('generateDockerfile + buildEnvFile', () => {
  const df = generateDockerfile(8080);
  assert.match(df, /FROM node:20-alpine/);
  assert.match(df, /ENV PORT=8080/);
  const envf = buildEnvFile({ DATABASE_URL: 'postgres://x', PORT: '8080', 'bad key': 'no', MULTI: 'a\nb' });
  assert.match(envf, /DATABASE_URL=postgres:\/\/x/);
  assert.doesNotMatch(envf, /bad key/); // invalid key dropped
  assert.match(envf, /MULTI=a b/); // newline stripped
});

// ── deployNodeContainer flow ────────────────────────────────────────────────
test('container deploy: default DB provisions Postgres + builds + runs + Caddy + healthy', async () => {
  const { args, calls } = run();
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, true);
  assert.equal(res.url, 'https://chatgpt66.com');
  assert.equal(res.databaseProvider, 'sira-postgres');
  assert.match(res.databaseUrl, /^postgres:\/\/app_my_app:.*@db:5432\/app_my_app$/);
  assert.ok(sshHas(calls, /docker exec -i -e PGPASSWORD siragpt-db psql/), 'provisions DB');
  assert.equal(calls.sftp.length, 1);
  assert.equal(calls.sftp[0].cleanSlate, true);
  assert.ok(sshHas(calls, /docker build -t siragpt-app-my-app:latest \./), 'builds image');
  assert.ok(sshHas(calls, /docker run -d --name app-my-app --restart unless-stopped --network siragpt_default/), 'runs container');
  assert.ok(sshHas(calls, /caddy validate .* && .*caddy reload/), 'validates before reload');
  assert.ok(sshHas(calls, /chatgpt66\.com\.caddy/), 'writes per-domain snippet');
  assert.ok(sshHas(calls, /State\.Running/), 'health-checks (crash-aware)');
});

test('container deploy: own DATABASE_URL skips provisioning (external)', async () => {
  const { args, calls } = run({ buildEnv: { DATABASE_URL: 'postgres://u:p@host:5432/mydb' } });
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, true);
  assert.equal(res.databaseProvider, 'external');
  assert.equal(res.databaseUrl, undefined); // nothing to seal/reuse
  assert.equal(sshHas(calls, /psql/), false, 'no psql provisioning');
});

test('container deploy: secrets never leak into the log buffer', async () => {
  const { args, logs } = run({ buildEnv: { API_KEY: 'sk-supersecret' } });
  const res = await deployNodeContainer(args);
  const joined = logs.join('\n');
  assert.doesNotMatch(joined, /sk-supersecret/);
  assert.doesNotMatch(joined, /postgres:\/\//); // DATABASE_URL never logged
  assert.ok(res.promoted);
});

test('container deploy: respects a custom env override network/db container', async () => {
  const { args, calls } = run({ env: { SIRAGPT_DOCKER_NETWORK: 'mynet', SIRAGPT_DB_CONTAINER: 'mydb' } });
  await deployNodeContainer(args);
  assert.ok(sshHas(calls, /--network mynet/));
  assert.ok(sshHas(calls, /docker exec -i -e PGPASSWORD mydb psql/));
});

test('container deploy: Caddy validate failure reverts snippet + fails promote', async () => {
  const { args, calls } = run({ codeFor: (c) => (/caddy validate/.test(c) ? 1 : 0) });
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'promote');
  const caddyCmd = calls.ssh.find((c) => /caddy validate/.test(c));
  assert.match(caddyCmd, /rm -f .*chatgpt66\.com\.caddy/, 'reverts the snippet on invalid config');
});

test('container deploy: a crashed container fails the promote phase', async () => {
  const { args } = run({ codeFor: (c) => (/State\.Running/.test(c) ? 1 : 0) });
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'promote');
});

test('container deploy: docker build failure fails the build phase', async () => {
  const { args } = run({ codeFor: (c) => (/docker build/.test(c) ? 1 : 0) });
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'build');
});

test('container deploy: never throws — sftp error becomes a failed result', async () => {
  const { args } = run({ sftpThrows: true });
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'build');
});

test('container deploy: runs prisma migrate when a schema is present', async () => {
  const { args, calls } = run({ hasPrismaSchema: true });
  await deployNodeContainer(args);
  assert.ok(sshHas(calls, /docker exec app-my-app sh -lc .*prisma migrate deploy/));
});

test('container deploy: no domain → runs but url is null', async () => {
  const { args, calls } = run({ hostname: null });
  const res = await deployNodeContainer(args);
  assert.equal(res.promoted, true);
  assert.equal(res.url, null);
  assert.equal(sshHas(calls, /caddy/), false);
});
