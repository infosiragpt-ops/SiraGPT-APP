'use strict';

/**
 * followup-suggestions — Open WebUI-style follow-up task, own implementation.
 * All tests offline (injected fake client).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateFollowUps,
  buildTranscript,
  parseFollowUps,
  MAX_HISTORY_MESSAGES,
  MAX_SUGGESTIONS,
} = require('../src/services/followup-suggestions');

const ENV_OK = { CEREBRAS_API_KEY: 'test-key', FREE_IA_MODEL_ID: 'test-model' };

function fakeClient(responseText) {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: responseText } }] }),
      },
    },
  };
}

test('buildTranscript: caps history, labels roles, drops empties', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
  }
  messages.push({ role: 'user', content: '   ' });
  const transcript = buildTranscript(messages);
  const rows = transcript.split('\n\n');
  assert.ok(rows.length <= MAX_HISTORY_MESSAGES);
  assert.match(transcript, /USUARIO: msg/);
  assert.match(transcript, /ASISTENTE: msg/);
  assert.doesNotMatch(transcript, /msg 0/, 'older messages beyond the cap are dropped');
});

test('parseFollowUps: bare JSON, fenced JSON and prose-wrapped JSON', () => {
  const bare = parseFollowUps('{"follow_ups": ["¿Uno?", "¿Dos?"]}');
  assert.deepEqual(bare, ['¿Uno?', '¿Dos?']);

  const fenced = parseFollowUps('```json\n{"follow_ups": ["¿A?"]}\n```');
  assert.deepEqual(fenced, ['¿A?']);

  const prose = parseFollowUps('Claro, aquí van: {"follow_ups": ["¿X?", "¿Y?"]}');
  assert.deepEqual(prose, ['¿X?', '¿Y?']);

  assert.equal(parseFollowUps('sin json aquí'), null);
  assert.equal(parseFollowUps(''), null);
});

test('parseFollowUps: caps at MAX_SUGGESTIONS and trims entries', () => {
  const many = JSON.stringify({ follow_ups: Array.from({ length: 10 }, (_, i) => `  ¿Pregunta ${i}?  `) });
  const parsed = parseFollowUps(many);
  assert.equal(parsed.length, MAX_SUGGESTIONS);
  assert.equal(parsed[0], '¿Pregunta 0?');
});

test('generateFollowUps: happy path with injected client', async () => {
  const result = await generateFollowUps(
    [
      { role: 'user', content: '¿Qué es la fotosíntesis?' },
      { role: 'assistant', content: 'Es el proceso por el cual las plantas…' },
    ],
    { env: ENV_OK, createClient: () => fakeClient('{"follow_ups": ["¿Qué factores la afectan?", "¿Cómo se mide?", "¿Qué rol juega la clorofila?"]}') },
  );
  assert.equal(result.ok, true);
  assert.equal(result.followUps.length, 3);
  assert.match(result.followUps[0], /factores/);
});

test('generateFollowUps: fail-open paths (empty, unconfigured, parse error, throw)', async () => {
  const empty = await generateFollowUps([], { env: ENV_OK });
  assert.deepEqual(empty, { ok: false, error: 'empty_conversation' });

  const noKey = await generateFollowUps([{ role: 'user', content: 'hola' }], { env: {} });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error, 'ai_unavailable');

  const badJson = await generateFollowUps(
    [{ role: 'user', content: 'hola' }],
    { env: ENV_OK, createClient: () => fakeClient('no json') },
  );
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error, 'parse_failed');

  const thrown = await generateFollowUps(
    [{ role: 'user', content: 'hola' }],
    {
      env: ENV_OK,
      createClient: () => ({ chat: { completions: { create: async () => { throw new Error('upstream 500'); } } } }),
    },
  );
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /upstream 500/);
});

test('follow-ups route: contract (validation + health)', async () => {
  const express = require('express');
  const { buildFollowUpsRouter } = require('../src/routes/followups');

  const app = express();
  app.use(express.json());
  app.use('/api/follow-ups', buildFollowUpsRouter({
    env: { ...ENV_OK, FOLLOWUPS_RATE_LIMIT_PER_MIN: '100' },
    auth: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
    createClient: () => fakeClient('{"follow_ups": ["¿Sigo?"]}'),
  }));

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/follow-ups/health`);
    assert.equal(health.status, 200);

    const bad = await fetch(`http://127.0.0.1:${port}/api/follow-ups/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});