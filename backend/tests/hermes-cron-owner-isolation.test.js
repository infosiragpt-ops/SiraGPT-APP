'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');

// Actual scheduler/bridge/router/CLI/tool source, real atomic JSON files and
// loopback HTTP. Authentication and the recording agent invoker are explicit
// unit fixtures, not JWT/DB/provider acceptance. Unrelated Hermes integrations
// are unavailable and are never invoked by these tests.
// Compiling the unchanged scheduler at a fixture filename isolates its existing
// __dirname-based data directory without rewriting source or replacing fs.
const backend = path.resolve(__dirname, '..');
function loadSource(relative, overrides = {}, filename = path.join(backend, relative)) {
  const source = path.join(backend, relative);
  const loaded = new Module(filename, module);
  const realRequire = Module.createRequire(source);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = (id) => Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id);
  loaded._compile(fs.readFileSync(source, 'utf8'), filename);
  return loaded.exports;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-hermes-cron-owner-'));
  fs.chmodSync(root, 0o700);
  const scheduler = loadSource('src/services/scheduler/scheduler.js', {},
    path.join(root, 'backend/src/services/scheduler/scheduler.js'));
  t.after(() => {
    scheduler.stop();
    fs.rmSync(root, { recursive: true });
    assert.equal(fs.existsSync(root), false);
  });
  const invocations = [];
  scheduler.setInvoker(async (request) => {
    invocations.push(request);
    return { answer: 'Synthetic owner-scoped result' };
  });
  const bridge = loadSource('src/services/agents/cron/hermes-cron-bridge.js', {
    '../../scheduler/scheduler': scheduler,
  });
  const create = (userId) => bridge.createJob({
    userId, schedule: '0 0 29 2 *', prompt: `Synthetic job for ${userId}`,
  });
  const a = create('owner-a');
  const b = create('owner-b');
  const snapshot = () => fs.readFileSync(scheduler._paths.JOBS_FILE, 'utf8');
  return { scheduler, bridge, a, b, create, invocations, snapshot };
}

const unavailable = new Proxy({}, { get(_target, name) {
  return () => { throw new Error(`Unrelated Hermes capability not enabled in cron test: ${String(name)}`); };
} });

function cronCallers(bridge) {
  const common = {
    './cron/hermes-cron-bridge': bridge,
    './hermes-gateway-bridge': unavailable,
    './hermes-memory-bridge': unavailable,
    './hermes-delegate-bridge': unavailable,
    '../skills-registry': unavailable,
    './hermes-skill-curator': unavailable,
    './hermes-biblioteca': unavailable,
  };
  const cli = loadSource('src/services/agents/hermes-cli-bridge.js', common);
  const tui = loadSource('src/services/agents/hermes-tui-bridge.js', {
    './hermes-cli-bridge': cli, '../session-manager': unavailable,
    './hermes-agent-bridge': unavailable, '../skills-registry': unavailable,
    './hermes-memory-bridge': unavailable,
  });
  const tools = loadSource('src/services/agents/hermes-tools.js', common);
  return { cli, tui, tools };
}

async function httpFixture(t, f) {
  const callers = cronCallers(f.bridge);
  let authCalls = 0;
  const fixtureUser = (req) => {
    const token = req.headers.authorization;
    return token === 'Bearer fixture-a' ? 'owner-a' : token === 'Bearer fixture-b' ? 'owner-b' : null;
  };
  const auth = {
    authenticateToken(req, res, next) {
      authCalls++;
      const id = fixtureUser(req);
      if (!id) return res.status(401).json({ error: 'fixture_auth_required' });
      req.user = { id };
      return next();
    },
  };
  const router = loadSource('src/routes/hermes.js', {
    '../middleware/auth': auth,
    '../middleware/optionalAuth': { optionalAuth(req, _res, next) {
      const id = fixtureUser(req);
      if (id) req.user = { id };
      next();
    } },
    '../services/agents/hermes-runtime': {
      cronBridge: f.bridge, runHermesCommand: callers.cli.runHermesCommand,
      getHermesRuntimeStatus: () => ({ cron: f.bridge.status() }),
    },
    '../services/agents/hermes-tui-bridge': callers.tui,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/hermes', router);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/hermes`;
  async function request(route, { user, method = 'GET', body, authorization } = {}) {
    const response = await fetch(`${base}${route}`, {
      method, signal: AbortSignal.timeout(5000),
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(authorization ? { authorization } : user ? { authorization: `Bearer fixture-${user}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, authCalls: () => authCalls };
}

for (const operation of ['list', 'create', 'trigger', 'delete']) {
  test(`Hermes cron ${operation} rejects anonymous and invalid auth before disk mutation or invocation`, async (t) => {
    const f = fixture(t);
    const { request } = await httpFixture(t, f);
    const before = f.snapshot();
    const routes = {
      list: ['/cron/jobs?userId=owner-a', {}],
      create: ['/cron/jobs', { method: 'POST', body: { userId: 'owner-a', schedule: '1h', prompt: 'Spoofed' } }],
      trigger: [`/cron/jobs/${f.a.id}/trigger`, { method: 'POST', body: { userId: 'owner-a' } }],
      delete: [`/cron/jobs/${f.a.id}?userId=owner-a`, { method: 'DELETE' }],
    };
    const [route, options] = routes[operation];
    for (const authorization of [undefined, 'Bearer invalid-fixture']) {
      assert.equal((await request(route, { ...options, authorization })).status, 401);
      assert.equal(f.snapshot(), before);
      assert.equal(f.invocations.length, 0);
    }
  });
}

for (const operation of ['trigger', 'delete']) {
  test(`Hermes cron ${operation} hides foreign and absent jobs with the same 404`, async (t) => {
    const f = fixture(t);
    const { request } = await httpFixture(t, f);
    const before = f.snapshot();
    const options = { user: 'b', method: operation === 'trigger' ? 'POST' : 'DELETE', body: { userId: 'owner-a' } };
    const suffix = operation === 'trigger' ? '/trigger' : '';
    const foreign = await request(`/cron/jobs/${f.a.id}${suffix}?userId=owner-a`, options);
    const absent = await request(`/cron/jobs/absent-job${suffix}?userId=owner-a`, options);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign, absent);
    assert.deepEqual(foreign.body, { error: 'job_not_found' });
    assert.equal(f.snapshot(), before);
    assert.equal(f.invocations.length, 0);
  });
}

test('Hermes cron HTTP derives list/create/trigger/delete ownership only from authenticated identity', async (t) => {
  const f = fixture(t);
  const { request } = await httpFixture(t, f);
  const list = await request('/cron/jobs?userId=owner-a', { user: 'b' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.jobs.map((job) => job.id), [f.b.id]);
  const created = await request('/cron/jobs', { user: 'b', method: 'POST', body: {
    userId: 'owner-a', schedule: '0 0 29 2 *', prompt: 'Synthetic new job',
  } });
  assert.equal(created.status, 201);
  assert.equal(created.body.job.userId, 'owner-b');
  const result = await request(`/cron/jobs/${created.body.job.id}/trigger`, { user: 'b', method: 'POST', body: { userId: 'owner-a' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].userId, 'owner-b');
  const removed = await request(`/cron/jobs/${created.body.job.id}?userId=owner-a`, { user: 'b', method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.equal(f.scheduler.getJob(created.body.job.id), null);
  assert.ok(f.scheduler.getJob(f.a.id));
});

test('Hermes CLI cannot list another owner through anonymous or query-supplied identity', async (t) => {
  const f = fixture(t);
  const { request } = await httpFixture(t, f);
  assert.equal((await request('/cli/cron?userId=owner-a')).status, 401);
  const owned = await request('/cli/cron?userId=owner-a', { user: 'b' });
  assert.equal(owned.status, 200);
  assert.deepEqual(owned.body.jobs.map((job) => job.id), [f.b.id]);
  const slash = await request('/tui/slash', { method: 'POST', body: { input: '/cron', userId: 'owner-a' } });
  assert.equal(slash.status, 401);
  // The actual TUI does not implement /cron; it cannot serve as an alias.
  const unknown = await request('/tui/slash', { user: 'b', method: 'POST', body: { input: '/cron', userId: 'owner-a' } });
  assert.equal(unknown.body.reason, 'unknown_slash_command');
  assert.equal(f.invocations.length, 0);
});

test('Hermes keeps static maps public but protects runtime health and private routes', async (t) => {
  const f = fixture(t);
  const { request, authCalls } = await httpFixture(t, f);
  for (const route of ['/map', '/map/recommend?q=cron', '/openclaw/map', '/openclaw/map/recommend?q=cron', '/toolsets']) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.equal(authCalls(), 0, route);
  }
  for (const route of ['/health', '/gateway/status', '/delegate', '/environments/health', '/messages/rewind-state?sessionId=foreign']) {
    assert.equal((await request(route)).status, 401, route);
  }
  const healthy = await request('/health', { user: 'a' });
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.cron.totalJobs, 2);
});

test('Hermes bridge denies omitted/invalid owner instead of inheriting a stored job identity', async (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  for (const userId of [undefined, null, '', ' ', {}, []]) {
    assert.deepEqual(await f.bridge.triggerJob(f.a.id, { userId, source: 'hermes:tick' }), { ok: false, reason: 'not found' });
    assert.deepEqual(f.bridge.removeJob(f.a.id, userId), { ok: false, reason: 'not found' });
    assert.deepEqual(f.bridge.pauseJob(f.a.id, userId), { ok: false, reason: 'not found' });
    assert.deepEqual(f.bridge.resumeJob(f.a.id, userId), { ok: false, reason: 'not found' });
    assert.deepEqual(f.bridge.listJobs({ userId }), []);
    assert.equal(f.bridge.getJob(f.a.id, userId), null);
  }
  assert.equal(f.snapshot(), before);
  assert.equal(f.invocations.length, 0);
});

test('Hermes bridge rejects foreign ownership for every job operation, preserving the real journal', async (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  assert.deepEqual(await f.bridge.triggerJob(f.a.id, { userId: 'owner-b' }), { ok: false, reason: 'not found' });
  for (const method of ['removeJob', 'pauseJob', 'resumeJob']) {
    assert.deepEqual(f.bridge[method](f.a.id, 'owner-b'), { ok: false, reason: 'not found' });
    assert.deepEqual(f.bridge[method]('absent-job', 'owner-b'), { ok: false, reason: 'not found' });
  }
  assert.equal(f.bridge.getJob(f.a.id, 'owner-b'), null);
  assert.equal(f.bridge.getJob(f.a.id, 'owner-a').id, f.a.id);
  assert.equal(f.snapshot(), before);
  assert.equal(f.invocations.length, 0);
});

test('Hermes cron tool forwards its trusted context owner, never an argument owner', async (t) => {
  const f = fixture(t);
  const { tools } = cronCallers(f.bridge);
  const tool = tools.hermesCronjobTool;
  const args = { action: 'trigger', jobId: f.a.id, userId: 'owner-a' };
  const before = f.snapshot();
  assert.equal((await tool.execute(args, { userId: 'owner-b' })).ok, false);
  assert.equal((await tool.execute(args)).ok, false);
  assert.equal(f.snapshot(), before);
  assert.equal(f.invocations.length, 0);
  assert.equal((await tool.execute(args, { user: { id: 'owner-a' } })).ok, true);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.invocations[0].userId, 'owner-a');
});

test('Hermes owner pause/resume and tool removal retain their real scheduler effects', async (t) => {
  const f = fixture(t);
  const foreignBefore = f.scheduler.getJob(f.b.id);
  // Computed status timestamps are not persisted; compare the stored neighbor.
  const storedNeighbor = () => JSON.parse(f.snapshot()).find((job) => job.id === f.b.id);
  const neighborBefore = storedNeighbor();
  assert.equal(f.bridge.pauseJob(f.a.id, 'owner-a').ok, true);
  assert.equal(f.scheduler.getJob(f.a.id).enabled, false);
  assert.deepEqual(await f.bridge.triggerJob(f.a.id, { userId: 'owner-a' }), { ok: false, reason: 'disabled' });
  assert.equal(f.invocations.length, 0);
  assert.equal(f.bridge.resumeJob(f.a.id, 'owner-a').ok, true);
  assert.equal(f.scheduler.getJob(f.a.id).enabled, true);
  const { tools } = cronCallers(f.bridge);
  assert.equal((await tools.hermesCronjobTool.execute({ action: 'remove', jobId: f.a.id }, { userId: 'owner-a' })).ok, true);
  assert.equal(f.scheduler.getJob(f.a.id), null);
  assert.equal(f.scheduler.getJob(f.b.id).enabled, foreignBefore.enabled);
  assert.deepEqual(storedNeighbor(), neighborBefore);
});

test('Hermes bridge rejects invalid creator identity before changing its journal', (t) => {
  const f = fixture(t);
  const before = f.snapshot();
  for (const userId of [undefined, null, '', ' ', {}, []]) {
    assert.throws(() => f.create(userId), { message: 'createJob: userId required' });
  }
  assert.equal(f.snapshot(), before);
  assert.equal(f.invocations.length, 0);
});

test('Hermes internal tick retains the persisted owner for each legitimate invocation', async (t) => {
  const f = fixture(t);
  const result = await f.bridge.tick();
  assert.equal(result.ticked, 2);
  assert.ok(result.results.every((row) => row.ok));
  assert.deepEqual(f.invocations.map((request) => request.userId), ['owner-a', 'owner-b']);
  assert.ok(f.invocations.every((request) => request.source.startsWith('hermes:tick:')));
});
