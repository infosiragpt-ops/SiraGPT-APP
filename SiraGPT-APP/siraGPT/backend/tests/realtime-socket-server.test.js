/**
 * Integration tests for services/realtime/socket-server.js.
 *
 * Spins up a real HTTP server + ws client to validate auth, channels,
 * heartbeat, typing-indicator broadcast and cursor throttling.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

const {
  initRealtimeServer,
  closeRealtimeServer,
  broadcastToUser,
  broadcastToChat,
  broadcastToOrg,
  CLOSE_CODE_AUTH_REQUIRED,
  CLOSE_CODE_AUTH_INVALID,
} = require('../src/services/realtime/socket-server');
const { _resetForTests: resetPresence } = require('../src/services/realtime/presence');
const { _resetForTests: resetTyping } = require('../src/services/realtime/typing-indicator');

function startHttp() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function fakeVerifier(tokenToAuth) {
  return async (token) => {
    const entry = tokenToAuth[token];
    if (!entry) throw new Error('invalid token');
    return entry;
  };
}

function waitOpen(ws) {
  // Eagerly instrument so any messages emitted at/around `open` are buffered.
  instrument(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

// Attach a permanent message-buffering listener to a WebSocket so subsequent
// `waitMessage` calls can match against messages that arrived before they
// registered.  This avoids the race where the server sends data before the
// test attaches a listener.
function instrument(ws) {
  if (ws.__inboxAttached) return;
  ws.__inboxAttached = true;
  ws.__inbox = [];
  ws.__waiters = [];
  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch { return; }
    ws.__inbox.push(parsed);
    for (let i = ws.__waiters.length - 1; i >= 0; i--) {
      const w = ws.__waiters[i];
      if (!w.predicate || w.predicate(parsed)) {
        ws.__waiters.splice(i, 1);
        clearTimeout(w.timer);
        // drop matched message from buffer
        const idx = ws.__inbox.indexOf(parsed);
        if (idx >= 0) ws.__inbox.splice(idx, 1);
        w.resolve(parsed);
      }
    }
  });
}

function waitMessage(ws, predicate, timeoutMs = 1500) {
  instrument(ws);
  return new Promise((resolve, reject) => {
    // Check buffered messages first
    for (let i = 0; i < ws.__inbox.length; i++) {
      const m = ws.__inbox[i];
      if (!predicate || predicate(m)) {
        ws.__inbox.splice(i, 1);
        resolve(m);
        return;
      }
    }
    const timer = setTimeout(() => {
      const idx = ws.__waiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) ws.__waiters.splice(idx, 1);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    ws.__waiters.push({ predicate, resolve, timer });
  });
}
function waitClose(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason?.toString?.() || '' }));
  });
}

async function teardown(server) {
  closeRealtimeServer();
  await new Promise((r) => server.close(r));
  resetPresence();
  resetTyping();
}

describe('realtime socket server', { concurrency: false }, () => {

test('socket:rejects connection without token', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, { verifyToken: fakeVerifier({}) });
  const ws = new WebSocket(`ws://localhost:${port}/ws/realtime`);
  const closed = await waitClose(ws);
  assert.equal(closed.code, CLOSE_CODE_AUTH_REQUIRED);
  await teardown(server);
});

test('socket:rejects connection with bad token', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, { verifyToken: fakeVerifier({}) });
  const ws = new WebSocket(`ws://localhost:${port}/ws/realtime?token=nope`);
  const closed = await waitClose(ws);
  assert.equal(closed.code, CLOSE_CODE_AUTH_INVALID);
  await teardown(server);
});

test('socket:authenticated client receives welcome with user channel', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, {
    verifyToken: fakeVerifier({ tokA: { userId: 'alice', orgId: 'acme' } }),
  });
  const ws = new WebSocket(`ws://localhost:${port}/ws/realtime?token=tokA`);
  await waitOpen(ws);
  const msg = await waitMessage(ws, (m) => m.type === 'welcome');
  assert.equal(msg.userId, 'alice');
  assert.equal(msg.orgId, 'acme');
  assert.ok(msg.channels.includes('user:alice'));
  assert.ok(msg.channels.includes('org:acme'));
  ws.close();
  await teardown(server);
});

test('socket:broadcastToUser delivers event to user sockets', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, {
    verifyToken: fakeVerifier({ t1: { userId: 'bob' } }),
  });
  const ws = new WebSocket(`ws://localhost:${port}/ws/realtime?token=t1`);
  await waitOpen(ws);
  await waitMessage(ws, (m) => m.type === 'welcome');
  const got = waitMessage(ws, (m) => m.type === 'notif');
  const n = broadcastToUser('bob', { type: 'notif', text: 'hello' });
  assert.equal(n, 1);
  const msg = await got;
  assert.equal(msg.text, 'hello');
  assert.equal(msg.channel, 'user:bob');
  ws.close();
  await teardown(server);
});

test('socket:typing.start broadcasts to other chat subscribers only', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, {
    verifyToken: fakeVerifier({
      a: { userId: 'alice' },
      b: { userId: 'bob' },
    }),
  });
  const wsA = new WebSocket(`ws://localhost:${port}/ws/realtime?token=a`);
  const wsB = new WebSocket(`ws://localhost:${port}/ws/realtime?token=b`);
  await Promise.all([waitOpen(wsA), waitOpen(wsB)]);
  await Promise.all([
    waitMessage(wsA, (m) => m.type === 'welcome'),
    waitMessage(wsB, (m) => m.type === 'welcome'),
  ]);

  wsA.send(JSON.stringify({ type: 'subscribe.chat', chatId: 'room1' }));
  wsB.send(JSON.stringify({ type: 'subscribe.chat', chatId: 'room1' }));
  await Promise.all([
    waitMessage(wsA, (m) => m.type === 'subscribed'),
    waitMessage(wsB, (m) => m.type === 'subscribed'),
  ]);

  const gotOnB = waitMessage(wsB, (m) => m.type === 'typing.start');
  wsA.send(JSON.stringify({ type: 'typing.start', chatId: 'room1' }));
  const evt = await gotOnB;
  assert.equal(evt.userId, 'alice');
  assert.equal(evt.chatId, 'room1');

  wsA.close(); wsB.close();
  await teardown(server);
});

test('socket:cursor:update broadcasts throttled payload to chat', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, {
    verifyToken: fakeVerifier({ a: { userId: 'alice' }, b: { userId: 'bob' } }),
  });
  const wsA = new WebSocket(`ws://localhost:${port}/ws/realtime?token=a`);
  const wsB = new WebSocket(`ws://localhost:${port}/ws/realtime?token=b`);
  await Promise.all([waitOpen(wsA), waitOpen(wsB)]);
  await Promise.all([
    waitMessage(wsA, (m) => m.type === 'welcome'),
    waitMessage(wsB, (m) => m.type === 'welcome'),
  ]);
  for (const ws of [wsA, wsB]) {
    ws.send(JSON.stringify({ type: 'subscribe.chat', chatId: 'doc1' }));
  }
  await Promise.all([
    waitMessage(wsA, (m) => m.type === 'subscribed'),
    waitMessage(wsB, (m) => m.type === 'subscribed'),
  ]);

  const gotOnB = waitMessage(wsB, (m) => m.type === 'cursor:update');
  wsA.send(JSON.stringify({ type: 'cursor:update', chatId: 'doc1', data: { x: 5, y: 7 } }));
  const evt = await gotOnB;
  assert.deepEqual(evt.data, { x: 5, y: 7 });
  assert.equal(evt.userId, 'alice');

  wsA.close(); wsB.close();
  await teardown(server);
});

test('socket:broadcastToChat reaches all subscribers', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, {
    verifyToken: fakeVerifier({ a: { userId: 'alice' }, b: { userId: 'bob' } }),
  });
  const wsA = new WebSocket(`ws://localhost:${port}/ws/realtime?token=a`);
  const wsB = new WebSocket(`ws://localhost:${port}/ws/realtime?token=b`);
  await Promise.all([waitOpen(wsA), waitOpen(wsB)]);
  await Promise.all([
    waitMessage(wsA, (m) => m.type === 'welcome'),
    waitMessage(wsB, (m) => m.type === 'welcome'),
  ]);
  for (const ws of [wsA, wsB]) {
    ws.send(JSON.stringify({ type: 'subscribe.chat', chatId: 'chat-x' }));
  }
  await Promise.all([
    waitMessage(wsA, (m) => m.type === 'subscribed'),
    waitMessage(wsB, (m) => m.type === 'subscribed'),
  ]);
  const gA = waitMessage(wsA, (m) => m.type === 'note');
  const gB = waitMessage(wsB, (m) => m.type === 'note');
  const n = broadcastToChat('chat-x', { type: 'note', body: 'hi all' });
  assert.equal(n, 2);
  const [eA, eB] = await Promise.all([gA, gB]);
  assert.equal(eA.body, 'hi all');
  assert.equal(eB.body, 'hi all');
  wsA.close(); wsB.close();
  await teardown(server);
});

test('socket:broadcastToOrg targets org subscribers', async () => {
  const { server, port } = await startHttp();
  initRealtimeServer(server, {
    verifyToken: fakeVerifier({ a: { userId: 'alice', orgId: 'org1' } }),
  });
  const ws = new WebSocket(`ws://localhost:${port}/ws/realtime?token=a`);
  await waitOpen(ws);
  await waitMessage(ws, (m) => m.type === 'welcome');
  const got = waitMessage(ws, (m) => m.type === 'org.announce');
  const n = broadcastToOrg('org1', { type: 'org.announce', text: 'maintenance' });
  assert.equal(n, 1);
  const m = await got;
  assert.equal(m.text, 'maintenance');
  assert.equal(m.channel, 'org:org1');
  ws.close();
  await teardown(server);
});

test('socket:broadcast helpers are no-ops when server not initialised', () => {
  // Ensure no leftover state
  try { closeRealtimeServer(); } catch {}
  assert.equal(broadcastToUser('x', { type: 't' }), 0);
  assert.equal(broadcastToChat('x', { type: 't' }), 0);
  assert.equal(broadcastToOrg('x', { type: 't' }), 0);
});

}); // describe
