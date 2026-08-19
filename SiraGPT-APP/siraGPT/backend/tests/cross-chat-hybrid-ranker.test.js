'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const hr = require('../src/services/cross-chat-hybrid-ranker');
const ccs = require('../src/services/cross-chat-intent-similarity');

describe('cross-chat-hybrid-ranker', () => {
  beforeEach(() => ccs._reset());

  test('empty candidates returns empty', () => {
    assert.deepEqual(hr.rerank({ candidates: [] }), []);
  });

  test('hybrid score combines cosine + intent', () => {
    // Set up two profiles.
    ccs.observe({ chatId: 'cur', history: [{ role: 'user', content: 'arregla el bug del frontend Login' }] });
    ccs.observe({ chatId: 'sim', history: [{ role: 'user', content: 'arregla otro bug del frontend Dashboard' }] });
    ccs.observe({ chatId: 'far', history: [{ role: 'user', content: 'crea un PDF de ventas' }] });
    const candidates = [
      { chatId: 'sim', question: 'similar chat', similarity: 0.5 },
      { chatId: 'far', question: 'distant chat', similarity: 0.7 },
    ];
    const ranked = hr.rerank({ currentChatId: 'cur', candidates });
    // sim has higher intentScore; with default w=0.35 it can leapfrog far.
    assert.ok(ranked[0].combinedScore >= ranked[1].combinedScore);
    assert.equal(ranked[0].chatId, 'sim');
  });

  test('weight=0 falls back to pure cosine order', () => {
    ccs.observe({ chatId: 'cur', history: [{ role: 'user', content: 'arregla el bug' }] });
    ccs.observe({ chatId: 'low', history: [{ role: 'user', content: 'arregla un bug' }] });
    ccs.observe({ chatId: 'high', history: [{ role: 'user', content: 'crea un PDF' }] });
    const candidates = [
      { chatId: 'low', question: 'low cosine', similarity: 0.2 },
      { chatId: 'high', question: 'high cosine', similarity: 0.9 },
    ];
    const ranked = hr.rerank({ currentChatId: 'cur', candidates, weight: 0 });
    assert.equal(ranked[0].chatId, 'high');
  });

  test('weight=1 falls back to pure intent order', () => {
    ccs.observe({ chatId: 'cur', history: [{ role: 'user', content: 'arregla el bug del frontend' }] });
    ccs.observe({ chatId: 'sim', history: [{ role: 'user', content: 'arregla otro bug del frontend' }] });
    ccs.observe({ chatId: 'unrelated', history: [{ role: 'user', content: 'crea un PDF de ventas' }] });
    const candidates = [
      { chatId: 'sim', question: 'intent match', similarity: 0.1 },
      { chatId: 'unrelated', question: 'cosine higher', similarity: 0.9 },
    ];
    const ranked = hr.rerank({ currentChatId: 'cur', candidates, weight: 1 });
    assert.equal(ranked[0].chatId, 'sim');
  });

  test('missing currentProfile → intent score is 0 for all', () => {
    const candidates = [{ chatId: 'x', question: 'q', similarity: 0.5 }];
    const ranked = hr.rerank({ currentChatId: 'nonexistent', candidates });
    assert.equal(ranked[0].intentScore, 0);
  });

  test('buildHybridBlock returns content', () => {
    ccs.observe({ chatId: 'a', history: [{ role: 'user', content: 'algo' }] });
    const candidates = [{ chatId: 'a', question: 'something', similarity: 0.7 }];
    const ranked = hr.rerank({ currentChatId: 'a', candidates });
    const block = hr.buildHybridBlock(ranked);
    assert.match(block, /HYBRID CROSS-CHAT/);
  });

  test('preserves all original fields on output', () => {
    ccs.observe({ chatId: 'a', history: [{ role: 'user', content: 'algo' }] });
    const candidates = [{ chatId: 'a', question: 'q', answer: 'r', daysAgo: 3, similarity: 0.5 }];
    const ranked = hr.rerank({ currentChatId: 'a', candidates });
    assert.equal(ranked[0].answer, 'r');
    assert.equal(ranked[0].daysAgo, 3);
  });
});
