'use strict';

/**
 * /api/generate-word SSE resilience — offline tests (node --test, no
 * network/DB). The route is loaded with its infrastructure dependencies
 * (Prisma, OpenAI SDK, auth/quota middleware, observability) replaced via
 * a require-time shim, so what gets exercised is the real streaming
 * surface: headers, preamble, closed-stream guards, upstream abort, DONE.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const events = require('node:events');
const Module = require('node:module');

const ROUTES_DIR = path.resolve(__dirname, '..', 'src', 'routes');
const ROUTE_PATH = path.join(ROUTES_DIR, 'generate-document.js');

const PASS = (_req, _res, next) => next();

/** Load the route with infra deps mocked at require-time (fresh each call). */
function loadRouteWithMocks({ openaiStreamFactory }) {
  const realRequire = Module.prototype.require;
  const openaiCalls = [];
  function fakeRequire(requested) {
    if (requested === 'openai') {
      return class FakeOpenAI {
        constructor() {}
        get chat() {
          return { completions: { create: (...args) => { openaiCalls.push(args); return openaiStreamFactory(...args); } } };
        }
      };
    }
    if (typeof requested === 'string' && requested.startsWith('.')) {
      // Extensionless requires ('../middleware/auth') must still match:
      // compare both the raw resolution and its .js form.
      const base = path.resolve(ROUTES_DIR, requested);
      const candidates = base.endsWith('.js') ? [base] : [base, `${base}.js`];
      const matches = (suffix) => candidates.some((c) => c.endsWith(suffix));
      if (matches(`${path.sep}config${path.sep}database.js`)) {
        return {
          chat: {
            findFirst: async () => ({ id: 'c1', userId: 'u1', title: 'New Chat' }),
            findUnique: async () => ({ id: 'c1', userId: 'u1', title: 'New Chat' }),
            update: async () => ({}),
          },
          message: { create: async () => ({}) },
          file: { findFirst: async () => null },
        };
      }
      if (matches(`${path.sep}services${path.sep}usage-service.js`)) {
        return { calculateTextTokens: () => 1, recordUsage: async () => {} };
      }
      if (matches('record-llm-usage.js')) {
        return { recordLLMUsage: () => {} };
      }
      if (matches(`${path.sep}services${path.sep}ai-service.js`)) {
        return { modelSupportsVision: () => true };
      }
      if (matches(`${path.sep}services${path.sep}google-mcp.js`)) {
        return {};
      }
      if (matches(`${path.sep}services${path.sep}document-service.js`)) {
        return {};
      }
      if (matches(`${path.sep}middleware${path.sep}auth.js`)) {
        return { authenticateToken: (req, _res, next) => { req.user = { id: 'u1', plan: 'PRO', apiUsage: 0, monthlyLimit: 1000 }; next(); } };
      }
      if (matches(`${path.sep}middleware${path.sep}optionalAuth.js`)) {
        return { optionalAuth: PASS };
      }
      if (matches(`${path.sep}middleware${path.sep}trackAnonUsage.js`)) {
        return { trackAnonUsage: PASS };
      }
      if (matches(`${path.sep}middleware${path.sep}enforce-plan-quota.js`)) {
        return { enforcePlanQuota: () => PASS };
      }
    }
    return realRequire.call(this, requested);
  }

  delete require.cache[ROUTE_PATH];
  Module.prototype.require = fakeRequire;
  try {
    return { route: require(ROUTE_PATH), openaiCalls };
  } finally {
    Module.prototype.require = realRequire;
  }
}

function appWith(route) {
  const app = express();
  app.use(express.json());
  app.use('/api/generate-document', route);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function shutdown(server) {
  server.closeAllConnections?.();
  server.close();
  await events.once(server, 'close');
}

async function postWord(app, { stopWhen, abortAfterMs } = {}) {
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/generate-document/generate-word`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', prompt: 'escribe un doc', provider: 'OpenAI', chatId: 'c1' }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const tick = new Promise((r) => setTimeout(r, abortAfterMs ?? 50));
      const race = await Promise.race([reader.read(), tick.then(() => null)]);
      if (!race || race.done) break;
      raw += decoder.decode(race.value, { stream: true });
      if (stopWhen && stopWhen(raw)) break;
      if (!abortAfterMs && raw.includes('"done":true')) break;
    }
    try { reader.cancel(); } catch { /* already closed */ }
    return { raw, res };
  } finally {
    await shutdown(server);
  }
}

test('generate-word sets anti-buffering headers and connected preamble first', async () => {
  const { route } = loadRouteWithMocks({
    openaiStreamFactory: async () => (async function* () {
      yield { choices: [{ delta: { content: '<p>Hola</p>' } }] };
    })(),
  });
  const app = appWith(route);
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/generate-document/generate-word`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', prompt: 'doc', provider: 'OpenAI' }),
    });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.match(res.headers.get('cache-control') || '', /no-transform/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let first = '';
    while (!first.includes('\n\n')) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'stream ended before preamble');
      first += decoder.decode(value, { stream: true });
    }
    assert.match(first, /^: connected\n\n/, `first frame was:\n${first}`);
    try { reader.cancel(); } catch { /* ignore */ }
  } finally {
    await shutdown(server);
  }
});

test('generate-word streams tokens and terminates with data: {"done":true}', async () => {
  const { route } = loadRouteWithMocks({
    openaiStreamFactory: async () => (async function* () {
      yield { choices: [{ delta: { content: '<p>uno</p>' } }] };
      yield { choices: [{ delta: { content: '<p>dos</p>' } }] };
    })(),
  });
  const app = appWith(route);
  const { raw } = await postWord(app);
  assert.ok(raw.includes('"content":"<p>uno</p>"'), raw);
  assert.ok(raw.includes('"done":true'), `missing done terminator in:\n${raw}`);
});

test('generate-word passes an AbortSignal and stops writing after client disconnect', async () => {
  let createOptions = null;
  let generatorFinished = false;
  const { route } = loadRouteWithMocks({
    openaiStreamFactory: async (_payload, options) => {
      createOptions = options;
      return (async function* () {
        try {
          for (let i = 0; i < 1000; i++) {
            if (options?.signal?.aborted) return;
            yield { choices: [{ delta: { content: `frag${i} ` } }] };
            await new Promise((r) => setTimeout(r, 5));
          }
        } finally {
          generatorFinished = true;
        }
      })();
    },
  });
  const app = appWith(route);
  const { raw } = await postWord(app, { abortAfterMs: 60 });
  assert.ok(createOptions?.signal, 'model stream did not receive an AbortSignal');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(createOptions.signal.aborted, true, 'AbortSignal not fired on disconnect');
  assert.equal(generatorFinished, true, 'model generator kept running after disconnect');
  assert.ok(!raw.includes('"done":true'), 'disconnected client must not receive done');
});

test('generate-word flushes the preamble before the silent first-token window ends', async () => {
  // Provider stays silent behind a gate: everything received before release
  // must be exactly the preamble — proving headers+comment go out ahead of
  // any model token (what keeps proxies from killing the idle window).
  let release;
  const gate = new Promise((r) => { release = r; });
  const { route } = loadRouteWithMocks({
    openaiStreamFactory: async () => (async function* () {
      await gate;
      yield { choices: [{ delta: { content: '<p>tarde</p>' } }] };
    })(),
  });
  const app = appWith(route);
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/generate-document/generate-word`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', prompt: 'doc', provider: 'OpenAI' }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // Timed read that REUSES the pending read across ticks: racing a fresh
    // reader.read() against a timer leaks the losing read, which swallows
    // the next delivered chunk and breaks the post-release assertions.
    let pending = null;
    const readWithTimeout = async (ms) => {
      if (!pending) pending = reader.read();
      const winner = await Promise.race([
        pending.then((v) => ({ v })),
        new Promise((r) => setTimeout(() => r(null), ms)),
      ]);
      if (winner === null) return null;
      pending = null;
      return winner.v;
    };

    // While the provider is gated, poll briefly: only comment frames allowed.
    let pre = '';
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const chunk = await readWithTimeout(40);
      if (chunk === null) continue;
      if (chunk.done) break;
      pre += decoder.decode(chunk.value, { stream: true });
      assert.ok(pre.split('\n').every((l) => l === '' || l.startsWith(':')), 'non-comment bytes before first token');
    }
    assert.match(pre, /^: connected\n\n/);

    release();
    let raw = pre;
    const done2 = Date.now() + 5000;
    while (Date.now() < done2) {
      const chunk = await readWithTimeout(1000);
      if (chunk === null) continue;
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
      if (raw.includes('"done":true')) break;
    }
    assert.ok(raw.includes('"content":"<p>tarde</p>"'));
    assert.ok(raw.includes('"done":true'), 'stream did not finish after gate release');
    try { reader.cancel(); } catch { /* ignore */ }
  } finally {
    await shutdown(server);
  }
});
