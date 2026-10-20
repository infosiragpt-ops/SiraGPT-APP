'use strict';

/**
 * intent-triage escalation — vague one-liners on a fresh conversation get a
 * clarifying question; ordinary prompts and answers inside a conversation do
 * not, and the gray-zone judge is not consulted more often than before.
 *
 * The task-contract score only takes {0.12, 0.15, 0.3, 0.45, 0.85, 1}, so it
 * never flagged "excel" / "hazme uno" / "un plan". The token-level score does
 * (0.85), and it now escalates — only on a fresh conversation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { triageIntent } = require('../src/services/agents/intent-triage');

const analysis = (contract, token) => ({
  contract: { ambiguity_score: contract },
  request_intelligence: { ambiguity_score: token },
});

test('vague one-liner on a fresh conversation asks (token score escalates)', async () => {
  let judgeCalls = 0;
  const r = await triageIntent({
    analysis: analysis(0.15, 0.85),
    prompt: 'excel',
    recentTurns: [],
    judge: async () => { judgeCalls += 1; return { action: 'execute' }; },
  });
  assert.equal(r.action, 'ask');
  assert.equal(r.reason, 'ambiguity_score_high');
  assert.equal(r.score, 0.85);
  assert.equal(judgeCalls, 0, 'high escalation needs no LLM judge');
  assert.match(r.question, /[¿?]/);
});

test('the same terse message inside a conversation is an answer, not a new request', async () => {
  const r = await triageIntent({
    analysis: analysis(0.15, 0.85),
    prompt: 'resumen',
    recentTurns: [{ role: 'assistant', text: 'Perfecto, ¿qué necesitas de la tesis?' }],
  });
  assert.equal(r.action, 'execute');
  assert.equal(r.reason, 'ambiguity_score_low');
});

test('ordinary prompts stay below the gray zone: no judge latency added', async () => {
  let judgeCalls = 0;
  const judge = async () => { judgeCalls += 1; return { action: 'ask', question: '¿?' }; };
  for (const prompt of ['explícame la fotosíntesis', 'crea una ppt de la gestión administrativa en 10 diapositivas']) {
    const r = await triageIntent({ analysis: analysis(0.15, 0.62), prompt, recentTurns: [], judge });
    assert.equal(r.action, 'execute', prompt);
    assert.equal(r.reason, 'ambiguity_score_low', prompt);
  }
  assert.equal(judgeCalls, 0);
});

test('contract-only analyses behave exactly as before', async () => {
  const high = await triageIntent({ analysis: { contract: { ambiguity_score: 0.85 } }, prompt: 'resume el documento', recentTurns: [] });
  assert.equal(high.action, 'ask');
  const low = await triageIntent({ analysis: { contract: { ambiguity_score: 0.12 } }, prompt: 'qué es python', recentTurns: [] });
  assert.equal(low.action, 'execute');
  const missing = await triageIntent({ analysis: {}, prompt: 'cualquier cosa larga y concreta sobre facturación electrónica en Perú', recentTurns: [] });
  assert.equal(missing.action, 'execute');
});

test('short chit-chat is never escalated', async () => {
  const r = await triageIntent({ analysis: analysis(0.15, 0.85), prompt: 'hola', recentTurns: [] });
  assert.equal(r.action, 'execute');
  assert.equal(r.reason, 'short_chitchat');
});
