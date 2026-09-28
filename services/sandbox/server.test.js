'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.SANDBOX_API_KEY = 'sandbox-capacity-test-key';
process.env.SANDBOX_MAX_CONCURRENCY = '8';
const { buildServer, sessions } = require('./server');
const { createDockerSession } = require('./lib/docker-sandbox');

const key = process.env.SANDBOX_API_KEY;
const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('concurrent creates reserve capacity before Docker startup completes', async () => {
  assert.equal(sessions.size, 0);
  let releaseCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  let started = 0;
  const server = buildServer({
    isDockerAvailable: async () => true,
    createSession: async () => {
      started += 1;
      await creationGate;
      return { destroy: async () => {} };
    },
  });
  const base = await listen(server);
  const ids = [];
  try {
    let seen = 0;
    let allSeen;
    const requestsSeen = new Promise((resolve) => { allSeen = resolve; });
    server.on('request', (req) => {
      if (req.method === 'POST' && req.url === '/v1/sessions' && ++seen === 9) allSeen();
    });
    const pending = Array.from({ length: 9 }, () => fetch(`${base}/v1/sessions`, {
      method: 'POST', headers: auth, body: '{}',
    }));
    await requestsSeen;
    await new Promise((resolve) => setImmediate(resolve));
    releaseCreation();
    const responses = await Promise.all(pending);
    const statuses = responses.map((response) => response.status).sort();
    for (const response of responses) {
      if (response.status === 201) ids.push((await response.json()).sessionId);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 201, 201, 429]);
    assert.equal(started, 8, 'a rejected request must never launch a ninth container');
    assert.equal(sessions.size, 8);
  } finally {
    releaseCreation();
    await Promise.all(ids.map((id) => fetch(`${base}/v1/sessions/${id}`, { method: 'DELETE', headers: auth })));
    await close(server);
    sessions.clear();
  }
});

test('DELETE keeps its capacity slot until container removal completes', async () => {
  assert.equal(sessions.size, 0);
  let releaseRemoval;
  const removalGate = new Promise((resolve) => { releaseRemoval = resolve; });
  let removalStarted;
  const removalEntered = new Promise((resolve) => { removalStarted = resolve; });
  let created = 0;
  const server = buildServer({
    isDockerAvailable: async () => true,
    createSession: async () => {
      created += 1;
      const first = created === 1;
      return { destroy: async () => { if (first) { removalStarted(); await removalGate; } } };
    },
  });
  const base = await listen(server);
  const ids = [];
  try {
    for (let i = 0; i < 8; i += 1) {
      const response = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
      assert.equal(response.status, 201);
      ids.push((await response.json()).sessionId);
    }
    const removing = fetch(`${base}/v1/sessions/${ids[0]}`, { method: 'DELETE', headers: auth });
    await removalEntered;
    const blocked = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(blocked.status, 429);
    assert.equal(created, 8);
    releaseRemoval();
    assert.equal((await removing).status, 200);
    const allowed = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(allowed.status, 201);
    ids.push((await allowed.json()).sessionId);
  } finally {
    releaseRemoval();
    await Promise.all(ids.map((id) => fetch(`${base}/v1/sessions/${id}`, { method: 'DELETE', headers: auth })));
    await close(server);
    sessions.clear();
  }
});

test('failed container removal retains its slot until a successful retry', async () => {
  assert.equal(sessions.size, 0);
  let created = 0;
  let removalAttempts = 0;
  const server = buildServer({
    isDockerAvailable: async () => true,
    createSession: async () => {
      created += 1;
      const first = created === 1;
      return { destroy: async () => {
        if (first && ++removalAttempts === 1) throw new Error('simulated Docker removal failure');
      } };
    },
  });
  const base = await listen(server);
  const ids = [];
  try {
    for (let i = 0; i < 8; i += 1) {
      const createdResponse = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
      ids.push((await createdResponse.json()).sessionId);
    }
    assert.equal((await fetch(`${base}/v1/sessions/${ids[0]}`, { method: 'DELETE', headers: auth })).status, 500);
    assert.equal(sessions.size, 8);
    assert.equal((await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' })).status, 429);
    assert.equal((await fetch(`${base}/v1/sessions/${ids[0]}`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal(removalAttempts, 2);
    const allowed = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(allowed.status, 201);
    ids.push((await allowed.json()).sessionId);
  } finally {
    await Promise.all(ids.map((id) => fetch(`${base}/v1/sessions/${id}`, { method: 'DELETE', headers: auth })));
    await close(server);
    sessions.clear();
  }
});

test('a disconnected creator does not leave an unowned container', async () => {
  assert.equal(sessions.size, 0);
  let releaseCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  let creationStarted;
  const creationEntered = new Promise((resolve) => { creationStarted = resolve; });
  let removals = 0;
  const server = buildServer({
    isDockerAvailable: async () => true,
    createSession: async () => {
      creationStarted();
      await creationGate;
      return { destroy: async () => { removals += 1; } };
    },
  });
  let socketClosed;
  const disconnected = new Promise((resolve) => { socketClosed = resolve; });
  server.on('request', (req) => {
    if (req.method === 'POST' && req.url === '/v1/sessions') req.socket.once('close', socketClosed);
  });
  await listen(server);
  try {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/v1/sessions', method: 'POST',
      headers: { ...auth, 'Content-Length': '2' },
    });
    req.on('error', () => {});
    req.end('{}');
    await creationEntered;
    req.destroy();
    await disconnected;
    releaseCreation();
    for (let i = 0; i < 20 && removals === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(removals, 1);
    assert.equal(sessions.size, 0);
  } finally {
    releaseCreation();
    await close(server);
    sessions.clear();
  }
});

test('disconnect during Docker probe releases reservation without reading an ended request', async () => {
  assert.equal(sessions.size, 0);
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let probeStarted;
  const probeEntered = new Promise((resolve) => { probeStarted = resolve; });
  let starts = 0;
  const server = buildServer({
    isDockerAvailable: async () => { probeStarted(); await probeGate; return true; },
    createSession: async () => { starts += 1; return { destroy: async () => {} }; },
  });
  let socketClosed;
  const disconnected = new Promise((resolve) => { socketClosed = resolve; });
  server.on('request', (req) => {
    if (req.method === 'POST' && req.url === '/v1/sessions') req.socket.once('close', socketClosed);
  });
  const base = await listen(server);
  try {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/v1/sessions', method: 'POST',
      headers: { ...auth, 'Content-Length': '4' },
    });
    req.on('error', () => {});
    req.write('{');
    await probeEntered;
    req.destroy();
    await disconnected;
    releaseProbe();
    await new Promise((resolve) => setImmediate(resolve));
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.pendingCreates, 0);
    assert.equal(starts, 0);
    assert.equal(sessions.size, 0);
  } finally {
    releaseProbe();
    await close(server);
    sessions.clear();
  }
});

test('failed creation releases its reservation for the next request', async () => {
  assert.equal(sessions.size, 0);
  let calls = 0;
  const server = buildServer({
    isDockerAvailable: async () => true,
    createSession: async () => {
      calls += 1;
      if (calls === 1) throw new Error('simulated Docker failure');
      return { destroy: async () => {} };
    },
  });
  const base = await listen(server);
  try {
    const first = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(first.status, 500);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.pendingCreates, 0);
    const second = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(second.status, 201);
    const id = (await second.json()).sessionId;
    assert.equal((await fetch(`${base}/v1/sessions/${id}`, { method: 'DELETE', headers: auth })).status, 200);
  } finally {
    await close(server);
    sessions.clear();
  }
});

test('Docker startup removes a container if staging fails after docker run', async () => {
  const calls = [];
  await assert.rejects(createDockerSession({
    processRunner: async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: 'container-id', stderr: '' };
    },
    makeStage: async () => { throw new Error('staging unavailable'); },
  }), /staging unavailable/);
  assert.equal(calls[0][0], 'run');
  assert.equal(calls[1][0], 'rm');
  assert.equal(calls[1][1], '-f');
  assert.equal(calls[1][2], calls[0][calls[0].indexOf('--name') + 1]);
});

test('Docker run timeout attempts removal by its known container name', async () => {
  const calls = [];
  await assert.rejects(createDockerSession({
    processRunner: async (_command, args) => {
      calls.push(args);
      return args[0] === 'run'
        ? { exitCode: 124, stdout: '', stderr: 'timed out' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  }), /docker run failed/);
  assert.equal(calls[0][0], 'run');
  assert.equal(calls[1][0], 'rm');
  assert.equal(calls[1][2], calls[0][calls[0].indexOf('--name') + 1]);
});
