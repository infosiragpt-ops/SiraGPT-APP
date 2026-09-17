'use strict';

// Memoria Hermes del usuario dentro del system prompt de codex. Offline:
// bridge inyectado, sin stores reales.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadUserMemory, userMemoryEnabled, DEFAULT_MAX_CHARS } = require('../src/services/codex/user-memory');
const { buildSystemPrompt } = require('../src/services/codex/agent-loop');

function bridgeReturning(text) {
  const calls = [];
  return { calls, buildMemoryPrompt: (userId, opts) => { calls.push([userId, opts]); return text; } };
}

test('loadUserMemory: apagado con CODEX_USER_MEMORY=0, vacío sin userId, vacío si el bridge no devuelve nada', () => {
  const bridge = bridgeReturning('## Active Memory\n- usa pnpm');
  assert.equal(userMemoryEnabled({ CODEX_USER_MEMORY: '0' }), false);
  assert.equal(userMemoryEnabled({}), true);
  assert.equal(loadUserMemory({ userId: 'u1', env: { CODEX_USER_MEMORY: '0', NODE_ENV: 'test' }, bridge }), '');
  assert.equal(bridge.calls.length, 0, 'apagado: no toca el bridge');
  assert.equal(loadUserMemory({ userId: '', env: { NODE_ENV: 'test' }, bridge }), '');
  assert.equal(loadUserMemory({ userId: 'u1', env: { NODE_ENV: 'test' }, bridge: bridgeReturning('   ') }), '');
});

test('loadUserMemory: pasa userId/chatId/limit al bridge y devuelve el bloque recortado al tope', () => {
  const bridge = bridgeReturning('## Active Memory\n- siempre TypeScript estricto\n- prefiere pnpm');
  const out = loadUserMemory({ userId: 'u1', chatId: 'chat-9', env: { NODE_ENV: 'test', CODEX_USER_MEMORY_LIMIT: '5' }, bridge });
  assert.match(out, /TypeScript estricto/);
  assert.deepEqual(bridge.calls[0], ['u1', { limit: 5, chatId: 'chat-9' }]);

  const long = bridgeReturning('x'.repeat(DEFAULT_MAX_CHARS + 500));
  const capped = loadUserMemory({ userId: 'u1', env: { NODE_ENV: 'test' }, bridge: long });
  assert.ok(capped.length <= DEFAULT_MAX_CHARS + 30);
  assert.match(capped, /memoria recortada/);

  const tiny = loadUserMemory({ userId: 'u1', env: { NODE_ENV: 'test', CODEX_USER_MEMORY_MAX_CHARS: '10' }, bridge: bridgeReturning('0123456789ABCDEF') });
  assert.match(tiny, /^0123456789\n/);
});

test('loadUserMemory: un bridge que lanza o sin buildMemoryPrompt nunca rompe (devuelve "")', () => {
  assert.equal(loadUserMemory({ userId: 'u1', env: { NODE_ENV: 'test' }, bridge: { buildMemoryPrompt: () => { throw new Error('store down'); } } }), '');
  assert.equal(loadUserMemory({ userId: 'u1', env: { NODE_ENV: 'test' }, bridge: {} }), '');
});

test('buildSystemPrompt: incluye el bloque MEMORIA DEL USUARIO solo cuando hay memoria', () => {
  const base = { project: { name: 'Demo' }, plan: null, fileTree: [], sourcePrompt: 'haz una landing', projectNotes: '' };
  const withMemory = buildSystemPrompt({ ...base, userMemory: '## Active Memory\n- siempre pnpm' });
  assert.match(withMemory, /MEMORIA DEL USUARIO/);
  assert.match(withMemory, /siempre pnpm/);
  const without = buildSystemPrompt({ ...base, userMemory: '' });
  assert.ok(!without.includes('MEMORIA DEL USUARIO'));
  const omitted = buildSystemPrompt(base);
  assert.ok(!omitted.includes('MEMORIA DEL USUARIO'));
});
