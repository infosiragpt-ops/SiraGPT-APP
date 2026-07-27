'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');

const {
  attachWebSocketProxy,
  parseProtocols,
} = require('../src/services/codex/preview-websocket-proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off('message', onMessage);
      reject(error);
    };
    const onMessage = (data) => {
      socket.off('error', onError);
      resolve(String(data));
    };
    socket.once('error', onError);
    socket.once('message', onMessage);
  });
}

test('preview WebSocket proxy preserves vite-hmr and bridges both directions', async (t) => {
  const upstreamHttp = http.createServer();
  const upstreamWss = new WebSocket.Server({ noServer: true });
  let upstreamHost = null;
  upstreamHttp.on('upgrade', (request, socket, head) => {
    if (request.url !== '/hmr') {
      socket.destroy();
      return;
    }
    upstreamWss.handleUpgrade(request, socket, head, (ws) => {
      upstreamHost = request.headers.host;
      upstreamWss.emit('connection', ws, request);
    });
  });
  upstreamWss.on('connection', (socket) => {
    socket.send('connected');
    socket.on('message', (data) => socket.send(`echo:${String(data)}`));
  });
  const upstreamAddress = await listen(upstreamHttp);

  const proxyHttp = http.createServer((_req, res) => res.end('ok'));
  const binding = attachWebSocketProxy(proxyHttp, {
    shouldHandle: (request) => request.url === '/preview',
    resolveTarget: async () => ({
      url: `ws://127.0.0.1:${upstreamAddress.port}/hmr`,
      host: 'localhost:5173',
    }),
  });
  const proxyAddress = await listen(proxyHttp);
  const client = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/preview`, 'vite-hmr');

  t.after(async () => {
    client.terminate();
    binding.close();
    for (const socket of upstreamWss.clients) socket.terminate();
    await closeServer(proxyHttp);
    await closeServer(upstreamHttp);
  });

  const connected = nextMessage(client);
  await once(client, 'open');
  assert.equal(client.protocol, 'vite-hmr');
  assert.equal(await connected, 'connected');
  assert.equal(upstreamHost, 'localhost:5173');

  const echoed = nextMessage(client);
  client.send('ping');
  assert.equal(await echoed, 'echo:ping');
});

test('preview WebSocket proxy rejects a target denied by token resolution', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const binding = attachWebSocketProxy(server, {
    shouldHandle: (request) => request.url === '/preview',
    resolveTarget: async () => {
      const error = new Error('forbidden');
      error.statusCode = 403;
      throw error;
    },
  });
  const address = await listen(server);
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/preview`, 'vite-hmr');
  client.on('error', () => {});

  t.after(async () => {
    client.terminate();
    binding.close();
    await closeServer(server);
  });

  const statusCode = await new Promise((resolve) => {
    client.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
  });
  assert.equal(statusCode, 403);
});

test('parseProtocols normalizes the WebSocket subprotocol list', () => {
  assert.deepEqual(parseProtocols('vite-hmr, second'), ['vite-hmr', 'second']);
  assert.deepEqual(parseProtocols(''), []);
});
