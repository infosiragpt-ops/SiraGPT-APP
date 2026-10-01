'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleGithubConnectionTurn } = require('../src/services/github/github-chat-turn');
const { GITHUB_HANDOFF_MESSAGE } = require('../src/services/github/github-chat-handoff');

function fixture(overrides = {}) {
  const frames = [];
  const checks = [];
  return {
    frames, checks,
    input: {
      prompt: 'pásame el link de GitHub para loguearme', userId: 'user-1', chatId: 'chat-1',
      db: { chat: { findFirst: async query => { checks.push(query); return { id: 'chat-1' }; } } },
      emit: async frame => { frames.push(frame); },
      ...overrides,
    },
  };
}

test('an explicit connection turn verifies ownership before emitting a correlated consent action', async () => {
  const fx = fixture();
  const out = await handleGithubConnectionTurn(fx.input);
  assert.deepEqual(fx.checks, [{ where: { id: 'chat-1', userId: 'user-1', deletedAt: null }, select: { id: true } }]);
  assert.equal(fx.frames.length, 2);
  assert.deepEqual(Object.keys(fx.frames[0]).sort(), ['chatId', 'handoffId', 'type']);
  assert.equal(fx.frames[0].type, 'github_connection_required');
  assert.equal(fx.frames[0].chatId, 'chat-1');
  assert.match(fx.frames[0].handoffId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(fx.frames[1], { replace: true, content: GITHUB_HANDOFF_MESSAGE });
  assert.deepEqual(out, { answer: GITHUB_HANDOFF_MESSAGE, handoff: fx.frames[0] });
});

test('current attachments, selected modalities and read-only/disabled turns retain their existing routing', async () => {
  for (const overrides of [
    { files: [{ id: 'file-1', name: 'conecta-github.docx' }] },
    ...['image', 'voice', 'video', 'music', 'Imágenes'].map(modality => ({ modality })),
    { disableAgentic: true }, { publicWebReadonly: true },
    { userId: null }, { chatId: null },
    { prompt: '¿Cómo conecto GitHub?' }, { prompt: 'no me abras GitHub' },
    { prompt: 'Abre https://github.com/example/repo' }, { prompt: 'hola' },
  ]) {
    const fx = fixture(overrides);
    assert.equal(await handleGithubConnectionTurn(fx.input), null, JSON.stringify(overrides));
    assert.equal(fx.checks.length, 0, 'non-connection turns do not access the chat store');
    assert.equal(fx.frames.length, 0);
  }
});

test('missing, invalid and foreign chats cannot issue a GitHub action', async () => {
  for (const overrides of [
    { chatId: '../chat-1', expectedCode: 'invalid_chat_id' },
    { chatId: 'c'.repeat(65), expectedCode: 'invalid_chat_id' },
    { db: { chat: { findFirst: async () => null } }, expectedCode: 'coding_chat_not_found' },
    { db: null, expectedCode: 'codex_store_unavailable' },
  ]) {
    const { expectedCode, ...input } = overrides;
    const fx = fixture(input);
    await assert.rejects(handleGithubConnectionTurn(fx.input), { code: expectedCode });
    assert.equal(fx.frames.length, 0);
  }
});

test('Stop before or during ownership verification prevents the browser action', async () => {
  const stopped = fixture({ signal: AbortSignal.abort() });
  await assert.rejects(handleGithubConnectionTurn(stopped.input), { name: 'AbortError' });
  assert.equal(stopped.frames.length, 0);
  assert.equal(stopped.checks.length, 0);
  const controller = new AbortController();
  const concurrent = fixture({
    signal: controller.signal,
    db: { chat: { findFirst: async () => { controller.abort(); return { id: 'chat-1' }; } } },
  });
  await assert.rejects(handleGithubConnectionTurn(concurrent.input), { name: 'AbortError' });
  assert.equal(concurrent.frames.length, 0);
});

test('ownership and stream errors remain visible instead of announcing consent completion', async () => {
  const storeError = new Error('Fixture store unavailable');
  const databaseFailure = fixture({ db: { chat: { findFirst: async () => { throw storeError; } } } });
  await assert.rejects(handleGithubConnectionTurn(databaseFailure.input), error => error === storeError);
  assert.equal(databaseFailure.frames.length, 0);
  const streamError = new Error('Fixture stream closed');
  const streamFailure = fixture({ emit: async () => { throw streamError; } });
  await assert.rejects(handleGithubConnectionTurn(streamFailure.input), error => error === streamError);
});
