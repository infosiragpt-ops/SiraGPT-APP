'use strict';

/**
 * agentes-coding/terminal — PTY stub + injectable transport
 * (AGENTES_CODING_V2 Phase 3d). No real xterm.js / node-pty in CI.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const term = require('../src/services/agentes-coding/terminal');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');
const { jailRelPath } = require('../src/services/agentes-coding/coding-sandbox/path-jail');

const ON = { AGENTES_CODING_V2: '1' };

function sandbox(extra = {}) {
  return createCodingSandbox({ env: { ...ON, ...extra.env }, autoGc: false, ...extra });
}

function echoExec() {
  return async (cmd) => ({ exitCode: 0, stdout: `out:${cmd}\n`, stderr: '' });
}

async function seeded(execImpl = echoExec()) {
  const sb = sandbox();
  const session = await sb.createSession({ userId: 'terminal-owner', execImpl });
  const hub = term.createTerminalHub({ env: ON, sandbox: sb });
  return { sb, session, hub };
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(err.message, /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|ruta|terminal|comando|Tope|válid|tiempo|canal/i);
  return true;
}

test('flag off is E_FLAG_OFF in Spanish', async () => {
  const sb = createCodingSandbox({ env: {}, autoGc: false });
  const hub = term.createTerminalHub({ env: {}, sandbox: sb });
  await assert.rejects(
    () => hub.open({ sessionId: 'csb_x' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('open attaches memory transport and emits ready', async () => {
  const { session, hub } = await seeded();
  const transport = term.createMemoryTransport();
  const snap = await hub.open({ sessionId: session.id, cols: 100, rows: 30, transport });
  assert.match(snap.channelId, /^trm_[a-f0-9]{20}$/);
  assert.equal(snap.sessionId, session.id);
  assert.equal(snap.cols, 100);
  assert.equal(snap.rows, 30);
  assert.equal(transport.sent[0].type, 'ready');
  assert.equal(transport.sent[0].channelId, snap.channelId);
});

test('exec streams stdout/stderr/exit on the injected transport', async () => {
  const { session, hub } = await seeded();
  const transport = term.createMemoryTransport();
  const snap = await hub.open({ sessionId: session.id, transport });
  await hub.handleFrame(snap.channelId, { type: 'exec', command: 'pwd' });
  const types = transport.sent.map((f) => f.type);
  assert.ok(types.includes('stdout'));
  assert.ok(types.includes('exit'));
  const out = transport.sent.find((f) => f.type === 'stdout');
  assert.equal(out.data, 'out:pwd\n');
  const exit = transport.sent.find((f) => f.type === 'exit');
  assert.equal(exit.exitCode, 0);
});

test('newline-terminated input runs exec (line-buffered PTY stub)', async () => {
  const { session, hub } = await seeded();
  const transport = term.createMemoryTransport();
  const snap = await hub.open({ sessionId: session.id, transport });
  await hub.handleFrame(snap.channelId, { type: 'input', data: 'ls -la\n' });
  const out = transport.sent.find((f) => f.type === 'stdout');
  assert.equal(out.data, 'out:ls -la\n');
});

test('cwd ../ is E_PATH_ESCAPE in Spanish', async () => {
  const { session, hub } = await seeded();
  await assert.rejects(
    () => hub.open({ sessionId: session.id, cwd: '../etc' }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});

test('absolute host cwd is E_PATH_ESCAPE', async () => {
  const { session, hub } = await seeded();
  await assert.rejects(
    () => hub.open({ sessionId: session.id, cwd: '/etc/passwd' }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});

test('jailCwd maps /workspace and rejects control chars', () => {
  assert.equal(term.jailCwd('/workspace'), '.');
  assert.equal(term.jailCwd('src/app'), 'src/app');
  assert.throws(() => term.jailCwd('../x'), (e) => e.code === 'E_PATH_ESCAPE');
  assert.throws(() => jailRelPath('src/\u0000x'), (e) => e.code === 'E_PATH_ESCAPE');
});

test('resize stores cols/rows for a later xterm FitAddon', async () => {
  const { session, hub } = await seeded();
  const snap = await hub.open({ sessionId: session.id });
  const next = hub.get(snap.channelId).resize(120, 40);
  assert.equal(next.cols, 120);
  assert.equal(next.rows, 40);
});

test('unknown session is E_SESSION_NOT_FOUND', async () => {
  const hub = term.createTerminalHub({ env: ON, sandbox: sandbox() });
  await assert.rejects(
    () => hub.open({ sessionId: 'csb_missing' }),
    (err) => spanishError(err, 'E_SESSION_NOT_FOUND'),
  );
});

test('close broadcasts closed and forgets the channel', async () => {
  const { session, hub } = await seeded();
  const transport = term.createMemoryTransport();
  const snap = await hub.open({ sessionId: session.id, transport });
  hub.close(snap.channelId);
  assert.ok(transport.sent.some((f) => f.type === 'closed'));
  assert.throws(() => hub.get(snap.channelId), (e) => e.code === 'E_SESSION_NOT_FOUND');
});

test('more than four channels per session is E_QUOTA', async () => {
  const { session, hub } = await seeded();
  for (let i = 0; i < term.MAX_CHANNELS_PER_SESSION; i += 1) {
    await hub.open({ sessionId: session.id });
  }
  await assert.rejects(
    () => hub.open({ sessionId: session.id }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('empty command is E_PARAMS in Spanish', async () => {
  const { session, hub } = await seeded();
  const snap = await hub.open({ sessionId: session.id });
  await assert.rejects(
    () => hub.handleFrame(snap.channelId, { type: 'exec', command: '   ' }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('input over the byte cap is E_QUOTA', async () => {
  const { session, hub } = await seeded();
  const snap = await hub.open({ sessionId: session.id });
  const huge = 'x'.repeat(70 * 1024);
  await assert.rejects(
    () => hub.handleFrame(snap.channelId, { type: 'input', data: huge }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('SIGINT aborts a running execImpl (E_CANCELLED)', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { session, hub } = await seeded(async () => {
    await pending;
    return { exitCode: 0, stdout: 'late', stderr: '' };
  });
  const transport = term.createMemoryTransport();
  const snap = await hub.open({ sessionId: session.id, transport });
  const running = hub.handleFrame(snap.channelId, { type: 'exec', command: 'sleep' });
  await new Promise((r) => setImmediate(r));
  hub.handleFrame(snap.channelId, { type: 'signal', name: 'SIGINT' });
  release();
  await assert.rejects(running, (err) => spanishError(err, 'E_CANCELLED'));
  assert.ok(transport.sent.some((f) => f.type === 'error' && f.error === 'E_CANCELLED'));
});

test('memory driver timeout surfaces as exit timedOut=true', async () => {
  const sb = sandbox();
  const session = await sb.createSession({
    execImpl: () => new Promise((resolve) => {
      setTimeout(() => resolve({ exitCode: 0, stdout: 'late', stderr: '' }), 80);
    }),
  });
  const hub = term.createTerminalHub({ env: ON, sandbox: sb });
  const transport = term.createMemoryTransport();
  const snap = await hub.open({ sessionId: session.id, transport });
  await hub.handleFrame(snap.channelId, { type: 'exec', command: 'slow', timeoutMs: 15 });
  const exit = transport.sent.find((f) => f.type === 'exit');
  assert.ok(exit);
  assert.equal(exit.timedOut, true);
  assert.equal(exit.exitCode, 124);
});

test('decodeFrame rejects garbage and unknown types', () => {
  assert.throws(() => term.decodeFrame('not-json'), (e) => e.code === 'E_PARAMS');
  assert.throws(() => term.decodeFrame({ type: 'explode' }), (e) => e.code === 'E_PARAMS');
  assert.deepEqual(term.decodeFrame('{"type":"input","data":"a"}').type, 'input');
});

test('encodeSse writes event + data without vendor ids', () => {
  const sse = term.encodeSse({ type: 'stdout', data: 'hola' });
  assert.match(sse, /^event: stdout\n/);
  assert.match(sse, /data: \{"type":"stdout","data":"hola"\}/);
  assert.doesNotMatch(sse, /OpenRouter|DeepSeek|xterm\.js|model_id/);
});

test('WebSocket transport uses the injected socket (no real PTY)', async () => {
  const sent = [];
  const handlers = {};
  const socket = {
    readyState: 1,
    send(data) { sent.push(data); },
    on(ev, fn) { handlers[ev] = fn; },
    close() { this.readyState = 3; },
  };
  const transport = term.createWebSocketTransport(socket);
  const { session, hub } = await seeded();
  const snap = await hub.open({ sessionId: session.id, transport });
  assert.match(sent[0], /"type":"ready"/);
  handlers.message(JSON.stringify({ type: 'exec', command: 'echo' }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((row) => String(row).includes('"type":"stdout"')));
  assert.equal(snap.sessionId, session.id);
});

test('attachTerminalWebSocket refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: {}, autoGc: false });
  const hub = term.createTerminalHub({ env: {}, sandbox: sb });
  const server = http.createServer();
  const closed = [];
  const FakeServer = function FakeServer() {
    this.listeners = {};
  };
  FakeServer.prototype.on = function on(ev, fn) {
    this.listeners[ev] = fn;
  };
  FakeServer.prototype.emit = function emit(ev, ...args) {
    if (this.listeners[ev]) this.listeners[ev](...args);
  };
  FakeServer.prototype.handleUpgrade = function handleUpgrade(_req, _sock, _head, cb) {
    cb({
      close(code, reason) { closed.push({ code, reason }); },
      send() {},
      on() {},
    });
  };
  FakeServer.prototype.close = function close() {};
  const binding = term.attachTerminalWebSocket(server, {
    hub,
    env: {},
    WebSocketServer: FakeServer,
    authenticate: () => ({ userId: 'terminal-owner' }),
  });
  const upgrade = server.listeners('upgrade')[0];
  upgrade({ url: '/api/agentes-coding/terminal?channelId=trm_x' }, { destroyed: false }, Buffer.alloc(0));
  await new Promise((r) => setImmediate(r));
  assert.equal(closed[0].code, 4404);
  binding.detach();
});

test('attachTerminalWebSocket binds an existing channel when authenticated', async () => {
  const { session, hub } = await seeded();
  const opened = await hub.open({ sessionId: session.id });
  const server = http.createServer();
  const sent = [];
  const FakeServer = function FakeServer() {
    this.listeners = {};
  };
  FakeServer.prototype.on = function on(ev, fn) {
    this.listeners[ev] = fn;
  };
  FakeServer.prototype.emit = function emit(ev, ...args) {
    if (this.listeners[ev]) this.listeners[ev](...args);
  };
  FakeServer.prototype.handleUpgrade = function handleUpgrade(_req, _sock, _head, cb) {
    cb({
      readyState: 1,
      send(data) { sent.push(data); },
      on() {},
      close() {},
    });
  };
  FakeServer.prototype.close = function close() {};
  const binding = term.attachTerminalWebSocket(server, {
    hub,
    env: ON,
    WebSocketServer: FakeServer,
    authenticate: () => ({ userId: 'terminal-owner' }),
  });
  const upgrade = server.listeners('upgrade')[0];
  upgrade(
    { url: `/api/agentes-coding/terminal?channelId=${opened.channelId}` },
    { destroyed: false },
    Buffer.alloc(0),
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((row) => String(row).includes('"type":"ready"')));
  binding.detach();
});

test('error catalog includes E_TERMINAL_FAILED in Spanish', () => {
  assert.ok(CATALOG.E_TERMINAL_FAILED);
  assert.match(CATALOG.E_TERMINAL_FAILED.message, /terminal/i);
  assert.match(CATALOG.E_FLAG_OFF.message, /desactiv/i);
  assert.match(CATALOG.E_PATH_ESCAPE.message, /ruta/i);
});

test('POST /sessions/:id/terminal is 404 when the flag is off', async () => {
  let express;
  let createAgentesCodingRouter;
  try {
    express = require('express');
    ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
  } catch {
    return;
  }
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
        path: '/api/agentes-coding/sessions/csb_x/terminal',
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

test('HTTP open + exec + SSE ready when flag is on (injectable auth)', async () => {
  let express;
  let createAgentesCodingRouter;
  try {
    express = require('express');
    ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
  } catch {
    return;
  }
  const sb = sandbox();
  const session = await sb.createSession({ userId: 'terminal-owner', execImpl: echoExec() });
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'terminal-owner' }; next(); },
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
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const opened = await request('POST', `/api/agentes-coding/sessions/${session.id}/terminal`, {
      cols: 80,
      rows: 24,
    });
    assert.equal(opened.status, 201);
    const payload = JSON.parse(opened.body);
    assert.ok(payload.channel.channelId);
    assert.match(payload.wsPath, /\/api\/agentes-coding\/terminal\?channelId=/);
    const execed = await request(
      'POST',
      `/api/agentes-coding/sessions/${session.id}/terminal/${payload.channel.channelId}/exec`,
      { command: 'uname' },
    );
    assert.equal(execed.status, 200);
    const stream = await new Promise((resolve, reject) => {
      const port = server.address().port;
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: `/api/agentes-coding/sessions/${session.id}/terminal/${payload.channel.channelId}/stream`,
      }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes('event: ready')) {
            req.destroy();
            resolve(buf);
          }
        });
        res.on('error', reject);
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNRESET') return;
        reject(err);
      });
    });
    assert.match(stream, /event: ready/);
    assert.doesNotMatch(stream, /OpenRouter|model_id/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts terminal + keeps flag 404 helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/terminal/);
  assert.match(src, /terminal\/:channelId\/stream/);
  assert.match(src, /createTerminalHub/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /daytona|OpenRouter|node-pty|@xterm\/xterm/i);
});

test('index.js attaches the terminal WebSocket after realtime', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(src, /attachTerminalWebSocket/);
  assert.match(src, /agentes_coding_terminal_ws_init_failed/);
});

test('closeSession drops every channel of a destroyed workspace', async () => {
  const { session, hub } = await seeded();
  const a = await hub.open({ sessionId: session.id });
  const b = await hub.open({ sessionId: session.id });
  assert.equal(hub.closeSession(session.id), 2);
  assert.throws(() => hub.get(a.channelId), (e) => e.code === 'E_SESSION_NOT_FOUND');
  assert.throws(() => hub.get(b.channelId), (e) => e.code === 'E_SESSION_NOT_FOUND');
});

test('exec cwd jail is enforced on the exec frame', async () => {
  const { session, hub } = await seeded();
  const snap = await hub.open({ sessionId: session.id, cwd: 'src' });
  await assert.rejects(
    () => hub.handleFrame(snap.channelId, { type: 'exec', command: 'ls', cwd: '../../secret' }),
    (err) => spanishError(err, 'E_PATH_ESCAPE'),
  );
});
