'use strict';

// Prod 2026-10-03: the orchestrator viewer polls
// GET /api/agent-computer/activity?sessionId=ac_luis&browser=1 every ~3 s
// (no conversation key) and 346 of those landed in Admin → Logs as
// «request errored». A poll without a conversation now gets an empty 200:
// nothing to isolate, nothing to leak. Bound polls keep the proven-isolation
// path.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

process.env.SIRAGPT_AGENT_COMPUTER = '1';

function loadRouterWithFakeAuth() {
  const original = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id.endsWith('middleware/auth')) {
      return { authenticateToken: (req, _res, next) => { req.user = { id: 'cmuser_activity' }; next(); } };
    }
    return original.apply(this, arguments);
  };
  const routerPath = path.join(__dirname, '..', 'src', 'routes', 'agent-computer.js');
  try {
    delete require.cache[routerPath];
    return require(routerPath);
  } finally {
    Module.prototype.require = original;
  }
}

async function withServer(fn) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/agent-computer', loadRouterWithFakeAuth());
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('activity poll without a conversation key answers 200 with no activity', async () => {
  await withServer(async (base) => {
    for (const qs of ['?sessionId=ac_luis&browser=1', '']) {
      const res = await fetch(`${base}/api/agent-computer/activity${qs}`);
      assert.equal(res.status, 200, qs);
      const body = await res.json();
      assert.deepEqual(body, { activity: null, url: null, title: '', conversationBound: false });
    }
  });
});

test('activity poll bound to a conversation still goes through isolation and answers', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent-computer/activity?conversationId=chat_abc`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activity, null);
    assert.equal('conversationBound' in body, false, 'bound answers keep their original shape');
  });
});
