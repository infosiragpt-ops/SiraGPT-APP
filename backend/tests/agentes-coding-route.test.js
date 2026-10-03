'use strict';

/**
 * /api/agentes-coding route contract (Fase 1).
 * /health is always 200 (no-store, no ETag) so the frontend can probe the
 * flag; every other route is 404 while AGENTES_CODING_V2 is off.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

function buildApp() {
  delete require.cache[require.resolve('../src/routes/agentes-coding')];
  delete require.cache[require.resolve('../src/services/agentes-coding/flags')];
  const router = require('../src/routes/agentes-coding');
  const app = express();
  app.use('/api/agentes-coding', router);
  return app;
}

afterEach(() => { delete process.env.AGENTES_CODING_V2; });

test('health is always 200 and carries the flag value', async () => {
  delete process.env.AGENTES_CODING_V2;
  const off = await request(buildApp()).get('/api/agentes-coding/health');
  assert.equal(off.status, 200);
  assert.equal(off.body.ok, true);
  assert.equal(off.body.enabled, false);
  assert.match(off.headers['cache-control'] || '', /no-store/);

  process.env.AGENTES_CODING_V2 = '1';
  const on = await request(buildApp()).get('/api/agentes-coding/health');
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
});

test('non-health routes are 404 while the flag is off', async () => {
  delete process.env.AGENTES_CODING_V2;
  const app = buildApp();
  for (const path of [
    '/api/agentes-coding/capabilities',
    '/api/agentes-coding/sessions',
    '/api/agentes-coding/sandbox',
    '/api/agentes-coding/projects',
    '/api/agentes-coding/sessions/csb_x/git/status',
    '/api/agentes-coding/sessions/csb_x/git/checkpoints',
    '/api/agentes-coding/sessions/csb_x/export',
    '/api/agentes-coding/sessions/csb_x/deploy',
    '/api/agentes-coding/sessions/csb_x/harness',
    '/api/agentes-coding/sessions/csb_x/harness/hrn_x/permissions',
  ]) {
    const res = await request(app).get(path);
    assert.equal(res.status, 404, path);
  }
});

// Prod 2026-09-27 (every boot): «agentes_coding_terminal_ws_init_failed —
// Maximum call stack size exceeded». `module.exports = router` aliased the
// module and the router, so the exported attach wrapper overwrote the router's
// own attach and called itself forever. The terminal socket never attached.
test('attachTerminalWebSocket attaches once to a bare http server instead of recursing', () => {
  const http = require('http');
  const server = http.createServer();
  try {
    buildApp();
    const router = require('../src/routes/agentes-coding');
    assert.doesNotThrow(() => router.attachTerminalWebSocket(server));
    assert.ok(server.listenerCount('upgrade') >= 1, 'the upgrade handler must be registered');
  } finally {
    server.close();
  }
});
