'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const express = require('express');
const hostRunner = require('../src/services/code/host-runner');
const workspaceRunner = require('../src/services/github/workspace-runner.service');
const codeRunnerRouter = require('../src/routes/code-runner');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
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
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('host code runner uses same-origin proxy URLs in production', () => {
  withEnv({ NODE_ENV: 'production', CODE_RUNNER_PROXY_URLS: undefined }, () => {
    assert.equal(hostRunner.useProxyUrls(), true);
    assert.equal(hostRunner.publicDevUrl('run 123', 4311), '/api/code-runner/run123/proxy/');
  });
});

test('host code runner keeps localhost URLs when proxy mode is disabled', () => {
  withEnv({ NODE_ENV: 'production', CODE_RUNNER_PROXY_URLS: '0' }, () => {
    assert.equal(hostRunner.useProxyUrls(), false);
    assert.equal(hostRunner.publicDevUrl('run-abc', 4311), 'http://localhost:4311');
  });
});

test('github workspace runner emits proxy URL and Vite base path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-runner-test-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { vite: '^7.0.0' } }),
    );
    withEnv({ NODE_ENV: 'production', SIRAGPT_WORKSPACE_RUN_PROXY_URLS: undefined }, () => {
      assert.equal(workspaceRunner.useProxyUrls(), true);
      assert.equal(workspaceRunner.publicPreviewUrl('conn_1', 4300), '/api/github/connected/conn_1/proxy/');
      const plan = workspaceRunner.detectRunPlan(dir, 4300, 'conn_1');
      assert.equal(plan.kind, 'node');
      assert.equal(plan.framework, 'vite');
      assert.match(plan.command, /--base "\/api\/github\/connected\/conn_1\/proxy\/"/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A hex token that survives safeToken() and a runId that survives safeRunId().
const PROXY_TOKEN = 'deadbeefcafef00d';
const PROXY_RUN_ID = 'runproxytest';

function mountProxyApp(upstreamPort) {
  const app = express();
  app.use('/api/code-runner', codeRunnerRouter);
  return app;
}

test('token proxy destroys the upstream socket when the client aborts', async () => {
  // Upstream dev server that accepts the connection but NEVER responds — simulates
  // a wedged Vite cold-compile. We assert its socket gets closed (upstream.destroy).
  let upstreamSocketClosed = false;
  const upstreamSockets = new Set();
  const upstream = http.createServer(() => {
    /* intentionally never respond */
  });
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => {
      upstreamSocketClosed = true;
      upstreamSockets.delete(socket);
    });
  });
  const upstreamPort = await listen(upstream);

  const original = hostRunner.getRunForProxy;
  hostRunner.getRunForProxy = () => ({ port: upstreamPort });

  const app = mountProxyApp(upstreamPort);
  const server = http.createServer(app);
  const proxyPort = await listen(server);

  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `/api/code-runner/${PROXY_RUN_ID}/${PROXY_TOKEN}/app/index.js`,
        },
        () => {}, // no response expected — upstream hangs
      );
      req.on('error', () => {}); // aborting surfaces as ECONNRESET; ignore
      req.end();
      // Give the proxy time to open the upstream connection, then abort the client.
      setTimeout(() => {
        req.destroy();
        // Allow the res 'close' handler to run and destroy the upstream request.
        setTimeout(resolve, 250);
      }, 150);
    });

    assert.equal(
      upstreamSocketClosed,
      true,
      'upstream socket should be destroyed after the client aborts',
    );
  } finally {
    hostRunner.getRunForProxy = original;
    // Force-close any still-open upstream sockets so a regression (missing
    // res.on('close')) fails the assertion above rather than hanging the run.
    for (const socket of upstreamSockets) socket.destroy();
    await close(server);
    await close(upstream);
  }
});

test('token proxy still streams a normal upstream 200 to completion', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello-from-dev-server');
  });
  const upstreamPort = await listen(upstream);

  const original = hostRunner.getRunForProxy;
  hostRunner.getRunForProxy = () => ({ port: upstreamPort });

  const app = mountProxyApp(upstreamPort);
  const server = http.createServer(app);
  const proxyPort = await listen(server);

  try {
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `/api/code-runner/${PROXY_RUN_ID}/${PROXY_TOKEN}/app/index.js`,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(status, 200);
    assert.equal(body, 'hello-from-dev-server');
  } finally {
    hostRunner.getRunForProxy = original;
    await close(server);
    await close(upstream);
  }
});
