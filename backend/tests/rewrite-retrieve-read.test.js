/**
 * Tests for the rewrite-retrieve-read modular pattern.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const rrr = require('../src/services/rag/rewrite-retrieve-read');

function scripted(seq) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      return { choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }] };
    }}},
  };
}

// ─── rewrite ─────────────────────────────────────────────────────────────

test('rewrite: returns rewritten query + changed flag', async () => {
  const openai = scripted([JSON.stringify({
    rewritten: 'throughput limit of the write-ahead log',
    reason: 'specific nouns, filler removed',
    changed: true,
  })]);
  const r = await rrr.rewrite({ openai, query: 'could you maybe tell me about that throughput thing with the WAL' });
  assert.equal(r.changed, true);
  assert.match(r.rewritten, /throughput limit/);
  assert.match(r.reason, /specific/);
});

test('rewrite: LLM says changed=false with same query → changed=false', async () => {
  const openai = scripted([JSON.stringify({
    rewritten: 'tax invoice workflow',
    reason: 'already retrieval-ready',
    changed: false,
  })]);
  const r = await rrr.rewrite({ openai, query: 'tax invoice workflow' });
  assert.equal(r.changed, false);
});

test('rewrite: LLM error → falls back to original', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('down'); } } },
  };
  const r = await rrr.rewrite({ openai, query: 'original query' });
  assert.equal(r.rewritten, 'original query');
  assert.equal(r.changed, false);
  assert.match(r.reason, /error/);
});

test('rewrite: null openai → returns original as-is', async () => {
  const r = await rrr.rewrite({ openai: null, query: 'q' });
  assert.equal(r.rewritten, 'q');
  assert.equal(r.changed, false);
});

test('rewrite: history is passed to the LLM when provided', async () => {
  const openai = scripted([JSON.stringify({
    rewritten: 'When was the Eiffel Tower built?',
    reason: 'resolved "it" to Eiffel Tower from history',
    changed: true,
  })]);
  await rrr.rewrite({
    openai,
    query: 'when was it built?',
    history: 'user: tell me about the Eiffel Tower\nassistant: it was designed by Gustave Eiffel.',
  });
  const userMsg = openai.calls[0].messages.find(m => m.role === 'user').content;
  assert.match(userMsg, /CONVERSATION HISTORY/);
  assert.match(userMsg, /Eiffel Tower/);
});

// ─── read ────────────────────────────────────────────────────────────────

test('read: produces answer + cited indices', async () => {
  const openai = scripted([JSON.stringify({
    answer: 'The Eiffel Tower was completed in 1889.',
    cited: [1],
  })]);
  const r = await rrr.read({
    openai,
    query: 'when was the Eiffel Tower built?',
    passages: [
      { source: 'p1', text: 'The Eiffel Tower was completed in 1889.' },
      { source: 'p2', text: 'Unrelated passage.' },
    ],
  });
  assert.match(r.answer, /1889/);
  assert.deepEqual(r.cited, [1]);
});

test('read: filters out-of-range citations', async () => {
  const openai = scripted([JSON.stringify({
    answer: 'answer',
    cited: [1, 99, 'abc'],
  })]);
  const r = await rrr.read({
    openai,
    query: 'q',
    passages: [{ source: 'p1', text: 't' }],
  });
  assert.deepEqual(r.cited, [1]);
});

test('read: empty passages → abstains without LLM call', async () => {
  const openai = scripted([]);  // should never be called
  const r = await rrr.read({ openai, query: 'q', passages: [] });
  assert.match(r.answer, /don'?t know/i);
  assert.deepEqual(r.cited, []);
});

test('read: null openai → error with empty answer', async () => {
  const r = await rrr.read({ openai: null, query: 'q', passages: [{ source: 'p', text: 't' }] });
  assert.equal(r.answer, '');
  assert.match(r.error, /no LLM/);
});

// ─── run (full pipeline) ─────────────────────────────────────────────────

test('run: full pipeline — rewrite → retrieve → read → citations', async () => {
  const openai = scripted([
    // Rewriter
    JSON.stringify({ rewritten: 'eiffel tower completion year', reason: 'concrete nouns', changed: true }),
    // Reader
    JSON.stringify({ answer: '1889', cited: [1] }),
  ]);
  const retrievalQueries = [];
  const retrieve = async (q, k) => {
    retrievalQueries.push(q);
    return [{ source: 'docA', text: 'The Eiffel Tower was completed in 1889.' }];
  };
  const r = await rrr.run({ openai, query: 'when was it built?', retrieve });
  assert.equal(r.original, 'when was it built?');
  assert.equal(r.rewritten, 'eiffel tower completion year');
  assert.equal(r.changed, true);
  assert.equal(r.answer, '1889');
  assert.deepEqual(r.cited, [1]);
  assert.deepEqual(r.citedSources, ['docA']);
  assert.equal(retrievalQueries[0], 'eiffel tower completion year',
    'retriever should receive the rewritten query');
});

test('run: missing retrieve fn rejected', async () => {
  await assert.rejects(
    rrr.run({ openai: scripted([]), query: 'q' }),
    /retrieve\(fn\) required/,
  );
});
