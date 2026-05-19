'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const versionRouter = require('../src/routes/version');

function startServer() {
  const app = express();
  app.use('/api/version', versionRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('/api/version returns the expected shape', async () => {
  const { server, port } = await startServer();
  try {
    const res = await get(port, '/api/version');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    // Shape contract — keep these stable for ops dashboards.
    assert.equal(typeof json.version, 'string');
    assert.equal(typeof json.backend, 'string');
    assert.equal(typeof json.commit, 'string');
    assert.equal(typeof json.buildTime, 'string');
    assert.equal(typeof json.node, 'string');
    // Backend semver pinned in package.json — value-level smoke check.
    assert.match(json.backend, /^\d+\.\d+\.\d+/);
    // Node version comes straight from process.version.
    assert.equal(json.node, process.version);
    // buildTime must be a valid ISO 8601 instant.
    assert.ok(Number.isFinite(Date.parse(json.buildTime)));
    // Cache-Control is no-store so canary restarts surface immediately.
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    server.close();
  }
});

test('/api/version VERSION_INFO is frozen and stable across calls', async () => {
  const { VERSION_INFO } = versionRouter;
  assert.ok(Object.isFrozen(VERSION_INFO));
  // Same object reference on re-require (Node module cache).
  const again = require('../src/routes/version').VERSION_INFO;
  assert.strictEqual(VERSION_INFO, again);
});
