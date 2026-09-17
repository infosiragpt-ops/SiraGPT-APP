'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const {
  DISLIKE_REASONS,
  mergeRlhfMetadata,
  dpoPairsFromRows,
  exportFromRows,
  preferenceStats,
} = require('../src/services/agents/preference-chat-export');
const { preferenceAgent } = require('../src/services/document-analysis-rlhf');
const {
  hydrateFromRows,
  _reset,
  _dump,
} = require('../src/services/agents/feedback-ledger');

test('dislike reasons are the documented set', () => {
  assert.ok(DISLIKE_REASONS.includes('invented'));
  assert.ok(DISLIKE_REASONS.includes('wrong_file'));
  assert.ok(DISLIKE_REASONS.includes('bad_math'));
  assert.ok(DISLIKE_REASONS.includes('wrong_tone'));
  assert.ok(DISLIKE_REASONS.includes('incomplete'));
  assert.ok(DISLIKE_REASONS.includes('off_topic'));
  assert.ok(DISLIKE_REASONS.includes('other'));
});

test('mergeRlhfMetadata keeps other metadata keys', () => {
  const next = mergeRlhfMetadata({ foo: 1, rlhf: { at: 'old' } }, { reason: 'invented', at: 'new' });
  assert.equal(next.foo, 1);
  assert.equal(next.rlhf.reason, 'invented');
  assert.equal(next.rlhf.at, 'new');
});

test('DPO pairs same request liked vs disliked, not unrelated turns', () => {
  const rows = [
    { runId: 'a', chatId: 'c1', request: 'analiza', response: 'malo', helpful: false, agent: 'document' },
    { runId: 'b', chatId: 'c1', request: 'analiza', response: 'bueno', helpful: true, agent: 'document' },
    { runId: 'c', chatId: 'c1', request: 'hola', response: 'hey', helpful: true, agent: 'chat' },
  ];
  const pairs = dpoPairsFromRows(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].chosen.runId, 'b');
  assert.equal(pairs[0].rejected.runId, 'a');
});

test('KTO export labels unpaired thumbs', () => {
  const out = exportFromRows({
    rows: [
      { runId: '1', request: 'q', response: 'a', helpful: true, agent: 'chat' },
      { runId: '2', request: 'q2', response: 'b', helpful: false, agent: 'chat', reason: 'invented' },
    ],
    format: 'kto',
    scrubPii: false,
  });
  assert.equal(out.count, 2);
  const lines = out.ndjson.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].label, true);
  assert.equal(lines[1].label, false);
  assert.equal(lines[1].reason, 'invented');
});

test('win-rate splits chat vs document', () => {
  const stats = preferenceStats([
    { helpful: true, agent: 'document' },
    { helpful: false, agent: 'document' },
    { helpful: true, agent: 'chat' },
  ]);
  assert.equal(stats.document.liked, 1);
  assert.equal(stats.document.disliked, 1);
  assert.equal(stats.document.winRate, 0.5);
  assert.equal(stats.chat.winRate, 1);
  assert.equal(stats.all.total, 3);
});

test('hydrateFromRows re-embeds when an embedder is provided', async () => {
  _reset();
  await hydrateFromRows('u1', [{
    runId: 'm1',
    agent: 'document',
    request: 'resume',
    response: 'ok',
    helpful: true,
  }], async (texts) => texts.map(() => new Float32Array([1, 0])));
  const dumped = _dump('u1');
  assert.ok(dumped[0].embedding);
  assert.equal(dumped[0].embedding.length, 2);
});

test('gold set is 20 document analysis prompts', () => {
  const gold = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'document-rlhf-gold.json'),
    'utf8',
  ));
  assert.equal(gold.length, 20);
  for (const item of gold) {
    assert.equal(preferenceAgent({ prompt: item.prompt, files: [item.file] }), item.expectAgent);
  }
});
