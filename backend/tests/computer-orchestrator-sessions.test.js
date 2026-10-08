'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createOrchestrator } = require('../../services/computer-orchestrator/server');
const { createDockerRuntime, waitForTcpPort } = require('../../services/computer-orchestrator/docker-runtime');
const { slugUserId, sessionIdFor, containerNameFor } = require('../../services/computer-orchestrator/session-store');
const { buildActionCommand } = require('../../services/computer-orchestrator/agent-actions');

function listen(orch) {
  return new Promise((resolve) => {
    orch.server.listen(0, '127.0.0.1', () => {
      const { port } = orch.server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => orch.server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

async function postSession(base, userId) {
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = await res.json();
  return { res, body };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function inspectRunning(name) {
  return {
    Name: `/${name}`,
    State: { Running: true },
    NetworkSettings: {
      IPAddress: '127.0.0.1',
      Networks: { bridge: { IPAddress: '127.0.0.1' } },
    },
  };
}

function mockDockerAlreadyRunning(name) {
  return async function requestImpl(method, path) {
    if (method === 'GET' && /\/json$/.test(path)) {
      return { status: 200, data: inspectRunning(name) };
    }
    return { status: 200, data: {} };
  };
}

function mockDockerMissingThenCreate(name) {
  let created = false;
  return async function requestImpl(method, path) {
    if (method === 'GET' && /\/json$/.test(path)) {
      if (!created) {
        const err = new Error('no such container');
        err.status = 404;
        throw err;
      }
      return { status: 200, data: inspectRunning(name) };
    }
    if (method === 'POST' && path.includes('/create')) {
      created = true;
      return { status: 201, data: { Id: 'ctr' } };
    }
    if (method === 'POST' && path.endsWith('/start')) {
      return { status: 204, data: {} };
    }
    return { status: 200, data: {} };
  };
}

describe('siragpt-computer-orchestrator session contract', () => {
  test('POST /sessions reuses the same desktop for the same userId', async () => {
    const orch = createOrchestrator({ driver: 'fake', env: { PORT: '0' } });
    const srv = await listen(orch);
    try {
      const first = await postSession(srv.url, 'luis_c_chatA');
      assert.ok(first.res.status === 201 || first.res.status === 200);
      assert.equal(first.body.reused, false);
      assert.equal(first.body.userId, 'luis_c_chatA');
      assert.equal(first.body.sessionId, sessionIdFor('luis_c_chatA'));
      assert.equal(first.body.container, containerNameFor('luis_c_chatA'));

      const second = await postSession(srv.url, 'luis_c_chatA');
      assert.equal(second.res.status, 200);
      assert.equal(second.body.reused, true);
      assert.equal(second.body.sessionId, first.body.sessionId);
      assert.equal(orch.store.size(), 1);
    } finally {
      await srv.close();
    }
  });

  test('isolation: chat A and chat B get different session ids and containers', async () => {
    const orch = createOrchestrator({ driver: 'fake' });
    const srv = await listen(orch);
    try {
      const a = await postSession(srv.url, 'luis_c_chatA');
      const b = await postSession(srv.url, 'luis_c_chatB');
      assert.notEqual(a.body.sessionId, b.body.sessionId);
      assert.notEqual(a.body.container, b.body.container);
      assert.match(a.body.container, /^sira-ac-user-/);
      assert.equal(orch.store.size(), 2);
      const got = await fetch(`${srv.url}/sessions/${a.body.sessionId}`);
      const row = await got.json();
      assert.equal(row.userId, 'luis_c_chatA');
      assert.notEqual(row.userId, b.body.userId);
    } finally {
      await srv.close();
    }
  });

  test('GET /sessions/:id 404s unknown ids; agent/action works after create', async () => {
    const orch = createOrchestrator({ driver: 'fake' });
    const srv = await listen(orch);
    try {
      const missing = await fetch(`${srv.url}/sessions/no-such`);
      assert.equal(missing.status, 404);
      const created = await postSession(srv.url, 'memberX');
      const action = await fetch(`${srv.url}/sessions/${created.body.sessionId}/agent/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'click', x: 10, y: 20 }),
      });
      const body = await action.json();
      assert.equal(action.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.type, 'click');
      const nav = await fetch(`${srv.url}/sessions/${created.body.sessionId}/agent/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.google.com/' }),
      });
      const opened = await nav.json();
      assert.equal(nav.status, 200);
      assert.equal(opened.ok, true);
      assert.equal(opened.url, 'https://www.google.com/');
      const blocked = await fetch(`${srv.url}/sessions/${created.body.sessionId}/agent/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'javascript:alert(1)' }),
      });
      assert.equal(blocked.status, 400);
    } finally {
      await srv.close();
    }
  });

  test('container slug and action commands stay within the live contract', () => {
    assert.equal(slugUserId('luis_c_chatA'), 'luis_c_chatA');
    assert.equal(containerNameFor('luis_c_chatA'), 'sira-ac-user-luis_c_chatA');
    assert.equal(buildActionCommand({ type: 'click', x: 4, y: 8 }), 'xdotool mousemove 4 8 click 1');
    assert.match(buildActionCommand({ type: 'type', text: "hi" }), /xdotool type/);
    assert.equal(buildActionCommand({ type: 'unknown' }), null);
  });

  test('Dockerfile creates compuser by name without forcing UID 1000', () => {
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '../../services/computer-orchestrator/Dockerfile'),
      'utf8',
    );
    assert.match(dockerfile, /useradd -m -s \/bin\/bash compuser/);
    assert.doesNotMatch(dockerfile, /useradd[^\n]*-u 1000/);
    assert.match(dockerfile, /getent passwd compuser/);
  });

  test('docker runtime defaults to Engine API v1.44 for Docker 29 MinAPIVersion', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../services/computer-orchestrator/docker-runtime.js'),
      'utf8',
    );
    assert.match(src, /DEFAULT_API\s*=\s*.*['"]v1\.44['"]/);
    assert.doesNotMatch(src, /DEFAULT_API\s*=\s*['"]v1\.43['"]/);
  });

  test('POST /sessions does not resolve before desktop 6080 accepts', async () => {
    const userId = 'waitnovnc';
    const container = containerNameFor(userId);
    const port = await reservePort();
    let listening = false;
    const novnc = net.createServer();
    const listenLater = setTimeout(() => {
      // The kernel accepts the probe's connect as soon as listen() binds,
      // BEFORE the 'listening' callback runs: a probe landing in that window
      // read as «resolved before 6080 accepted» (CI shard 2, 2026-10-08).
      // Flag at the call — never earlier than this timer, never later than
      // the first accepted connection.
      novnc.listen(port, '127.0.0.1');
      listening = true;
    }, 280);

    const runtime = createDockerRuntime({
      readCpuAffinityImpl: () => '0-31',
      requestImpl: mockDockerMissingThenCreate(container),
      network: 'bridge',
      novncPort: port,
      novncWaitIntervalMs: 40,
      novncWaitTimeoutMs: 3000,
    });
    const orch = createOrchestrator({ runtime, env: { PORT: '0' } });
    const srv = await listen(orch);
    try {
      let settled = false;
      const pending = postSession(srv.url, userId).then((out) => {
        settled = true;
        return out;
      });
      await delay(120);
      assert.equal(settled, false, 'session create must wait for noVNC TCP 6080');
      assert.equal(listening, false);

      const { res, body } = await pending;
      assert.equal(listening, true);
      assert.equal(settled, true);
      assert.equal(res.status, 201);
      assert.equal(body.sessionId, sessionIdFor(userId));
      assert.equal(body.container, container);
    } finally {
      clearTimeout(listenLater);
      await srv.close();
      await closeServer(novnc);
    }
  });

  test('reused running desktop still waits until 6080 accepts', async () => {
    const userId = 'reusenovnc';
    const container = containerNameFor(userId);
    const port = await reservePort();
    let listening = false;
    const novnc = net.createServer();
    const listenLater = setTimeout(() => {
      // The kernel accepts the probe's connect as soon as listen() binds,
      // BEFORE the 'listening' callback runs: a probe landing in that window
      // read as «resolved before 6080 accepted» (CI shard 2, 2026-10-08).
      // Flag at the call — never earlier than this timer, never later than
      // the first accepted connection.
      novnc.listen(port, '127.0.0.1');
      listening = true;
    }, 280);

    const runtime = createDockerRuntime({
      readCpuAffinityImpl: () => '0-31',
      requestImpl: mockDockerAlreadyRunning(container),
      network: 'bridge',
      novncPort: port,
      novncWaitIntervalMs: 40,
      novncWaitTimeoutMs: 3000,
    });
    const orch = createOrchestrator({ runtime, env: { PORT: '0' } });
    const srv = await listen(orch);
    try {
      let settled = false;
      const pending = postSession(srv.url, userId).then((out) => {
        settled = true;
        return out;
      });
      await delay(120);
      assert.equal(settled, false, 'reuse must still wait for noVNC');
      const { res, body } = await pending;
      assert.equal(listening, true);
      assert.ok(res.status === 200 || res.status === 201);
      assert.equal(body.reused, true);
      assert.equal(body.container, container);
    } finally {
      clearTimeout(listenLater);
      await srv.close();
      await closeServer(novnc);
    }
  });

  test('POST /sessions returns 503 when noVNC never accepts', async () => {
    const userId = 'deadnovnc';
    const container = containerNameFor(userId);
    const runtime = createDockerRuntime({
      readCpuAffinityImpl: () => '0-31',
      requestImpl: mockDockerMissingThenCreate(container),
      network: 'bridge',
      novncPort: 1,
      novncWaitIntervalMs: 20,
      novncWaitTimeoutMs: 80,
    });
    const orch = createOrchestrator({ runtime, env: { PORT: '0' } });
    const srv = await listen(orch);
    try {
      const { res, body } = await postSession(srv.url, userId);
      assert.equal(res.status, 503);
      assert.equal(body.error, 'ORCH_UNAVAILABLE');
    } finally {
      await srv.close();
    }
  });
});

describe('waitForTcpPort', () => {
  test('resolves only after the port starts accepting connections', async () => {
    const port = await reservePort();
    const server = net.createServer();
    const pending = waitForTcpPort('127.0.0.1', port, { intervalMs: 30, timeoutMs: 1500 });
    let ready = false;
    pending.then(() => { ready = true; }).catch(() => {});
    await delay(80);
    assert.equal(ready, false);
    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    await pending;
    assert.equal(ready, true);
    await closeServer(server);
  });
});

describe('orchestrator http server health', () => {
  test('GET /health reports fake driver', async () => {
    const orch = createOrchestrator({ driver: 'fake' });
    const srv = await listen(orch);
    try {
      const res = await fetch(`${srv.url}/health`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.driver, 'fake');
    } finally {
      await srv.close();
    }
  });
});

describe('always-on computer: boot reconciliation', () => {
  function fakeRuntime(rows) {
    const ipOf = (name) => `172.20.0.${10 + rows.findIndex((r) => r.name === name)}`;
    return {
      async listComputers() {
        return rows.map(({ name, running }) => ({ name, running }));
      },
      async inspectContainer(name) {
        return {
          Name: `/${name}`,
          State: { Running: true },
          NetworkSettings: { Networks: { 'iliagpt-app': { IPAddress: ipOf(name) } } },
        };
      },
      containerIp(info) {
        const nets = (info && info.NetworkSettings && info.NetworkSettings.Networks) || {};
        for (const net of Object.values(nets)) {
          if (net && net.IPAddress) return net.IPAddress;
        }
        return null;
      },
      async ensureContainer() {
        throw new Error('must not create during reconcile');
      },
    };
  }

  test('reconcile re-registers running desktops, skips stopped and foreign containers', async () => {
    const orch = createOrchestrator({
      driver: 'docker',
      env: { PORT: '0' },
      runtime: fakeRuntime([
        { name: 'sira-ac-user-luis_c_chatA', running: true },
        { name: 'sira-ac-user-luis_c_chatB', running: false },
        { name: 'iliagpt-backend', running: true },
      ]),
    });
    const result = await orch.reconcileContainers();
    assert.equal(result.reconciled, 1);
    assert.equal(orch.store.size(), 1);
    const row = orch.store.getById('ac_luis_c_chatA');
    assert.ok(row, 'running desktop must be re-registered by session id');
    assert.equal(row.container, 'sira-ac-user-luis_c_chatA');
    assert.equal(row.host, '172.20.0.10');
    assert.equal(row.reused, true);
    assert.equal(orch.store.getById('ac_luis_c_chatB'), null);
  });

  test('reconcile is idempotent and never throws when docker is unreachable', async () => {
    const orch = createOrchestrator({
      driver: 'docker',
      env: { PORT: '0' },
      runtime: fakeRuntime([{ name: 'sira-ac-user-luis_c_chatA', running: true }]),
    });
    assert.equal((await orch.reconcileContainers()).reconciled, 1);
    assert.equal((await orch.reconcileContainers()).reconciled, 0);
    assert.equal(orch.store.size(), 1);

    const dead = createOrchestrator({
      driver: 'docker',
      env: { PORT: '0' },
      runtime: {
        async listComputers() { throw new Error('socket gone'); },
      },
    });
    assert.equal((await dead.reconcileContainers()).reconciled, 0);
  });

  test('a reconciled session is served back with the same id (liveness rechecked, not recreated)', async () => {
    let ensured = 0;
    const orch = createOrchestrator({
      driver: 'docker',
      env: { PORT: '0' },
      runtime: {
        ...fakeRuntime([{ name: 'sira-ac-user-luis_c_chatA', running: true }]),
        async ensureContainer() {
          ensured += 1;
          return { info: {}, reused: true, created: false };
        },
      },
    });
    await orch.reconcileContainers();
    const srv = await listen(orch);
    try {
      const res = await postSession(srv.url, 'luis_c_chatA');
      assert.ok(res.res.status === 200 || res.res.status === 201);
      assert.equal(res.body.sessionId, 'ac_luis_c_chatA');
      assert.equal(res.body.reused, true);
      assert.equal(ensured, 1, 'container liveness is rechecked on serve');
    } finally {
      await srv.close();
    }
  });
});

describe('always-on computer: desktop listing', () => {
  test('listComputers returns only sira-ac-user-* names with running flags', async () => {
    const { createDockerRuntime } = require('../../services/computer-orchestrator/docker-runtime');
    const runtime = createDockerRuntime({
      readCpuAffinityImpl: () => '0-31',
      requestImpl: async (method, path) => {
        assert.match(path, /label/);
        return {
          status: 200,
          data: [
            { Names: ['/sira-ac-user-luis_c_a'], State: 'running' },
            { Names: ['/sira-ac-user-luis_c_b'], State: 'exited' },
          ],
        };
      },
    });
    const rows = await runtime.listComputers();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'sira-ac-user-luis_c_a');
    assert.equal(rows[0].running, true);
    assert.equal(rows[1].running, false);
  });

  test('listComputers never throws when the socket is gone', async () => {
    const { createDockerRuntime } = require('../../services/computer-orchestrator/docker-runtime');
    const runtime = createDockerRuntime({
      readCpuAffinityImpl: () => '0-31',
      requestImpl: async () => { throw new Error('no socket'); },
    });
    assert.deepEqual(await runtime.listComputers(), []);
  });
});

// Exercise the actual Docker request builder: the external Engine transport is
// controlled, while create/reuse, quota resolution and affinity selection run.
function desktopCpuHarness({ existing, cpus = 1, allowed = '0-31', updateError, readAffinityError } = {}) {
  const requests = [];
  let info = existing ? structuredClone(existing) : null;
  let affinityReads = 0;
  const runtime = createDockerRuntime({
    cpus,
    network: 'bridge',
    readCpuAffinityImpl: () => {
      affinityReads += 1;
      if (readAffinityError) throw readAffinityError;
      return allowed;
    },
    connectImpl: (_port, _host, done) => done(),
    requestImpl: async (method, route, body) => {
      requests.push({ method, route, body: structuredClone(body) });
      if (method === 'GET' && route.endsWith('/json')) {
        if (!info) throw Object.assign(new Error('no such container'), { status: 404 });
        return { status: 200, data: structuredClone(info) };
      }
      if (method === 'POST' && route.startsWith('/containers/create?')) {
        const name = new URLSearchParams(route.split('?')[1]).get('name');
        info = { ...inspectRunning(name), State: { Running: false }, HostConfig: structuredClone(body.HostConfig) };
        return { status: 201, data: { Id: 'test-desktop' } };
      }
      if (method === 'POST' && route.endsWith('/update')) {
        if (updateError) throw updateError;
        Object.assign(info.HostConfig, body);
        return { status: 200, data: { Warnings: [] } };
      }
      if (method === 'POST' && route.endsWith('/start')) {
        info.State.Running = true;
        return { status: 204, data: {} };
      }
      throw new Error(`unexpected Docker request: ${method} ${route}`);
    },
  });
  return { runtime, requests, getInfo: () => structuredClone(info), affinityReads: () => affinityReads };
}

function cpuIds(value) {
  assert.equal(typeof value, 'string', 'Docker CPU affinity must be present');
  return value.split(',').map(Number);
}

function quotaDesktop(extra = {}) {
  return {
    ...inspectRunning('sira-ac-user-cpu-qa'),
    HostConfig: {
      NanoCpus: 1e9, CpusetCpus: '', PidsLimit: 256,
      Memory: 1024 ** 3, MemorySwap: 1024 ** 3,
      SecurityOpt: ['seccomp=unconfined'], CapAdd: ['SYS_ADMIN'],
      ...extra,
    },
  };
}

describe('desktop CPU quota is reflected in visible CPU affinity', () => {
  test('one-CPU desktop on 32 CPUs does not expose all host CPUs to thread pools', async () => {
    const h = desktopCpuHarness();
    const out = await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
    const create = h.requests.find((r) => r.route.startsWith('/containers/create?')).body;
    const ids = cpuIds(create.HostConfig.CpusetCpus);
    assert.equal(ids.length, 1);
    assert.ok(ids[0] >= 0 && ids[0] < 32);
    assert.equal(create.HostConfig.NanoCpus, 1e9);
    assert.equal(create.HostConfig.PidsLimit, 256);
    assert.equal(create.HostConfig.Memory, 1024 ** 3);
    assert.equal(create.HostConfig.MemorySwap, 1024 ** 3);
    assert.deepEqual(create.HostConfig.SecurityOpt, ['seccomp=unconfined']);
    assert.deepEqual(create.HostConfig.CapAdd, ['SYS_ADMIN']);
    assert.deepEqual(create.Env, ['DISPLAY=:1', 'HOME=/home/compuser']);
    assert.equal(out.created, true);
  });

  test('fractional quotas round up within a sparse allowed affinity, never to CPU zero', async () => {
    for (const [cpus, count] of [[0.5, 1], [1.5, 2], [8, 4]]) {
      const h = desktopCpuHarness({ cpus, allowed: '2,4-5,9' });
      await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
      const config = h.getInfo().HostConfig;
      const ids = cpuIds(config.CpusetCpus);
      assert.equal(ids.length, count);
      assert.equal(new Set(ids).size, count);
      assert.ok(ids.every((id) => [2, 4, 5, 9].includes(id)));
      assert.equal(config.NanoCpus, cpus * 1e9);
    }
  });

  test('allocation is stable across restarts and spreads desktops across allowed CPUs', async () => {
    const placements = new Set();
    for (let i = 0; i < 32; i += 1) {
      const name = `sira-ac-user-allocation-${i}`;
      const a = desktopCpuHarness();
      const b = desktopCpuHarness();
      await a.runtime.ensureContainer(name);
      await b.runtime.ensureContainer(name);
      assert.equal(a.getInfo().HostConfig.CpusetCpus, b.getInfo().HostConfig.CpusetCpus);
      placements.add(a.getInfo().HostConfig.CpusetCpus);
    }
    assert.ok(placements.size >= 8, `desktops must not all be pinned together: ${placements.size}`);
  });

  test('reuse narrows unassigned affinity in place without restarting or changing other limits', async () => {
    const existing = quotaDesktop();
    const h = desktopCpuHarness({ existing, cpus: 8 });
    const first = await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
    const update = h.requests.find((r) => r.route.endsWith('/update'));
    assert.ok(update, 'old running desktop needs the same quota-aware affinity');
    assert.deepEqual(Object.keys(update.body), ['CpusetCpus']);
    assert.equal(cpuIds(update.body.CpusetCpus).length, 1, 'use its persisted quota, not changed defaults');
    assert.deepEqual(h.getInfo().HostConfig, { ...existing.HostConfig, ...update.body });
    assert.equal(first.reused, true);
    assert.equal(first.created, false);
    assert.equal(first.info.HostConfig.CpusetCpus, update.body.CpusetCpus);
    assert.equal(h.requests.filter((r) => r.method === 'POST' && !r.route.endsWith('/update')).length, 0);
    await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
    assert.equal(h.requests.filter((r) => r.route.endsWith('/update')).length, 1, 'migration is idempotent');
  });

  test('explicit existing CPU affinity stays untouched even if wider than the default quota', async () => {
    const existing = quotaDesktop({ CpusetCpus: '4-7' });
    const h = desktopCpuHarness({ existing, readAffinityError: new Error('must not inspect host') });
    await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
    assert.deepEqual(h.getInfo(), existing);
    assert.equal(h.affinityReads(), 0);
    assert.equal(h.requests.filter((r) => r.method === 'POST').length, 0);
  });

  test('a stopped desktop receives affinity before start and keeps its existing identity', async () => {
    const existing = quotaDesktop({ NanoCpus: 0, CpuQuota: 150000, CpuPeriod: 100000 });
    existing.State.Running = false;
    const h = desktopCpuHarness({ existing, allowed: '3,7,9' });
    const out = await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
    const writes = h.requests.filter((r) => r.method === 'POST');
    assert.deepEqual(writes.map((r) => r.route.split('/').pop()), ['update', 'start']);
    assert.equal(cpuIds(writes[0].body.CpusetCpus).length, 2);
    assert.equal(out.created, false);
    assert.equal(out.info.Name, existing.Name);
  });

  test('legacy unlimited or unknown quotas are not replaced by current defaults', async () => {
    for (const extra of [{ NanoCpus: 0 }, { NanoCpus: 0, CpuQuota: -1, CpuPeriod: 100000 }]) {
      const h = desktopCpuHarness({ existing: quotaDesktop(extra) });
      await h.runtime.ensureContainer('sira-ac-user-cpu-qa');
      assert.equal(h.requests.filter((r) => r.method === 'POST').length, 0);
      assert.equal(h.affinityReads(), 0);
    }
  });

  test('affinity read/parse failures fail before creating an incorrectly sized desktop', async () => {
    for (const settings of [{ readAffinityError: new Error('EACCES') }, { allowed: '7-2' }, { allowed: '0,wat' }, { allowed: '' }]) {
      const h = desktopCpuHarness(settings);
      await assert.rejects(h.runtime.ensureContainer('sira-ac-user-cpu-qa'), { code: 'DESKTOP_CPU_AFFINITY_UNAVAILABLE' });
      assert.equal(h.requests.filter((r) => r.method === 'POST').length, 0);
    }
  });

  test('Docker update failures are surfaced without starting or recreating the desktop', async () => {
    const failure = Object.assign(new Error('Engine rejected update'), { status: 500 });
    const existing = quotaDesktop();
    existing.State.Running = false;
    const h = desktopCpuHarness({ existing, updateError: failure });
    await assert.rejects(h.runtime.ensureContainer('sira-ac-user-cpu-qa'), (err) => err === failure);
    assert.deepEqual(h.requests.filter((r) => r.method === 'POST').map((r) => r.route.split('/').pop()), ['update']);
    assert.deepEqual(h.getInfo(), existing);
  });
});

// Exercise execIn itself over a Unix-domain Docker Engine HTTP transport.
// The fixture executes the exact container helper with Node; no Docker CLI or
// injected execImpl participates in the runtime path under test.
async function dockerExecFixture(t, { createStatus = 201, startStatus = 101, inspectStatus = 200, holdCreate = false, holdStart = false, outputFrames, inspectBody } = {}) {
  const http = require('node:http');
  const os = require('node:os');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-exec-'));
  const socketPath = path.join(dir, 'engine.sock');
  const sockets = new Set(), children = new Set(), requests = [], execs = new Map();
  const originalPath = process.env.PATH;
  const frame = (socket, channel, bytes) => {
    const header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(bytes.length, 4);
    if (!socket.destroyed) { socket.write(header.subarray(0, 3)); socket.write(header.subarray(3)); socket.write(bytes); }
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ method: req.method, path: req.url, body });
    if (req.method === 'GET') {
      const exec = execs.get(req.url.split('/').at(-2));
      res.writeHead(inspectStatus, { 'Content-Type': 'application/json' });
      res.end(inspectStatus === 200 ? JSON.stringify(inspectBody || { Running: exec?.running, ExitCode: exec?.exitCode }) : 'private daemon credential');
      return;
    }
    if (holdCreate) return;
    if (createStatus !== 201) { res.writeHead(createStatus); res.end('private daemon credential'); return; }
    const id = String(execs.size + 1).padStart(64, 'a');
    execs.set(id, { body, running: true, exitCode: null });
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ Id: id }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let incoming = Buffer.concat([...chunks, head]);
    const length = Number(req.headers['content-length']);
    while (incoming.length < length) incoming = Buffer.concat([incoming, (await once(socket, 'data'))[0]]);
    assert.deepEqual(JSON.parse(incoming.subarray(0, length)), { Detach: false, Tty: false });
    if (holdStart) return;
    if (startStatus !== 101) { socket.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n'); return; }
    const exec = execs.get(req.url.split('/').at(-2));
    assert.ok(exec, 'start must use the created exec ID');
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    if (outputFrames) {
      exec.running = false; exec.exitCode = 0;
      for (const bytes of outputFrames) socket.write(bytes);
      socket.end();
      return;
    }
    assert.equal(exec.body.Cmd[0], 'node');
    const child = spawn(process.execPath, exec.body.Cmd.slice(1), {
      env: { ...process.env, PATH: originalPath, DISPLAY: ':1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    exec.pid = child.pid; children.add(child);
    child.stdin.on('error', () => {});
    socket.on('data', data => child.stdin.write(data));
    const closeInput = () => child.stdin.end();
    socket.on('end', closeInput); socket.on('close', closeInput);
    child.stdout.on('data', data => frame(socket, 1, data));
    child.stderr.on('data', data => frame(socket, 2, data));
    child.on('close', code => { children.delete(child); exec.running = false; exec.exitCode = code; socket.end(); });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of children) child.kill();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { runtime: createDockerRuntime({ socketPath }), requests, children, execs, sockets };
}

test('desktop exec uses Docker Engine without a local CLI and preserves separated output and exit status', async t => {
  const f = await dockerExecFixture(t);
  const priorPath = process.env.PATH;
  let result;
  try {
    process.env.PATH = '/fixture-without-docker-cli';
    result = await f.runtime.execIn('sira-ac-user-owned', "printf 'visible output'; printf 'private diagnostic' >&2", { timeoutMs: 3000 });
  } finally { process.env.PATH = priorPath; }
  assert.deepEqual(result, { ok: true, stdout: 'visible output', stderr: 'private diagnostic' });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].path, '/v1.44/containers/sira-ac-user-owned/exec');
  assert.equal(f.requests[0].body.User, 'compuser');
  assert.deepEqual(f.requests[0].body.Env, ['DISPLAY=:1']);
  assert.equal(f.requests[0].body.Tty, false);
  assert.equal(f.requests[1].method, 'GET');
  assert.match(f.requests[1].path, /^\/v1\.44\/exec\/[a-f0-9]{64}\/json$/);
});

async function execHelpersGone(f) {
  const deadline = Date.now() + 2000;
  while (f.children.size > 0 && Date.now() < deadline) await delay(10);
  assert.equal(f.children.size, 0, 'Engine disconnect must not leave the command helper running');
}

function dockerOutputFrame(channel, text) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const header = Buffer.alloc(8); header[0] = channel; header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

test('desktop exec nonzero status is rejected without command output in its error', async t => {
  const f = await dockerExecFixture(t);
  await assert.rejects(f.runtime.execIn('sira-ac-user-owned', "printf 'private stdout'; printf 'private stderr' >&2; exit 7"), error => {
    assert.equal(error.code, 'DOCKER_EXEC_FAILED'); assert.equal(error.exitCode, 7);
    assert.equal(error.status, 502); assert.equal(error.stdout, undefined); assert.equal(error.stderr, undefined);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /private|printf|credential/);
    return true;
  });
  await execHelpersGone(f);
});

test('desktop exec deadline stops the actual command group and closes the Engine stream', async t => {
  const f = await dockerExecFixture(t);
  const started = Date.now();
  await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'sleep 30', { timeoutMs: 250 }), { code: 'DOCKER_EXEC_TIMEOUT', status: 504 });
  assert.ok(Date.now() - started < 2000, 'one deadline bounds create/start/output/inspect');
  await execHelpersGone(f);
  for (const exec of f.execs.values()) if (exec.pid) assert.throws(() => process.kill(exec.pid, 0), { code: 'ESRCH' });
});

test('desktop exec cancellation terminates its command without waiting for the deadline', async t => {
  const f = await dockerExecFixture(t);
  const controller = new AbortController();
  const result = f.runtime.execIn('sira-ac-user-owned', 'sleep 30', { timeoutMs: 5000, signal: controller.signal });
  const rejected = assert.rejects(result, { code: 'DOCKER_EXEC_CANCELLED', status: 499 });
  const readyDeadline = Date.now() + 2000;
  while (!f.children.size && Date.now() < readyDeadline) await delay(10);
  assert.equal(f.children.size, 1);
  controller.abort(); await rejected; await execHelpersGone(f);
});

for (const stage of ['create', 'start']) {
  test(`desktop exec deadline also aborts a pending Engine ${stage}`, async t => {
    const f = await dockerExecFixture(t, stage === 'create' ? { holdCreate: true } : { holdStart: true });
    await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true', { timeoutMs: 100 }), { code: 'DOCKER_EXEC_TIMEOUT' });
    assert.equal(f.children.size, 0);
  });
}

for (const stage of ['create', 'start', 'inspect']) {
  test(`desktop exec fails closed on Engine ${stage} HTTP errors`, async t => {
    const f = await dockerExecFixture(t, { [`${stage}Status`]: 500 });
    await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true'), error => {
      assert.equal(error.code, 'DOCKER_EXEC_UNAVAILABLE');
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private|credential/);
      return true;
    });
  });
}

test('desktop exec demultiplexes fragmented UTF-8 output across stdout and stderr frames', async t => {
  const word = Buffer.from('Navegación ✓');
  const stream = Buffer.concat([dockerOutputFrame(1, word.subarray(0, 10)), dockerOutputFrame(2, 'diagnóstico'), dockerOutputFrame(1, word.subarray(10))]);
  const f = await dockerExecFixture(t, { outputFrames: [stream.subarray(0, 2), stream.subarray(2, 9), stream.subarray(9)] });
  const out = await f.runtime.execIn('sira-ac-user-owned', 'true');
  assert.deepEqual(out, { ok: true, stdout: 'Navegación ✓', stderr: 'diagnóstico' });
});

for (const kind of ['truncated-header', 'truncated-body', 'unknown-channel', 'oversized-frame', 'total-cap']) {
  test(`desktop exec rejects ${kind} without reporting successful output`, async t => {
    let frames;
    if (kind === 'truncated-header') frames = [Buffer.of(1, 0, 0)];
    if (kind === 'truncated-body') frames = [dockerOutputFrame(1, 'visible').subarray(0, 10)];
    if (kind === 'unknown-channel') frames = [dockerOutputFrame(9, 'visible')];
    if (kind === 'oversized-frame') { const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(16 * 1024 * 1024 + 1, 4); frames = [h]; }
    if (kind === 'total-cap') frames = [dockerOutputFrame(1, Buffer.alloc(8 * 1024 * 1024)), dockerOutputFrame(2, Buffer.alloc(8 * 1024 * 1024)), dockerOutputFrame(1, 'x')];
    const f = await dockerExecFixture(t, { outputFrames: frames });
    await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true'), { code: kind === 'total-cap' ? 'DOCKER_EXEC_OUTPUT_LIMIT' : 'DOCKER_EXEC_OUTPUT_INVALID' });
    assert.equal(f.requests.filter(row => row.method === 'GET').length, 0, 'invalid output cannot be acknowledged');
  });
}

test('desktop exec does not claim success without a completed, known ExitCode', async t => {
  for (const inspectBody of [{ Running: true, ExitCode: 0 }, { Running: false }, { Running: false, ExitCode: -1 }]) {
    const f = await dockerExecFixture(t, { inspectBody });
    await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true'), { code: 'DOCKER_EXEC_INCOMPLETE' });
  }
});

test('desktop exec validates owned container and deadline before reaching the Engine', async t => {
  const f = await dockerExecFixture(t);
  await assert.rejects(f.runtime.execIn('other-container', 'true'), { code: 'DOCKER_EXEC_INVALID' });
  await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true', { timeoutMs: 0 }), { code: 'DOCKER_EXEC_INVALID' });
  await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true', { timeoutMs: 120001 }), { code: 'DOCKER_EXEC_INVALID' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.execIn('sira-ac-user-owned', 'true', { signal: controller.signal }), { code: 'DOCKER_EXEC_CANCELLED' });
  assert.equal(f.requests.length, 0);
});

test('desktop exec preserves an intentionally detached app after a successful launch', async t => {
  const f = await dockerExecFixture(t);
  const result = await f.runtime.execIn('sira-ac-user-owned', 'sleep 30 >/dev/null 2>&1 & printf "%s" "$!"');
  const pid = Number(result.stdout);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    assert.doesNotThrow(() => process.kill(pid, 0), 'a successful launch must leave the app alive');
    await execHelpersGone(f);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch {} }
});
