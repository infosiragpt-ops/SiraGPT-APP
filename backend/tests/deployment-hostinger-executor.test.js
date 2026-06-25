'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deployHostingerVps } = require('../src/services/deployments/connectors/hostinger-vps-executor');
const service = require('../src/services/deployments/deployment-service');

// ── Fake executor deps (offline: no fs / no net) ──────────────────────────
function makeExecutorDeps(overrides = {}) {
  const calls = { sftp: [], ssh: [] };
  const deps = {
    providers: {
      buildConnectionPlan: () => ({
        ready: true,
        provider: { missingRequired: [] },
        target: { host: '62.72.11.231', user: 'root', sshPort: '22', appPath: '/opt/siragpt/apps/app', publicIp: '62.72.11.231', appPort: 3000 },
      }),
    },
    connectedRepos: { findByIdForUser: async () => ({ id: 'conn_1' }) },
    workspaces: { findByRepositoryId: async () => ({ localPath: '/srv/ws/app' }) },
    workspaceManager: { isGitRepo: () => true, ensureLocalExcludes: () => {} },
    buildService: {
      detectBuildPlan: () => ({ kind: 'node', framework: 'next', buildCommand: 'npm run build', outputDir: 'out' }),
      ensureViteEntry: () => false,
      resolveOutputDir: () => 'out',
      dirHasFiles: () => true,
      ensureSpaHtaccess: () => false,
      runBuild: async () => ({ skipped: false }),
    },
    sftp: { uploadDir: async (cfg) => { calls.sftp.push(cfg); return { ok: true }; } },
    sshExec: { exec: async (cfg, command) => { calls.ssh.push({ cfg, command }); return { code: 0 }; } },
    nginx: { proxySetupCommand: () => 'NGINX_PROXY', staticSetupCommand: () => 'NGINX_STATIC' },
    creds: { openJson: () => ({}) },
    deployEnvs: { findForConnection: async () => null },
    friendlyError: (e) => (e && e.message) || String(e),
    ...overrides,
  };
  return { deps, calls };
}

const ENV = { HOSTINGER_VPS_SSH_PRIVATE_KEY: 'PRIVATE_KEY' };
const DEPLOYMENT = { id: 'depl_1', name: 'My App', subdomain: 'my-app', connectedRepositoryId: 'conn_1', externalPort: 3000 };

test('executor: node-mode deploy uploads source, runs install/build/pm2, configures nginx', async () => {
  const { deps, calls } = makeExecutorDeps();
  const res = await deployHostingerVps({ deployment: DEPLOYMENT, userId: 'u1', env: ENV, hostname: 'chatgpt66.com', deps });
  assert.equal(res.promoted, true);
  assert.equal(res.url, 'http://chatgpt66.com');
  assert.equal(res.failedPhase, null);
  // source upload excludes heavy dirs
  assert.equal(calls.sftp.length, 1);
  assert.deepEqual(calls.sftp[0].exclude, ['node_modules', '.git', 'dist', '.next', 'build']);
  // two ssh execs: the install/build/pm2 command, then nginx
  assert.equal(calls.ssh.length, 2);
  assert.match(calls.ssh[0].command, /npm install/);
  assert.match(calls.ssh[0].command, /pm2 start/);
  assert.equal(calls.ssh[1].command, 'NGINX_PROXY');
  assert.ok(res.logs.some((l) => /provision/.test(l)));
});

test('executor: static-mode deploy builds locally and uploads the output dir', async () => {
  const { deps, calls } = makeExecutorDeps({
    buildService: {
      detectBuildPlan: () => ({ kind: 'static', framework: 'static', buildCommand: null, outputDir: '.' }),
      ensureViteEntry: () => false,
      resolveOutputDir: () => 'dist',
      dirHasFiles: () => true,
      ensureSpaHtaccess: () => true,
      runBuild: async () => ({ skipped: true }),
    },
  });
  const res = await deployHostingerVps({ deployment: DEPLOYMENT, userId: 'u1', env: ENV, hostname: 'site.com', deps });
  assert.equal(res.promoted, true);
  assert.equal(calls.sftp[0].cleanSlate, true); // static upload wipes the web root
  assert.equal(calls.ssh[0].command, 'NGINX_STATIC');
});

test('executor: fails clearly when the deployment has no connected repo (Model A)', async () => {
  const { deps } = makeExecutorDeps();
  const res = await deployHostingerVps({ deployment: { ...DEPLOYMENT, connectedRepositoryId: null }, userId: 'u1', env: ENV, deps });
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'provision');
  assert.match(res.failureMessage, /repo de GitHub/i);
});

test('executor: fails when the VPS provider is not configured', async () => {
  const { deps } = makeExecutorDeps({
    providers: { buildConnectionPlan: () => ({ ready: false, provider: { missingRequired: ['HOSTINGER_VPS_HOST'] }, target: null }) },
  });
  const res = await deployHostingerVps({ deployment: DEPLOYMENT, userId: 'u1', env: ENV, deps });
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'provision');
  assert.match(res.failureMessage, /HOSTINGER_VPS_HOST/);
});

test('executor: a non-zero remote command fails the bundle phase', async () => {
  const { deps } = makeExecutorDeps({
    sshExec: { exec: async () => ({ code: 1 }) },
  });
  const res = await deployHostingerVps({ deployment: DEPLOYMENT, userId: 'u1', env: ENV, hostname: 'x.com', deps });
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'bundle');
});

test('executor: never throws — an unexpected dep error becomes a failed result', async () => {
  const { deps } = makeExecutorDeps({
    sftp: { uploadDir: async () => { throw new Error('boom'); } },
  });
  const res = await deployHostingerVps({ deployment: DEPLOYMENT, userId: 'u1', env: ENV, deps });
  assert.equal(res.promoted, false);
  assert.equal(res.failedPhase, 'build');
});

// ── publishDeployment branch (real executor vs synthetic) ─────────────────
function makeFakeDb() {
  let n = 0;
  const id = (p) => `${p}_${(n += 1)}`;
  const stores = { deployments: [], versions: [], domains: [], logs: [] };
  const match = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] == null;
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });
  const table = (store, prefix, defaults) => ({
    create: async ({ data }) => { const r = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...data }; store.push(r); return { ...r }; },
    createMany: async ({ data }) => { (data || []).forEach((d) => store.push({ id: id(prefix), createdAt: new Date(), ...defaults(), ...d })); return { count: (data || []).length }; },
    findFirst: async ({ where }) => { const r = store.find((x) => match(x, where)); return r ? { ...r } : null; },
    findUnique: async ({ where }) => { const r = store.find((x) => x.id === where.id); return r ? { ...r } : null; },
    findMany: async ({ where = {} }) => store.filter((r) => match(r, where)).map((r) => ({ ...r })),
    count: async ({ where = {} }) => store.filter((r) => match(r, where)).length,
    update: async ({ where, data }) => { const r = store.find((x) => x.id === where.id); Object.assign(r, data); return { ...r }; },
    updateMany: async ({ where, data }) => { const rows = store.filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  });
  const db = {
    deployment: table(stores.deployments, 'depl', () => ({ deletedAt: null, currentVersionId: null, subdomain: null, machineTier: 'hostinger_vps', deploymentType: 'hostinger_vps' })),
    deploymentVersion: table(stores.versions, 'ver', () => ({ isLive: false })),
    deploymentDomain: table(stores.domains, 'dom', () => ({})),
    deploymentLog: table(stores.logs, 'log', () => ({ versionId: null, source: 'System', level: 'info' })),
    _stores: stores,
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

const CONFIGURED_ENV = { HOSTINGER_VPS_HOST: '1.2.3.4', HOSTINGER_VPS_USER: 'root', HOSTINGER_VPS_SSH_PRIVATE_KEY: 'KEY' };

test('publishDeployment: hostinger_vps + configured env runs the real executor', async () => {
  const db = makeFakeDb();
  const d = await db.deployment.create({ data: { userId: 'u1', name: 'App', deploymentType: 'hostinger_vps', machineTier: 'hostinger_vps', connectedRepositoryId: 'conn_1' } });
  let called = false;
  const fakeExecutor = async ({ deployment }) => {
    called = true;
    assert.equal(deployment.id, d.id);
    return { promoted: true, logs: ['[provision] ok', '[promote] ✓'], url: 'http://chatgpt66.com', failedPhase: null, failureMessage: null };
  };
  const res = await service.publishDeployment({ userId: 'u1', id: d.id, db, env: CONFIGURED_ENV, executor: fakeExecutor });
  assert.equal(called, true);
  assert.equal(res.url, 'http://chatgpt66.com');
  assert.equal(res.deployment.status, 'running');
  assert.equal(res.version.isLive, true);
  assert.equal(res.version.status, 'promoted');
  assert.ok(db._stores.logs.length > 0); // build logs seeded into deployment_logs
});

test('publishDeployment: a failed real deploy is persisted as a failed version', async () => {
  const db = makeFakeDb();
  const d = await db.deployment.create({ data: { userId: 'u1', name: 'App', deploymentType: 'hostinger_vps', machineTier: 'hostinger_vps', connectedRepositoryId: 'conn_1' } });
  const fakeExecutor = async () => ({ promoted: false, logs: ['[error] no SSH key'], url: null, failedPhase: 'provision', failureMessage: 'no SSH key' });
  const res = await service.publishDeployment({ userId: 'u1', id: d.id, db, env: CONFIGURED_ENV, executor: fakeExecutor });
  assert.equal(res.deployment.status, 'failed');
  assert.equal(res.version.isLive, false);
  assert.equal(res.failedPhase, 'provision');
});

test('publishDeployment: hostinger_vps WITHOUT configured env falls back to the synthetic pipeline', async () => {
  const db = makeFakeDb();
  const d = await db.deployment.create({ data: { userId: 'u1', name: 'App', deploymentType: 'hostinger_vps', machineTier: 'hostinger_vps', connectedRepositoryId: 'conn_1' } });
  const throwingExecutor = async () => { throw new Error('executor must not be called when VPS env is missing'); };
  const res = await service.publishDeployment({ userId: 'u1', id: d.id, db, env: {}, executor: throwingExecutor });
  // Synthetic pipeline still produces a version + phases without the executor.
  assert.ok(res.version);
  assert.ok(Array.isArray(res.phases) && res.phases.length > 0);
});
