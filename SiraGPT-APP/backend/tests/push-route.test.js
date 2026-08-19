'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pushModule = require('../src/routes/push');
const { createPushRouter, __internal } = pushModule;

// Stubs that emulate the real auth middleware contract for contract tests.
function stubAuthenticateToken(req, _res, next) {
  const id = req.get('x-test-user-id');
  if (id) req.user = { id, role: req.get('x-test-user-role') || 'user' };
  next();
}
function stubRequireAdmin(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.role === 'superadmin') return next();
  return res.status(403).json({ error: 'admin required' });
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const hdrs = { ...headers };
    if (payload) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = String(payload.length);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildApp(opts = {}) {
  const app = express();
  app.use(express.json());
  const router = createPushRouter({
    authenticateToken: stubAuthenticateToken,
    requireAdmin: stubRequireAdmin,
    getPrisma: opts.getPrisma || (() => null),
  });
  app.use('/api/push', router);
  return app;
}

test('validateSubscribeBody — accepts valid payload', () => {
  assert.equal(
    __internal.validateSubscribeBody({ token: 't', platform: 'web' }),
    null,
  );
});

test('validateSubscribeBody — rejects missing token', () => {
  assert.match(
    __internal.validateSubscribeBody({ platform: 'web' }),
    /token required/,
  );
});

test('validateSubscribeBody — rejects invalid platform', () => {
  assert.match(
    __internal.validateSubscribeBody({ token: 't', platform: 'windows' }),
    /platform/,
  );
});

test('validateSubscribeBody — rejects oversized token', () => {
  assert.match(
    __internal.validateSubscribeBody({ token: 'x'.repeat(5000), platform: 'web' }),
    /too long/,
  );
});

test('validateSendBody — requires userId', () => {
  assert.match(__internal.validateSendBody({ title: 't' }), /userId required/);
});

test('validateSendBody — requires title or body', () => {
  assert.match(__internal.validateSendBody({ userId: 'u' }), /title or body/);
});

test('GET /api/push/vapid-key — returns 503 when not configured', async () => {
  const prev = process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  const app = buildApp();
  const server = await startServer(app);
  try {
    const res = await request(server, { method: 'GET', path: '/api/push/vapid-key' });
    assert.equal(res.status, 503);
  } finally {
    server.close();
    if (prev != null) process.env.VAPID_PUBLIC_KEY = prev;
  }
});

test('GET /api/push/vapid-key — returns publicKey when configured', async () => {
  const prev = process.env.VAPID_PUBLIC_KEY;
  process.env.VAPID_PUBLIC_KEY = 'TESTKEY';
  const app = buildApp();
  const server = await startServer(app);
  try {
    const res = await request(server, { method: 'GET', path: '/api/push/vapid-key' });
    assert.equal(res.status, 200);
    assert.equal(res.json.publicKey, 'TESTKEY');
  } finally {
    server.close();
    if (prev == null) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = prev;
  }
});

test('POST /api/push/subscribe — rejects unauthenticated', async () => {
  const app = buildApp();
  const server = await startServer(app);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/push/subscribe',
      body: { token: 't', platform: 'web' },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /api/push/subscribe — rejects bad body', async () => {
  const app = buildApp();
  const server = await startServer(app);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/push/subscribe',
      headers: { 'x-test-user-id': 'u1' },
      body: { token: 't' },
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/push/subscribe — returns 503 when Prisma model missing', async () => {
  const app = buildApp(); // default stub getPrisma returns null
  const server = await startServer(app);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/push/subscribe',
      headers: { 'x-test-user-id': 'u1' },
      body: { token: 'tok-1', platform: 'web' },
    });
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});

test('POST /api/push/subscribe — stores via injected prisma', async () => {
  const calls = [];
  const fakePrisma = {
    pushSubscription: {
      upsert: async (args) => {
        calls.push(args);
        return { id: 'sub-1' };
      },
    },
  };
  const app = buildApp({ getPrisma: () => fakePrisma });
  const server = await startServer(app);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/push/subscribe',
      headers: { 'x-test-user-id': 'u-7' },
      body: { token: 'tok-x', platform: 'ios' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.id, 'sub-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].create.userId, 'u-7');
    assert.equal(calls[0].create.platform, 'ios');
  } finally {
    server.close();
  }
});

test('POST /api/push/send — admin can dispatch when subs exist', async () => {
  const fakePrisma = {
    pushSubscription: {
      findMany: async () => [{ id: 's1', token: 't1', platform: 'web' }],
    },
  };
  const app = buildApp({ getPrisma: () => fakePrisma });
  const server = await startServer(app);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/push/send',
      headers: { 'x-test-user-id': 'admin1', 'x-test-user-role': 'admin' },
      body: { userId: 'target-u', title: 'hello' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  } finally {
    server.close();
  }
});

test('POST /api/push/send — requires admin role', async () => {
  const app = buildApp();
  const server = await startServer(app);
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/push/send',
      headers: { 'x-test-user-id': 'u1', 'x-test-user-role': 'user' },
      body: { userId: 'target', title: 'hi' },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
