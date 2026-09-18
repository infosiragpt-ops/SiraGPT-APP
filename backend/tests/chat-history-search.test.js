'use strict';

/**
 * memory/chat-history-search — SQL builders are pure and bounded; the route
 * /api/memory now serves the vault + consolidation endpoints.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chs = require('../src/services/memory/chat-history-search');

test('buildFtsQuery: bound params, sane lang fallback, optional chat filters, clamped limit', () => {
  const { sql, params } = chs.buildFtsQuery({ userId: 'u', query: '"frase exacta" OR otra', lang: 'klingon', chatId: 'c1', limit: 999 });
  assert.deepEqual(params, ['spanish', '"frase exacta" OR otra', 'u', 'c1', 30]);
  assert.match(sql, /websearch_to_tsquery\(\$1::regconfig, \$2\)/);
  assert.match(sql, /m\."chatId" = \$4/);
  assert.match(sql, /LIMIT \$5/);
  assert.doesNotMatch(sql, /frase exacta/, 'user text never interpolated into SQL');
  const { params: p2 } = chs.buildFtsQuery({ userId: 'u', query: 'x'.repeat(1000), lang: 'english', excludeChatId: 'c9', limit: 0 });
  assert.equal(p2[1].length, 400); assert.equal(p2[0], 'english'); assert.equal(p2[3], 'c9'); assert.equal(p2[4], 8);
});

test('buildIlikeQuery: pattern is a bound parameter', () => {
  const { sql, params } = chs.buildIlikeQuery({ userId: 'u', query: "O'Neil", limit: 5 });
  assert.equal(params[1], "%O'Neil%"); assert.match(sql, /ILIKE \$2/); assert.doesNotMatch(sql, /O'Neil/);
});

test('normalizeRows collapses whitespace and stringifies timestamps', () => {
  const rows = chs.normalizeRows([{ messageId: 'm', chatId: 'c', role: 'user', timestamp: new Date('2026-01-02T03:04:05Z'), rank: '0.5', snippet: ' a\n b  c ' }]);
  assert.equal(rows[0].snippet, 'a b c'); assert.equal(rows[0].timestamp, '2026-01-02T03:04:05.000Z'); assert.equal(rows[0].rank, 0.5);
});

test('route contract: /api/memory serves the vault, index, topics, search and consolidation endpoints', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'memory.js'), 'utf8');
  assert.match(src, /require\('\.\.\/services\/memory\/vault'\)/);
  assert.match(src, /require\('\.\.\/services\/memory\/consolidation'\)/);
  assert.doesNotMatch(src, /memoryDocument\.getDocument/);
  for (const route of ["router.get('/index'", "router.get('/topics/:topic'", "router.get('/search'", "router.get('/consolidation'", "router.post('/consolidation/run'", "router.post('/consolidation/:id/revert'"]) {
    assert.ok(src.includes(route), route);
  }
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'api.ts'), 'utf8');
  assert.match(api, /getMemoryConsolidation\(\)/); assert.match(api, /revertMemoryConsolidation\(id: string\)/);
  const card = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'settings', 'MemorySettingsCard.tsx'), 'utf8');
  assert.match(card, /data-memory-consolidation="1"/); assert.match(card, /Consolidar ahora/); assert.match(card, /Deshacer/);
});
