'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createAgentesCodingRouter } = require('../src/routes/agentes-coding');
const { createCodingSandbox, resolveDriverName } = require('../src/services/agentes-coding/coding-sandbox');
const { resolveLimits, resolveExecTimeout } = require('../src/services/agentes-coding/coding-sandbox/limits');
const { isAgentesCodingV2Enabled } = require('../src/services/agentes-coding/flags');
const terminal = require('../src/services/agentes-coding/terminal');

const ON = { AGENTES_CODING_V2: '1' };
const make = (opts = {}) => createCodingSandbox({ env: ON, autoGc: false, ...opts });

test('production cannot enable the DEV coding runtime through a flag', async () => {
  const env = { NODE_ENV: 'production', AGENTES_CODING_V2: 'true' };
  assert.equal(isAgentesCodingV2Enabled(env), false);
  await assert.rejects(make({ env }).createSession(), { code: 'E_FLAG_OFF' });
});

test('unknown executor fails closed and memory does not claim execution', async () => {
  assert.throws(() => resolveDriverName({}, 'not-a-driver'), { code: 'E_PROVIDER' });
  const sb = make();
  const session = await sb.createSession({ userId: 'owner' });
  await assert.rejects(sb.exec(session.id, 'exit 42'), { code: 'E_PROVIDER' });
  await sb.destroy(session.id);
});

test('atomic session reservations enforce capacity while provider is pending', { timeout: 1000 }, async () => {
  let release;
  const sb = make({ env: { ...ON, AGENTES_CODING_SANDBOX_MAX_SESSIONS: '1' }, driver: 'docker', docker: {
    exec: () => new Promise(resolve => { release = resolve; }),
  } });
  const first = sb.createSession({ userId: 'owner' });
  await assert.rejects(sb.createSession({ userId: 'other' }), { code: 'E_QUOTA' });
  release({ exitCode: 0, stdout: '', stderr: '' });
  await first;
});

test('failed provider releases capacity and duplicate in-flight IDs are rejected', { timeout: 1000 }, async () => {
  let attempts = 0;
  const sb = make({ env: { ...ON, AGENTES_CODING_SANDBOX_MAX_SESSIONS: '1' }, driver: 'docker', docker: {
    async exec() { attempts += 1; return { exitCode: attempts === 1 ? 1 : 0 }; },
  } });
  await assert.rejects(sb.createSession({ userId: 'owner' }), { code: 'E_PROVIDER' });
  assert.ok((await sb.createSession({ userId: 'owner' })).id);
  let release;
  const concurrent = make({ driver: 'docker', docker: {
    exec: () => new Promise(resolve => { release = resolve; }),
  } });
  const first = concurrent.createSession({ id: 'fixture-id' });
  await assert.rejects(concurrent.createSession({ id: 'fixture-id' }), { code: 'E_PARAMS' });
  release({ exitCode: 0 });
  await first;
});

test('CPU and memory accept bounded values only, respecting operator ceilings', () => {
  for (const field of ['cpus', 'memory']) {
    for (const value of ['0', 0, -1, 'NaN', 'Infinity', '', [], {}, true, '1 --privileged']) {
      assert.throws(() => resolveLimits({ [field]: value }, {}), { code: 'E_PARAMS' });
    }
  }
  assert.throws(() => resolveLimits({ cpus: '2' }, {}), { code: 'E_QUOTA' });
  assert.throws(() => resolveLimits({ memory: '1g' }, {}), { code: 'E_QUOTA' });
  assert.throws(() => resolveLimits({}, { AGENTES_CODING_SANDBOX_CPUS: '0' }), { code: 'E_PROVIDER' });
  const limits = resolveLimits({ cpus: '0.5', memory: '256M' }, {});
  assert.equal(limits.cpus, '0.5');
  assert.equal(limits.memory, '256m');
  assert.equal(resolveLimits({ memory: '512m' }, { AGENTES_CODING_SANDBOX_MEMORY: '1g' }).memory, '512m');
  assert.equal(resolveExecTimeout(900000, limits), limits.timeoutMs);
  assert.equal(resolveExecTimeout(20, limits), 20);
  assert.throws(() => resolveExecTimeout(Infinity, limits), { code: 'E_PARAMS' });
});

test('owner guard neither leaks existence nor extends a rejected lease', async () => {
  let now = 1000;
  const sb = make({ now: () => now });
  const session = await sb.createSession({ userId: 'owner', ttlMs: 1000 });
  now = 1500;
  for (const user of ['other', '', null, undefined]) {
    assert.throws(() => sb.assertSessionOwner(session.id, user), { code: 'E_SESSION_NOT_FOUND' });
  }
  assert.equal(sb.getSession(session.id).expiresAt, session.expiresAt);
  assert.equal(sb.assertSessionOwner(session.id, 'owner').id, session.id);
  now = 2000;
  assert.throws(() => sb.assertSessionOwner(session.id, 'owner'), { code: 'E_SESSION_EXPIRED' });
  assert.throws(() => sb.assertSessionOwner(session.id, 'other'), { code: 'E_SESSION_NOT_FOUND' });
});

test('HTTP/SSE session actions enforce identity before files, maps, edits and terminal access', async (t) => {
  const sb = make();
  let executions = 0;
  const session = await sb.createSession({ userId: 'owner', execImpl: async () => {
    executions += 1; return { exitCode: 0, stdout: 'fixture' };
  } });
  await sb.writeFile(session.id, 'fixture.txt', 'original');
  const hub = terminal.createTerminalHub({ env: ON, sandbox: sb });
  const channel = await hub.open({ sessionId: session.id });
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: ON, sandbox: sb, terminalHub: hub,
    authenticate(req, res, next) {
      if (!req.headers['x-fixture-user']) return res.status(401).json({ error: 'unauthorized' });
      req.user = { id: req.headers['x-fixture-user'] }; return next();
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); sb.stopGc(); });
  const base = `http://127.0.0.1:${server.address().port}/api/agentes-coding`;
  const root = `/sessions/${session.id}`;
  const term = `/terminal/${channel.channelId}`;
  const actions = [
    ['POST', '/exec'], ['GET', '/files'], ['POST', '/read'], ['PUT', '/files'],
    ['GET', '/map'], ['POST', '/map'], ['POST', '/struct-edit'], ['POST', '/struct-edit/apply'],
    ['POST', '/terminal'], ['GET', term], ['POST', `${term}/input`], ['POST', `${term}/resize`],
    ['POST', `${term}/exec`], ['GET', `${term}/stream`], ['DELETE', term], ['POST', '/expose'],
    ['POST', '/preview'], ['GET', '/preview'], ['GET', '/ports'],
    ['POST', '/git/init'], ['GET', '/git/status'], ['GET', '/git/diff'],
    ['POST', '/git/checkpoint'], ['GET', '/git/checkpoints'],
    ['POST', '/export'], ['GET', '/export'], ['POST', '/deploy'], ['GET', '/deploy'],
    ['DELETE', ''],
  ];
  const request = (method, route, user) => fetch(`${base}${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-fixture-user': user } : {}) },
    ...(method !== 'GET' ? { body: JSON.stringify({ path: 'fixture.txt', content: 'changed', command: 'echo fixture' }) } : {}),
    signal: AbortSignal.timeout(3000),
  });
  for (const [method, route] of actions) {
    const response = await request(method, root + route, 'other');
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.equal((await response.json()).error, 'E_SESSION_NOT_FOUND');
  }
  assert.equal(executions, 0);
  assert.equal((await sb.readFile(session.id, 'fixture.txt')).toString(), 'original');
  assert.equal(hub.get(channel.channelId).closed, false);
  assert.equal((await request('POST', root + '/read')).status, 401);
  const read = await request('POST', root + '/read', 'owner');
  assert.equal(read.status, 200);
  assert.equal((await read.json()).content, 'original');
  assert.equal((await request('POST', root + '/exec', 'owner')).status, 200);
  assert.equal(executions, 1);
  assert.equal((await request('DELETE', root, 'owner')).status, 200);
  assert.equal(sb.getSession(session.id), null);
});

test('WebSocket default auth validates persisted sessions and rejects scoped/expired/invalid tokens', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  let active = true;
  const opts = { jwtSecret: secret, prismaClient: { session: {
    async findUnique() { return active ? { id: 's', userId: 'owner', user: { id: 'owner' }, expiresAt: new Date(Date.now() + 60000) } : null; },
  } } };
  const authenticate = token => terminal.defaultWsAuthenticate({ headers: { authorization: `Bearer ${token}` } }, opts);
  const valid = jwt.sign({ userId: 'owner' }, secret, { expiresIn: 60 });
  assert.equal((await authenticate(valid)).userId, 'owner');
  assert.equal(await authenticate('not-a-session'), null);
  assert.equal(await authenticate(jwt.sign({ userId: 'owner', scope: 'pairing' }, secret)), null);
  assert.equal(await authenticate(jwt.sign({ userId: 'owner', exp: 1 }, secret)), null);
  active = false;
  assert.equal(await authenticate(valid), null);
});

test('WebSocket channel authorization requires its owner and rechecks before commands', async () => {
  const sb = make();
  let executions = 0;
  const session = await sb.createSession({ userId: 'owner', execImpl: async () => {
    executions += 1; return { exitCode: 0, stdout: '' };
  } });
  const hub = terminal.createTerminalHub({ env: ON, sandbox: sb });
  const channel = await hub.open({ sessionId: session.id });
  for (const identity of [null, { token: true }, { userId: 'other' }, { userId: 'owner' }]) {
    let current = identity;
    const sent = []; const closed = []; const handlers = {};
    const socket = { readyState: 1, send: x => sent.push(JSON.parse(x)), close: x => closed.push(x), on: (ev, fn) => { handlers[ev] = fn; } };
    class FakeServer {
      on(event, handler) { if (event === 'connection') this.connect = handler; }
      handleUpgrade() {}
      close() {}
    }
    const server = http.createServer();
    const binding = terminal.attachTerminalWebSocket(server, { env: ON, hub, WebSocketServer: FakeServer, authenticate: () => current });
    binding.wss.connect(socket, { url: `/?channelId=${channel.channelId}` });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.some(f => f.type === 'ready'), identity?.userId === 'owner');
    if (identity?.userId === 'owner') {
      current = null;
      handlers.message(JSON.stringify({ type: 'exec', command: 'fixture' }));
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(closed.includes(4401));
    } else assert.ok(closed.length);
    binding.detach();
  }
  assert.equal(executions, 0);
});
