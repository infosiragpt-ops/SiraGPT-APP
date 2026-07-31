'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const WebSocket = require('ws');

const hostRunner = require('../src/services/code/host-runner');
const codeRunnerRouter = require('../src/routes/code-runner');
const {
  attachCodeRunnerPreviewWebSocketProxy,
  buildPreviewConsoleBridge,
  injectPreviewConsoleBridge,
  previewFrameAncestors,
  previewTokenFor,
  redactPreviewUrl,
  signPreviewToken,
  verifyPreviewToken,
} = require('../src/services/code/preview-proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => (server && server.listening ? server.close(resolve) : resolve()));
}

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('preview token verification is fail-closed in production and requires exp', () => {
  withEnv({ NODE_ENV: 'production', CODE_RUNNER_PREVIEW_TOKEN_SECRET: undefined, CODEX_PREVIEW_TOKEN_SECRET: undefined }, () => {
    assert.equal(verifyPreviewToken('not-a-token'), null);
    assert.throws(() => signPreviewToken({ runId: 'run' }), /secret_required|exp is required/);
  });

  const secret = 'preview-test-secret';
  withEnv({ NODE_ENV: 'production', CODE_RUNNER_PREVIEW_TOKEN_SECRET: secret }, () => {
    const valid = previewTokenFor({ runId: 'run', userId: 'user' });
    const claims = verifyPreviewToken(valid);
    assert.equal(claims.runId, 'run');
    assert.equal(claims.userId, 'user');
    assert.equal(Number.isFinite(claims.iat), true);
    assert.equal(Number.isFinite(claims.exp), true);

    const body = Buffer.from(JSON.stringify({ runId: 'run' })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    assert.equal(verifyPreviewToken(`${body}.${signature}`), null);
  });
});

test('preview URL redaction removes bearer path segments and nonce query values', () => {
  const redacted = redactPreviewUrl('/api/code-runner/run-1/signed.token/app/index.js?__sgpt_preview_nonce=nonce-value');
  assert.equal(redacted, '/api/code-runner/run-1/[REDACTED]/app/index.js?__sgpt_preview_nonce=[REDACTED]');
  assert.equal(redactPreviewUrl('/api/codex/projects/p1/preview/signed.token/app/'), '/api/codex/projects/p1/preview/[REDACTED]/app/');
  assert.equal(previewFrameAncestors({ CODEX_PREVIEW_ORIGIN: 'https://preview.example.com/' }), "'self' https://preview.example.com");
});

test('console bridge carries nonce and is injected into live HTML', () => {
  const bridge = buildPreviewConsoleBridge('nonce-for-test-1234');
  assert.match(bridge, /nonce-for-test-1234/);
  const html = injectPreviewConsoleBridge('<html><head></head><body>ok</body></html>', 'nonce-for-test-1234');
  assert.match(html, /data-sgpt-preview-bridge/);
  assert.match(html, /sgpt-preview-console/);
});

test('code runner preview WebSocket upgrade reaches only the token-bound run', async (t) => {
  const upstream = http.createServer();
  const upstreamWss = new WebSocket.Server({ server: upstream });
  upstreamWss.on('connection', (socket) => {
    socket.send('vite-connected');
    socket.on('message', (data) => socket.send(`vite:${String(data)}`));
  });
  const upstreamAddress = await listen(upstream);

  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CODE_RUNNER_PREVIEW_TOKEN_SECRET: process.env.CODE_RUNNER_PREVIEW_TOKEN_SECRET,
  };
  process.env.NODE_ENV = 'test';
  process.env.CODE_RUNNER_PREVIEW_TOKEN_SECRET = 'preview-ws-test-secret';
  const token = previewTokenFor({ runId: 'ws-run', userId: 'u1' });
  hostRunner._resetRunsForTest();
  hostRunner._seedRunForTest({ runId: 'ws-run', userId: 'u1', port: upstreamAddress.port, phase: 'ready', previewToken: token });

  const app = express();
  app.use('/api/code-runner', codeRunnerRouter);
  const proxy = http.createServer(app);
  const binding = attachCodeRunnerPreviewWebSocketProxy(proxy, {
    resolveTarget: (request) => {
      const match = /^\/api\/code-runner\/([^/]+)\/([^/]+)\/app(?:\/|$)/.exec(String(request.url).split('?')[0]);
      const target = match && hostRunner.getRunForProxy(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      return target ? { url: `ws://127.0.0.1:${target.port}${request.url}`, host: `127.0.0.1:${target.port}` } : { statusCode: 403 };
    },
  });
  const proxyAddress = await listen(proxy);
  const client = new WebSocket(`ws://127.0.0.1:${proxyAddress.port}/api/code-runner/ws-run/${token}/app/`, 'vite-hmr');

  t.after(async () => {
    client.terminate();
    binding.close();
    hostRunner._resetRunsForTest();
    upstreamWss.close();
    await close(proxy);
    await close(upstream);
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.CODE_RUNNER_PREVIEW_TOKEN_SECRET === undefined) delete process.env.CODE_RUNNER_PREVIEW_TOKEN_SECRET;
    else process.env.CODE_RUNNER_PREVIEW_TOKEN_SECRET = previous.CODE_RUNNER_PREVIEW_TOKEN_SECRET;
  });

  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  assert.equal(client.protocol, 'vite-hmr');
  assert.equal(await new Promise((resolve) => client.once('message', (data) => resolve(String(data)))), 'vite-connected');
  const echoed = new Promise((resolve) => client.once('message', (data) => resolve(String(data))));
  client.send('ping');
  assert.equal(await echoed, 'vite:ping');
});
