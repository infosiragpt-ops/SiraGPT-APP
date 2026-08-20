'use strict';

/**
 * /api/agent-computer — flag gate, per-member get-or-create, ownership.
 * Auth + orchestrator are stubbed; no Docker.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { sessionIdForUser } = require('../../services/computer/orchestrator/identity');

const orchCalls = [];
const orchPath = require.resolve('../src/services/computer/orch-client');
require.cache[orchPath] = {
  id: orchPath,
  filename: orchPath,
  loaded: true,
  exports: {
    resolveOrchConfig: () => ({ enabled: true }),
    async orchFetch(path, opts = {}) {
      const method = opts.method || 'GET';
      orchCalls.push({ path, method, body: opts.body });
      if (path === '/sessions' && method === 'POST') {
        const userId = opts.body && opts.body.userId;
        if (!userId) {
          const err = new Error('userId is required');
          err.status = 400;
          throw err;
        }
        return {
          sessionId: sessionIdForUser(userId),
          userId,
          created: orchCalls.filter((c) => c.path === '/sessions' && c.body?.userId === userId).length === 1,
          persistent: true,
          novncWsUrl: 'wss://computer.siragpt.com/',
          agentUrl: 'http://127.0.0.1:18081',
          cdpUrl: 'http://127.0.0.1:19222',
        };
      }
      if (path.startsWith('/sessions/')) {
        const id = path.split('/')[2];
        const userA = sessionIdForUser('user-a');
        const userB = sessionIdForUser('user-b');
        if (id === userA) {
          return { sessionId: id, userId: 'user-a', agentUrl: 'http://127.0.0.1:1' };
        }
        if (id === userB) {
          return { sessionId: id, userId: 'user-b', agentUrl: 'http://127.0.0.1:2' };
        }
        const err = new Error('not_found');
        err.status = 404;
        throw err;
      }
      return {};
    },
  },
};

const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    authenticateToken: (req, _res, next) => {
      req.user = { id: req.headers['x-test-user'] || 'user-a' };
      next();
    },
  },
};

const savedFlag = process.env.SIRAGPT_AGENT_COMPUTER;
process.env.SIRAGPT_AGENT_COMPUTER = '1';

const router = require('../src/routes/agent-computer');

let server;
let baseURL;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-computer', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseURL = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (savedFlag === undefined) delete process.env.SIRAGPT_AGENT_COMPUTER;
  else process.env.SIRAGPT_AGENT_COMPUTER = savedFlag;
  await new Promise((resolve) => server.close(resolve));
});

function request(method, path, { body, user } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${baseURL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-test-user': user || 'user-a',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* raw */ }
        resolve({ status: res.statusCode, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('POST /sessions keys the desktop on the authenticated member, not the body', async () => {
  orchCalls.length = 0;
  const res = await request('POST', '/api/agent-computer/sessions', {
    body: { userId: 'attacker', department: 'legal' },
    user: 'user-a',
  });
  assert.ok(res.status === 200 || res.status === 201);
  assert.equal(res.json.userId, 'user-a');
  assert.equal(res.json.sessionId, sessionIdForUser('user-a'));
  assert.equal(orchCalls[0].body.userId, 'user-a');
  assert.ok(!Object.prototype.hasOwnProperty.call(orchCalls[0].body, 'department'));
});

test('GET /desktop and /sessions/me are get-or-create for the caller', async () => {
  const desk = await request('GET', '/api/agent-computer/desktop', { user: 'user-a' });
  const me = await request('GET', '/api/agent-computer/sessions/me', { user: 'user-a' });
  assert.equal(desk.status, 200);
  assert.equal(me.status, 200);
  assert.equal(desk.json.sessionId, me.json.sessionId);
  assert.equal(desk.json.userId, 'user-a');
});

test('a member cannot read another member\'s desktop id', async () => {
  const otherId = sessionIdForUser('user-b');
  const res = await request('GET', `/api/agent-computer/sessions/${otherId}`, { user: 'user-a' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'forbidden');
});

test('flag off hides the API', async () => {
  process.env.SIRAGPT_AGENT_COMPUTER = '0';
  const res = await request('GET', '/api/agent-computer/health');
  process.env.SIRAGPT_AGENT_COMPUTER = '1';
  assert.equal(res.status, 404);
});
