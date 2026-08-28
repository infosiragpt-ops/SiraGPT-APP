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
      novnc.listen(port, '127.0.0.1', () => { listening = true; });
    }, 280);

    const runtime = createDockerRuntime({
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

  test('POST /sessions returns 503 when noVNC never accepts', async () => {
    const userId = 'deadnovnc';
    const container = containerNameFor(userId);
    const runtime = createDockerRuntime({
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
