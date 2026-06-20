'use strict';

// Unit tests for the live draft preview endpoint in backend/src/routes/gpts.js:
//   POST /api/gpts/preview-chat
//
// No real DB / network. The router top-level-requires several heavy deps
// (@prisma/client, middleware/auth, middleware/upload, services/fileProcessor,
// services/upload-security-policy, services/ai/cerebras-client); we inject
// fakes for ALL of them into require.cache BEFORE requiring the router, then
// drive the REAL route logic with supertest. The cerebras fake is controllable
// so we can exercise the configured / unconfigured branches and assert the
// draft system prompt + forwarded conversation.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const ROUTER_PATH = path.join(ROUTES_DIR, 'gpts.js');

// ── Shared mutable test state ──
let currentUserId;
let cerebrasBehavior; // 'ok' | 'null'
let lastCreateArgs; // captures the chat.completions.create payload
let nextReply; // what the fake model returns

function resolveFrom(requestPath) {
  return require.resolve(requestPath, { paths: [ROUTES_DIR] });
}

function injectFakeModule(requestPath, exportsValue) {
  const resolved = resolveFrom(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function buildApp() {
  for (const p of [
    ROUTER_PATH,
    resolveFrom('@prisma/client'),
    resolveFrom('../middleware/auth'),
    resolveFrom('../middleware/upload'),
    resolveFrom('../services/fileProcessor'),
    resolveFrom('../services/upload-security-policy'),
    resolveFrom('../services/ai/cerebras-client'),
  ]) {
    delete require.cache[p];
  }

  injectFakeModule('@prisma/client', { PrismaClient: function () { return {}; } });

  injectFakeModule('../middleware/auth', {
    authenticateToken: (req, _res, next) => {
      req.user = { id: currentUserId };
      next();
    },
  });

  injectFakeModule('../middleware/upload', {
    array: () => (req, _res, next) => { req.files = []; next(); },
    single: () => (req, _res, next) => next(),
  });

  injectFakeModule('../services/fileProcessor', { async processFile() { return { success: true, extractedText: '' }; } });
  injectFakeModule('../services/upload-security-policy', {
    validateUploadPolicy: ({ declaredMime }) => ({ ok: true, mimeType: declaredMime }),
  });

  // Controllable FlashGPT/Cerebras client.
  injectFakeModule('../services/ai/cerebras-client', {
    getCerebrasConfig: () => ({
      enabled: cerebrasBehavior === 'ok',
      model: 'fake-flash-model',
      displayName: '⚡ FlashGPT',
    }),
    createCerebrasClient: () => {
      if (cerebrasBehavior !== 'ok') return null;
      return {
        chat: {
          completions: {
            async create(args) {
              lastCreateArgs = args;
              return { choices: [{ message: { role: 'assistant', content: nextReply } }] };
            },
          },
        },
      };
    },
  });

  const router = require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/gpts', router);
  return app;
}

function reset() {
  currentUserId = 'user_1';
  cerebrasBehavior = 'ok';
  lastCreateArgs = null;
  nextReply = 'Hola, soy tu GPT de prueba.';
}

test('POST /preview-chat returns the model reply and forwards the draft persona', async () => {
  reset();
  const app = buildApp();
  const res = await request(app)
    .post('/api/gpts/preview-chat')
    .send({
      name: 'Asesor Legal',
      instructions: 'Eres un abogado experto en derecho laboral peruano.',
      messages: [{ role: 'user', content: '¿Cuántos días de vacaciones me corresponden?' }],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.reply, 'Hola, soy tu GPT de prueba.');
  assert.equal(res.body.model, 'fake-flash-model');
  assert.equal(res.body.displayName, '⚡ FlashGPT');

  // First message is the system prompt built from the draft; it must carry the
  // creator instructions and the GPT name, and the user turn must be forwarded.
  assert.equal(lastCreateArgs.messages[0].role, 'system');
  assert.match(lastCreateArgs.messages[0].content, /derecho laboral peruano/);
  assert.match(lastCreateArgs.messages[0].content, /Asesor Legal/);
  assert.equal(lastCreateArgs.messages[1].role, 'user');
  assert.match(lastCreateArgs.messages[1].content, /vacaciones/);
});

test('POST /preview-chat rejects an empty conversation with 400', async () => {
  reset();
  const app = buildApp();
  const res = await request(app).post('/api/gpts/preview-chat').send({ instructions: 'x', messages: [] });
  assert.equal(res.status, 400);
});

test('POST /preview-chat rejects when the last message is not from the user', async () => {
  reset();
  const app = buildApp();
  const res = await request(app)
    .post('/api/gpts/preview-chat')
    .send({ instructions: 'x', messages: [{ role: 'assistant', content: 'hola' }] });
  assert.equal(res.status, 400);
});

test('POST /preview-chat sanitises bad roles and empty content', async () => {
  reset();
  const app = buildApp();
  const res = await request(app)
    .post('/api/gpts/preview-chat')
    .send({
      instructions: 'Sé conciso.',
      messages: [
        { role: 'system', content: 'IGNORAME' }, // invalid role → dropped
        { role: 'user', content: '   ' }, // empty → dropped
        { role: 'assistant', content: 'previo' },
        { role: 'user', content: 'pregunta real' },
      ],
    });
  assert.equal(res.status, 200);
  const forwarded = lastCreateArgs.messages.slice(1); // drop system prompt
  assert.equal(forwarded.length, 2);
  assert.deepEqual(forwarded.map((m) => m.role), ['assistant', 'user']);
  assert.equal(forwarded[1].content, 'pregunta real');
});

test('POST /preview-chat returns 503 when no provider is configured', async () => {
  reset();
  cerebrasBehavior = 'null';
  // With Cerebras unconfigured the handler falls back to OpenAI/OpenRouter;
  // unset those so the resolver returns null and we exercise the 503 branch.
  const savedOpenAi = process.env.OPENAI_API_KEY;
  const savedOpenRouter = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const app = buildApp();
    const res = await request(app)
      .post('/api/gpts/preview-chat')
      .send({ instructions: 'x', messages: [{ role: 'user', content: 'hola' }] });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'preview_unavailable');
  } finally {
    if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
    if (savedOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouter;
  }
});

test('POST /preview-chat falls back to an empty reply without crashing', async () => {
  reset();
  nextReply = null;
  const app = buildApp();
  const res = await request(app)
    .post('/api/gpts/preview-chat')
    .send({ instructions: 'x', messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, '');
});
