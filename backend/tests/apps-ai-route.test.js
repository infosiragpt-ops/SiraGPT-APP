'use strict';

/**
 * /api/apps-ai — offline tests for the generated-apps AI proxy.
 *
 * Covers: payload validation (roles, sizes, counts), the platform system
 * prompt always leading, happy path via an injected fake client, degraded
 * 503 without configuration, upstream failure → 502, health, and the
 * skills-side trigger that routes AI-app prompts to the app-con-ia playbook.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { buildAppsAiRouter, validateBody, DEFAULT_SYSTEM } = require('../src/routes/apps-ai');

const ENV_OK = { CEREBRAS_API_KEY: 'csk-test', FREE_IA_MODEL_ID: 'gpt-oss-120b', APPS_AI_RATE_LIMIT_PER_MIN: '100' };

function appWith(deps) {
  const app = express();
  app.use(express.json());
  app.use('/api/apps-ai', buildAppsAiRouter(deps));
  return app;
}

test('validateBody: roles, sizes and counts', () => {
  assert.equal(validateBody({}).error, 'messages_required');
  assert.equal(validateBody({ messages: [] }).error, 'messages_required');
  assert.equal(validateBody({ messages: [{ role: 'tool', content: 'x' }] }).error, 'invalid_role');
  assert.equal(validateBody({ messages: [{ role: 'user', content: '' }] }).error, 'empty_message');
  assert.equal(validateBody({ messages: [{ role: 'user', content: 'y'.repeat(4001) }] }).error, 'message_too_long');
  assert.equal(
    validateBody({ messages: Array.from({ length: 31 }, () => ({ role: 'user', content: 'x' })) }).error,
    'too_many_messages',
  );
  assert.equal(
    validateBody({ messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'y'.repeat(3900) })) }).error,
    'conversation_too_long',
  );
  const ok = validateBody({ messages: [{ role: 'user', content: ' hola ' }], system: ' sé chef ' });
  assert.deepEqual(ok.messages, [{ role: 'user', content: 'hola' }]);
  assert.equal(ok.system, 'sé chef');
});

test('chat happy path: platform system prompt leads, custom system respected', async () => {
  let captured = null;
  const app = appWith({
    env: ENV_OK,
    createClient: () => ({
      chat: { completions: { create: async (payload) => { captured = payload; return { choices: [{ message: { content: 'Hola, soy tu chef.' } }] }; } } },
    }),
  });
  const res = await request(app)
    .post('/api/apps-ai/chat')
    .send({ messages: [{ role: 'user', content: 'dame una receta' }], system: 'Eres un chef.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.text, 'Hola, soy tu chef.');
  assert.equal(captured.model, 'gpt-oss-120b');
  assert.equal(captured.messages[0].role, 'system');
  assert.equal(captured.messages[0].content, 'Eres un chef.');
  assert.equal(captured.messages[1].content, 'dame una receta');
  assert.ok(captured.max_tokens <= 1024);
});

test('chat without custom system uses the platform default', async () => {
  let captured = null;
  const app = appWith({
    env: ENV_OK,
    createClient: () => ({ chat: { completions: { create: async (p) => { captured = p; return { choices: [{ message: { content: 'ok' } }] }; } } } }),
  });
  await request(app).post('/api/apps-ai/chat').send({ messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(captured.messages[0].content, DEFAULT_SYSTEM);
});

test('unconfigured platform → 503 ai_unavailable (never leaks anything)', async () => {
  const app = appWith({ env: { APPS_AI_RATE_LIMIT_PER_MIN: '100' } });
  const res = await request(app).post('/api/apps-ai/chat').send({ messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'ai_unavailable');
});

test('upstream failure → 502 ai_error with bounded message', async () => {
  const app = appWith({
    env: ENV_OK,
    createClient: () => ({ chat: { completions: { create: async () => { throw new Error('boom upstream'); } } } }),
  });
  const res = await request(app).post('/api/apps-ai/chat').send({ messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'ai_error');
  assert.match(res.body.message, /boom upstream/);
});

test('invalid payload → 400 with the specific validation error', async () => {
  const app = appWith({ env: ENV_OK, createClient: () => ({}) });
  const res = await request(app).post('/api/apps-ai/chat').send({ messages: [{ role: 'root', content: 'x' }] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_role');
});

test('health reports configuration without secrets', async () => {
  const app = appWith({ env: ENV_OK });
  const res = await request(app).get('/api/apps-ai/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, configured: true });
  assert.ok(!JSON.stringify(res.body).includes('csk-'));
});

test('skills: AI-app prompts route to the app-con-ia playbook', () => {
  const skills = require('../src/services/codex/skills');
  for (const prompt of [
    'crea un chatbot para atención al cliente',
    'quiero un software como chatgpt para abogados',
    'un asistente virtual de cocina',
    'app con inteligencia artificial para resumir textos',
  ]) {
    assert.equal(skills.detectSkillForPrompt(prompt)?.name, 'app-con-ia', prompt);
  }
  const skill = skills.getSkill('app-con-ia');
  assert.match(skill.body, /askAI/);
  assert.match(skill.body, /NUNCA pidas al usuario una API key/);
});

// ─── Upstream deadline (a stalled Cerebras call must not pin the endpoint) ──

const { appsAiTimeoutMs } = require('../src/routes/apps-ai');

const HUNG = Symbol('hung');
function withinMs(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(HUNG), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Settles only when the request options' signal aborts — a stalled upstream.
// The 2.5 s backstop only exists so a regression fails instead of keeping
// supertest's socket (and the test process) open forever.
function stalledUntilAbort(signal) {
  return new Promise((_, reject) => {
    const backstop = setTimeout(() => reject(new Error('backstop')), 2_500);
    signal?.addEventListener('abort', () => {
      clearTimeout(backstop);
      reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
    }, { once: true });
  });
}

function stalledCreate(seen = {}) {
  return (payload, opts) => {
    seen.opts = opts;
    return stalledUntilAbort(opts?.signal);
  };
}

test('appsAiTimeoutMs: 30 s default, env override, capped at 120 s', () => {
  assert.equal(appsAiTimeoutMs({}), 30_000);
  assert.equal(appsAiTimeoutMs({ APPS_AI_TIMEOUT_MS: '8000' }), 8_000);
  assert.equal(appsAiTimeoutMs({ APPS_AI_TIMEOUT_MS: '0' }), 30_000);
  assert.equal(appsAiTimeoutMs({ APPS_AI_TIMEOUT_MS: 'x' }), 30_000);
  assert.equal(appsAiTimeoutMs({ APPS_AI_TIMEOUT_MS: '600000' }), 120_000);
});

test('stalled upstream → 504 ai_timeout within the deadline', async () => {
  const seen = {};
  const app = appWith({
    env: { ...ENV_OK, APPS_AI_TIMEOUT_MS: '60' },
    createClient: () => ({ chat: { completions: { create: stalledCreate(seen) } } }),
  });
  const res = await withinMs(
    request(app).post('/api/apps-ai/chat').send({ messages: [{ role: 'user', content: 'hola' }] }),
    2_000,
  );
  assert.notEqual(res, HUNG, '/chat must not hang on a stalled upstream');
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'ai_timeout');
  assert.ok(seen.opts?.signal instanceof AbortSignal);
});

test('a stream that stalls mid-way ends with an SSE error, not an open socket', async () => {
  const app = appWith({
    env: { ...ENV_OK, APPS_AI_TIMEOUT_MS: '80' },
    createClient: () => ({
      chat: {
        completions: {
          create: async (_payload, opts) => ({
            async* [Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: 'Hola' } }] };
              // Like the openai SDK: an aborted request ENDS the iterator, it does not throw.
              try { await stalledUntilAbort(opts?.signal); } catch (err) { if (err?.name === 'AbortError') return; throw err; }
            },
          }),
        },
      },
    }),
  });
  const res = await withinMs(
    request(app).post('/api/apps-ai/chat').send({ stream: true, messages: [{ role: 'user', content: 'hola' }] }),
    2_000,
  );
  assert.notEqual(res, HUNG, 'a stalled stream must be cut by the deadline');
  assert.match(res.text, /"delta":"Hola"/);
  assert.match(res.text, /"error":"ai_timeout"/);
  assert.doesNotMatch(res.text, /\[DONE\]/, 'a cut stream must not be reported as finished');
});

test('fast upstream is unaffected by the deadline', async () => {
  const app = appWith({
    env: { ...ENV_OK, APPS_AI_TIMEOUT_MS: '5000' },
    createClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }] }) } } }),
  });
  const res = await request(app).post('/api/apps-ai/chat').send({ messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'ok');
});
