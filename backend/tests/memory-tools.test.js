'use strict';

/**
 * agents/memory-tools — memory_read_topic / memory_search / memory_write /
 * memory_forget / chat_history_search: user-scoped, same-conversation writes,
 * and wired into the agentic chat toolset + labels + guidance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakePrisma } = require('./helpers/fake-memory-prisma');
const vault = require('../src/services/memory/vault');
const chatHistory = require('../src/services/memory/chat-history-search');
const tools = require('../src/services/agents/memory-tools');

const U = 'user-1';
const quiet = { warn() {}, info() {} };
let db;
test.beforeEach(() => {
  vault.resetForTests(); chatHistory.resetForTests();
  db = createFakePrisma();
  vault.setDeps({ prisma: db, log: quiet });
  chatHistory.setDeps({ prisma: db, log: quiet });
});

test('every tool refuses to run without an authenticated user (never cross-user)', async () => {
  for (const t of tools.MEMORY_TOOLS) {
    const r = await t.execute({ query: 'x', topic: 'x', text: 'hecho de prueba', id: 'y' }, {});
    assert.equal(r.ok, false); assert.match(r.error, /requires an authenticated user/);
  }
  assert.deepEqual(tools.MEMORY_TOOL_NAMES, ['memory_read_topic', 'memory_search', 'memory_write', 'memory_forget', 'chat_history_search', 'connector_search']);
  for (const t of tools.MEMORY_TOOLS) {
    assert.equal(t.parameters.type, 'object'); assert.equal(t.parameters.additionalProperties, false);
    assert.ok(t.description.length > 40);
  }
});

test('memory_write → memory_search → memory_read_topic → memory_forget round trip in one conversation', async () => {
  const events = [];
  const ctx = { userId: U, chatId: 'chat-42', onEvent: (e) => events.push(e) };
  const w = await tools.memoryWrite.execute({ text: 'Prefiere que las respuestas incluyan ejemplos de código', topic: 'preferencias' }, ctx);
  assert.equal(w.ok, true); assert.equal(w.created, true); assert.equal(w.entry.topic, 'preference');
  assert.equal((await vault.list(U))[0].source, 'tool:chat-42');
  const again = await tools.memoryWrite.execute({ text: 'Prefiere que las respuestas incluyan ejemplos de código' }, ctx);
  assert.equal(again.created, false);
  const blocked = await tools.memoryWrite.execute({ text: 'su tarjeta es 4111 1111 1111 1111' }, ctx);
  assert.equal(blocked.ok, false); assert.equal(blocked.error, 'memory_text_looks_like_secret');
  const s = await tools.memorySearch.execute({ query: 'ejemplos de código' }, ctx);
  assert.equal(s.ok, true); assert.equal(s.mode, 'grep'); assert.equal(s.results.length, 1);
  const s2 = await tools.memorySearch.execute({ query: 'ejemplos', topic: 'work' }, ctx);
  assert.equal(s2.results.length, 0, 'topic filter honoured');
  const t = await tools.memoryReadTopic.execute({ topic: 'preference' }, ctx);
  assert.equal(t.ok, true); assert.equal(t.label, 'Preferencias'); assert.equal(t.entries.length, 1);
  const f = await tools.memoryForget.execute({ query: 'ejemplos de código' }, ctx);
  assert.equal(f.ok, true); assert.equal(f.removed, 1);
  assert.equal((await vault.list(U)).length, 0);
  assert.equal((await tools.memoryForget.execute({}, ctx)).ok, false);
  assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'memory_write'));
  assert.ok(events.some((e) => e.type === 'tool_output' && e.tool === 'memory_forget' && /1 entrada/.test(e.preview)));
});

test('chat_history_search runs the FTS query scoped to the user and excludes the current chat by default', async () => {
  db._state.rawResult = [{ messageId: 'm1', chatId: 'chat-1', chatTitle: 'Presupuesto', role: 'user', timestamp: new Date('2026-09-01T10:00:00Z'), rank: 0.4, snippet: 'el «presupuesto» es 3.000' }];
  const r = await tools.chatHistorySearch.execute({ query: 'presupuesto' }, { userId: U, chatId: 'chat-9' });
  assert.equal(r.ok, true); assert.equal(r.mode, 'fts'); assert.equal(r.results[0].chatTitle, 'Presupuesto');
  const q = db._state.raw[0];
  assert.match(q.sql, /websearch_to_tsquery/); assert.match(q.sql, /c\."userId"\s+= \$3/);
  assert.deepEqual(q.params.slice(0, 3), ['spanish', 'presupuesto', U]);
  assert.match(q.sql, /m\."chatId" <> \$4/); assert.equal(q.params[3], 'chat-9');
  const r2 = await tools.chatHistorySearch.execute({ query: 'presupuesto', includeCurrentChat: true }, { userId: U, chatId: 'chat-9' });
  assert.equal(r2.ok, true);
  assert.doesNotMatch(db._state.raw[1].sql, /<>/);
  assert.equal((await tools.chatHistorySearch.execute({ query: 'x' }, { userId: U })).error, 'query_too_short');
});

test('chat_history_search falls back to ILIKE when the tsvector query fails', async () => {
  let calls = 0;
  chatHistory.setDeps({ prisma: { $queryRawUnsafe: async (sql) => { calls += 1; if (/content_tsv/.test(sql)) throw new Error('column "content_tsv" does not exist'); return [{ messageId: 'm', chatId: 'c', role: 'assistant', timestamp: new Date(), rank: 0.1, snippet: 'texto' }]; } }, log: quiet });
  const r = await chatHistory.searchUserMessages(U, 'texto');
  assert.equal(r.mode, 'ilike'); assert.equal(calls, 2); assert.equal(r.results.length, 1);
});

test('wiring: chat toolset loads the memory tools, core-visible names, stage labels and guidance', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'agentic-chat-stream.js'), 'utf8');
  assert.match(src, /require\('\.\/agents\/memory-tools'\)\.MEMORY_TOOLS/);
  assert.match(src, /\.\.\.loadTaskTools\(\), \.\.\.loadMemoryTools\(\),/);
  assert.match(src, /'memory_read_topic', 'memory_search', 'memory_write', 'memory_forget', 'chat_history_search',/);
  for (const name of tools.MEMORY_TOOL_NAMES) assert.match(src, new RegExp(`^\\s+${name}: \\(`, 'm'), `stage label for ${name}`);
  assert.match(src, /Abre un tema con `memory_read_topic`, busca con `memory_search`/);
});
