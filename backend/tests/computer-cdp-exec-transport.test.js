'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { createOrchestrator } = require('../../services/computer-orchestrator/server');
const { proxyHttp, proxyUpgrade } = require('../../services/computer-orchestrator/http-proxy');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const waitUntil = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'transport resources were not released'); await new Promise(r => setTimeout(r, 10)); }
};

async function fixture(t, { failCreate = false, failConnect = false, holdCreate = false, holdStart = false, frameError = null, failStart = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-cdp-'));
  const engineSocket = path.join(dir, 'engine.sock');
  const sockets = new Set();
  const children = new Set(), pids = [], execs = new Map(), requests = [], received = [];
  let childStarts = 0, createAborts = 0;
  let releaseCreate; const createGate = new Promise(resolve => { releaseCreate = resolve; });
  let releaseStart; const startGate = new Promise(resolve => { releaseStart = resolve; });
  const wsServer = new WebSocketServer({ noServer: true });
  const cdp = http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    if (req.url === '/hang') return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'fixture Chrome', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/existing-profile' }));
  });
  cdp.on('upgrade', (req, socket, head) => {
    received.push({ path: req.url, headers: req.headers });
    wsServer.handleUpgrade(req, socket, head, ws => {
      ws.on('message', data => ws.send(data));
    });
  });
  await listen(cdp);
  const cdpPort = cdp.address().port;
  const secondCdp = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ Browser: 'second isolated Chrome' })); });
  await listen(secondCdp);
  const frame = (socket, stream, bytes) => {
    if (socket.destroyed) return;
    const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4);
    // Deliberately fragment Docker frame headers, not only WebSocket messages.
    socket.write(header.subarray(0, 3)); socket.write(header.subarray(3)); socket.write(bytes);
  };
  const engine = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url, body });
    res.once('close', () => { if (!res.writableFinished) createAborts++; });
    if (holdCreate) await createGate;
    if (failCreate) { res.writeHead(500); res.end('private daemon diagnostic'); return; }
    const id = (execs.size + 1).toString(16).padStart(64, '0'); execs.set(id, { ...body, containerName: req.url.split('/')[3] });
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ Id: id }));
  });
  engine.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const id = req.url.split('/').at(-2), exec = execs.get(id);
    assert.ok(exec, 'start must use the ID returned by create');
    // Node24 exposes the unread Upgrade body in head; Node26 exposes req data.
    // Consume Content-Length exactly once; only later bytes belong to stdin.
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let incoming = Buffer.concat([...chunks, head]);
    const length = Number(req.headers['content-length']);
    assert.ok(Number.isSafeInteger(length) && length > 0 && length <= 65536);
    while (incoming.length < length) incoming = Buffer.concat([incoming, (await once(socket, 'data'))[0]]);
    assert.deepEqual(JSON.parse(incoming.subarray(0, length)), { Detach: false, Tty: false });
    const extra = incoming.subarray(length);
    if (failStart) { socket.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n'); return; }
    if (!holdStart) socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    assert.deepEqual(exec.Cmd.slice(0, 2), ['node', '-e']);
    assert.equal(exec.User, 'compuser'); assert.equal(exec.Tty, false);
    assert.equal(exec.AttachStdin, true); assert.equal(exec.AttachStdout, true); assert.equal(exec.AttachStderr, true);
    // The fixture represents the container network namespace. Only remap the
    // fixed loopback endpoint to its ephemeral test port; execute the real helper.
    const mapping = `const net=require('node:net');const real=net.connect;net.connect=(options)=>{if(options.host!=='127.0.0.1'||options.port!==9222)throw Error('unexpected endpoint');return real({...options,port:${failConnect ? 1 : exec.containerName === 'sira-ac-user-second' ? secondCdp.address().port : cdpPort}})};\n`;
    const child = spawn(process.execPath, ['-e', mapping + exec.Cmd[2]], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); pids.push(child.pid); childStarts++;
    child.stdin.on('error', () => {});
    socket.on('data', data => { if (!child.stdin.destroyed) child.stdin.write(data); });
    const endInput = () => { if (!child.stdin.destroyed) child.stdin.end(); };
    socket.on('end', endInput); socket.on('close', endInput);
    child.stdout.on('data', data => frame(socket, 1, data));
    child.stderr.on('data', data => frame(socket, 2, data));
    child.on('close', () => { children.delete(child); socket.end(); });
    if (holdStart) { await startGate; if (!socket.destroyed) socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); }
    if (frameError) {
      const header = Buffer.alloc(8); header[0] = frameError === 'invalid-channel' ? 9 : 1;
      if (frameError === 'oversized') header.writeUInt32BE(16 * 1024 * 1024 + 1, 4);
      socket.write(frameError === 'truncated' ? header.subarray(0, 4) : header);
      if (frameError === 'truncated') socket.end();
    }
    frame(socket, 2, Buffer.from('private stderr must not enter CDP'));
    if (extra.length) child.stdin.write(extra);
  });
  await new Promise(resolve => engine.listen(engineSocket, resolve));
  const session = { sessionId: 'owned-session', container: 'sira-ac-user-owned', host: '127.0.0.2', userId: 'owned-user' };
  const secondSession = { ...session, sessionId: 'second-session', container: 'sira-ac-user-second', userId: 'second-user' };
  const store = { getById: id => id === session.sessionId ? session : id === secondSession.sessionId ? secondSession : null };
  const orch = createOrchestrator({ env: { AGENT_COMPUTER_API_KEY: 'fixture-service-secret', DOCKER_HOST_SOCKET: engineSocket }, driver: 'docker', store, runtime: {} });
  for (const server of [orch.server, engine, cdp, secondCdp]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await listen(orch.server);
  const base = `http://127.0.0.1:${orch.server.address().port}/sessions/owned-session/cdp`;
  const headers = { Authorization: 'Bearer fixture-service-secret', Cookie: 'private-user-cookie=must-not-forward' };
  t.after(async () => {
    releaseCreate(); releaseStart();
    for (const ws of wsServer.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    for (const child of children) child.kill();
    await waitUntil(() => children.size === 0);
    for (const server of [orch.server, engine, cdp, secondCdp]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    wsServer.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, headers, children, pids, requests, received, releaseCreate, releaseStart, starts: () => childStarts, createAborts: () => createAborts };
}

test('CDP HTTP reaches the existing loopback browser through the authorized container exec', async t => {
  const f = await fixture(t);
  const res = await fetch(f.base + '/json/version', { headers: f.headers, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).Browser, 'fixture Chrome');
  assert.match(f.requests[0].path, /^\/v1\.44\/containers\/sira-ac-user-owned\/exec$/);
  assert.equal(f.received[0].headers.authorization, undefined);
  assert.equal(f.received[0].headers.cookie, undefined);
  assert.equal(f.received[0].headers.host, '127.0.0.1:9222');
  await waitUntil(() => f.children.size === 0);
});

test('CDP WebSocket carries bidirectional bytes and leaves no helper processes after repeated close', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) {
    const ws = new WebSocket(f.base.replace(/^http/, 'ws') + '/devtools/browser/existing-profile', { headers: f.headers, handshakeTimeout: 5000 });
    await once(ws, 'open');
    const message = once(ws, 'message'); const payload = JSON.stringify({ id: i, method: 'Target.getTargets' });
    ws.send(payload); assert.equal(String((await message)[0]), payload);
    ws.close(); await once(ws, 'close'); await waitUntil(() => f.children.size === 0);
  }
  assert.equal(f.starts(), 12);
  for (const pid of f.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  for (const r of f.received) { assert.equal(r.headers.authorization, undefined); assert.equal(r.headers.cookie, undefined); }
});

test('CDP authorization and unknown-session checks reject before Docker exec', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/json/version')).status, 401);
  assert.equal((await fetch(f.base.replace('owned-session', 'other-session') + '/json/version', { headers: f.headers })).status, 404);
  const ws = new WebSocket(f.base.replace(/^http/, 'ws') + '/devtools/browser/x', { handshakeTimeout: 5000 });
  await once(ws, 'error');
  assert.equal(f.requests.length, 0);
});

test('Docker exec errors fail closed without leaking daemon diagnostics', async t => {
  const f = await fixture(t, { failCreate: true });
  const res = await fetch(f.base + '/json/version', { headers: f.headers, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /private daemon|fixture-service-secret|cookie/);
  assert.equal(f.starts(), 0);
});

test('connection refusal inside the container releases the helper and fails HTTP', async t => {
  const f = await fixture(t, { failConnect: true });
  const res = await fetch(f.base + '/json/version', { headers: f.headers, signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 502);
  await waitUntil(() => f.children.size === 0);
});


test('repeated HTTP responses release every helper process', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) {
    const response = await fetch(f.base + '/json/version', { headers: f.headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); await response.text();
    await waitUntil(() => f.children.size === 0);
  }
  assert.equal(f.starts(), 8);
  for (const pid of f.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('aborting HTTP while Docker create is pending never starts an exec', async t => {
  const f = await fixture(t, { holdCreate: true });
  const controller = new AbortController();
  const request = fetch(f.base + '/json/version', { headers: f.headers, signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await waitUntil(() => f.requests.length === 1);
  controller.abort(); await rejected;
  await waitUntil(() => f.createAborts() === 1);
  f.releaseCreate();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.starts(), 0);
});

test('aborting HTTP during Docker start closes stdin and exits its helper', async t => {
  const f = await fixture(t, { holdStart: true });
  const controller = new AbortController();
  const request = fetch(f.base + '/json/version', { headers: f.headers, signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await waitUntil(() => f.starts() === 1);
  controller.abort(); await rejected;
  await waitUntil(() => f.children.size === 0);
  f.releaseStart();
  for (const pid of f.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('aborting an established HTTP request releases the loopback connection', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const request = fetch(f.base + '/hang', { headers: f.headers, signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await waitUntil(() => f.received.length === 1);
  controller.abort(); await rejected;
  await waitUntil(() => f.children.size === 0);
});

test('closing WebSocket before Docker start completes does not orphan its helper', async t => {
  const f = await fixture(t, { holdStart: true });
  const ws = new WebSocket(f.base.replace(/^http/, 'ws') + '/devtools/browser/x', { headers: f.headers });
  ws.on('error', () => {});
  await waitUntil(() => f.starts() === 1);
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.terminate(); await closed;
  await waitUntil(() => f.children.size === 0);
  f.releaseStart();
});

test('CDP frames remain byte-exact when a WebSocket consumer applies backpressure', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.base.replace(/^http/, 'ws') + '/devtools/browser/x', { headers: f.headers, handshakeTimeout: 5000 });
  await once(ws, 'open');
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const message = once(ws, 'message');
  ws.pause(); ws.send(payload);
  await new Promise(resolve => setTimeout(resolve, 30));
  ws.resume();
  assert.deepEqual((await message)[0], payload);
  ws.close(); await once(ws, 'close');
  await waitUntil(() => f.children.size === 0);
});


test('each session reaches only its own stored container, ignoring client target parameters', async t => {
  const f = await fixture(t);
  const urls = [f.base + '/json/version?container=sira-ac-user-second&host=169.254.169.254&port=80', f.base.replace('owned-session', 'second-session') + '/json/version'];
  const replies = await Promise.all(urls.map(url => fetch(url, { headers: f.headers, signal: AbortSignal.timeout(5000) }).then(response => response.json())));
  assert.equal(replies[0].Browser, 'fixture Chrome');
  assert.equal(replies[1].Browser, 'second isolated Chrome');
  assert.deepEqual(f.requests.map(request => request.path).sort(), ['/v1.44/containers/sira-ac-user-owned/exec', '/v1.44/containers/sira-ac-user-second/exec']);
  await waitUntil(() => f.children.size === 0);
});

test('the existing direct noVNC-style HTTP and WebSocket proxy remains unchanged', async t => {
  const headers = [];
  const sockets = new Set();
  const wsServer = new WebSocketServer({ noServer: true });
  const target = http.createServer((req, res) => { headers.push(req.headers); res.end('desktop HTML'); });
  target.on('upgrade', (req, socket, head) => wsServer.handleUpgrade(req, socket, head, ws => { headers.push(req.headers); ws.on('message', value => ws.send(value)); }));
  await listen(target);
  const options = { hostname: '127.0.0.1', port: target.address().port, path: '/' };
  const proxy = http.createServer((req, res) => proxyHttp(req, res, options));
  proxy.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, options));
  for (const server of [target, proxy]) server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await listen(proxy);
  t.after(async () => {
    for (const ws of wsServer.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    for (const server of [proxy, target]) await new Promise(resolve => server.close(resolve));
    wsServer.close();
  });
  const base = `http://127.0.0.1:${proxy.address().port}`;
  assert.equal(await (await fetch(base, { headers: { 'X-Test-Proxy': 'http' } })).text(), 'desktop HTML');
  const ws = new WebSocket(base.replace(/^http/, 'ws'), { headers: { 'X-Test-Proxy': 'websocket' }, handshakeTimeout: 5000 });
  await once(ws, 'open');
  const message = once(ws, 'message'); ws.send('desktop-frame');
  assert.equal(String((await message)[0]), 'desktop-frame');
  ws.close(); await once(ws, 'close');
  assert.deepEqual(headers.map(value => value['x-test-proxy']), ['http', 'websocket']);
});


test('Docker start rejection and invalid framing fail closed and clean up', async t => {
  for (const scenario of ['start-rejected', 'invalid-channel', 'oversized', 'truncated']) {
    await t.test(scenario, async childTest => {
      const f = await fixture(childTest, scenario === 'start-rejected' ? { failStart: true } : { frameError: scenario });
      const response = await fetch(f.base + '/json/version', { headers: f.headers, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /private stderr|fixture-service-secret|cookie/);
      await waitUntil(() => f.children.size === 0);
      if (scenario === 'start-rejected') assert.equal(f.starts(), 0);
    });
  }
});
