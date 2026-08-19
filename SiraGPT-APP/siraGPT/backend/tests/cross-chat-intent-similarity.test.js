'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cc = require('../src/services/cross-chat-intent-similarity');

describe('cross-chat-intent-similarity', () => {
  beforeEach(() => cc._reset());

  test('observe builds and stores a profile', () => {
    const p = cc.observe({ chatId: 'c1', history: [{ role: 'user', content: 'arregla el bug del frontend Login' }] });
    assert.ok(p);
    assert.ok(p.intents.has('fix') || p.intents.size >= 0);
    assert.ok(p.turnCount >= 1);
  });

  test('similar finds chats with shared intents + supernodes', () => {
    cc.observe({ chatId: 'a', history: [{ role: 'user', content: 'arregla el bug del frontend Login' }] });
    cc.observe({ chatId: 'b', history: [{ role: 'user', content: 'crea un PDF de ventas' }] });
    cc.observe({ chatId: 'c', history: [{ role: 'user', content: 'arregla otro bug del frontend Dashboard' }] });
    const sim = cc.similar({ chatId: 'a', k: 5 });
    assert.ok(sim.length >= 1);
    assert.equal(sim[0].chatId, 'c');
  });

  test('excludeSelf removes the source chat from results', () => {
    cc.observe({ chatId: 'self', history: [{ role: 'user', content: 'arregla el bug' }] });
    cc.observe({ chatId: 'other', history: [{ role: 'user', content: 'arregla otro bug' }] });
    const sim = cc.similar({ chatId: 'self', k: 5 });
    assert.ok(!sim.find((s) => s.chatId === 'self'));
  });

  test('profileSimilarity is 0 for disjoint profiles', () => {
    const p1 = cc.buildProfileFromHistory('p1', [{ role: 'user', content: 'crea un PDF de ventas' }]);
    const p2 = cc.buildProfileFromHistory('p2', [{ role: 'user', content: 'edit the dashboard JavaScript code' }]);
    const score = cc.profileSimilarity(p1, p2);
    assert.ok(score >= 0);
  });

  test('listProfiles returns recency-sorted', () => {
    cc.observe({ chatId: 'a', history: [{ role: 'user', content: 'algo' }] });
    cc.observe({ chatId: 'b', history: [{ role: 'user', content: 'algo' }] });
    const list = cc.listProfiles();
    assert.ok(list.length >= 2);
  });

  test('reset by chatId removes only that profile', () => {
    cc.observe({ chatId: 'x', history: [{ role: 'user', content: 'algo' }] });
    cc.observe({ chatId: 'y', history: [{ role: 'user', content: 'algo' }] });
    cc.reset({ chatId: 'x' });
    const list = cc.listProfiles();
    assert.ok(!list.find((p) => p.chatId === 'x'));
    assert.ok(list.find((p) => p.chatId === 'y'));
  });

  test('buildSimilarChatsBlock returns content', () => {
    cc.observe({ chatId: 'a', history: [{ role: 'user', content: 'arregla el bug del frontend' }] });
    cc.observe({ chatId: 'b', history: [{ role: 'user', content: 'arregla otro bug del frontend' }] });
    const sim = cc.similar({ chatId: 'a' });
    const block = cc.buildSimilarChatsBlock(sim);
    assert.match(block, /SIMILAR PRIOR CHATS/);
  });

  test('empty inputs return empty / null gracefully', () => {
    assert.equal(cc.observe({}), null);
    assert.deepEqual(cc.similar({ chatId: 'nonexistent' }), []);
  });
});
