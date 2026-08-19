'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ml-models');
const { extractMlModels, buildMlModelsForFiles, renderMlModelsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractMlModels('').total, 0);
  assert.equal(extractMlModels(null).total, 0);
});

test('detects gpt-4o', () => {
  const r = extractMlModels('Set model to gpt-4o for chat.');
  assert.ok(r.entries.some((e) => e.id === 'gpt-4o' && e.provider === 'openai'));
});

test('detects gpt-4o-mini', () => {
  const r = extractMlModels('Use gpt-4o-mini for cheap calls.');
  assert.ok(r.entries.some((e) => e.id === 'gpt-4o-mini'));
});

test('detects o1 reasoning model', () => {
  const r = extractMlModels('Switch to o1 for reasoning tasks.');
  assert.ok(r.entries.some((e) => e.kind === 'reasoning'));
});

test('detects claude-3-5-sonnet', () => {
  const r = extractMlModels("model: 'claude-3-5-sonnet-20241022'");
  assert.ok(r.entries.some((e) => /claude-3-5-sonnet/.test(e.id) && e.provider === 'anthropic'));
});

test('detects claude-opus-4-7', () => {
  const r = extractMlModels('powered by claude-opus-4-7');
  assert.ok(r.entries.some((e) => /claude-opus-4/.test(e.id) && e.provider === 'anthropic'));
});

test('detects gemini-2.5-pro', () => {
  const r = extractMlModels('Using gemini-2.5-pro for vision');
  assert.ok(r.entries.some((e) => /gemini-2\.5-pro/.test(e.id) && e.provider === 'google'));
});

test('detects llama-3.1-405b', () => {
  const r = extractMlModels('Loaded llama-3.1-405b weights');
  assert.ok(r.entries.some((e) => /llama/.test(e.id) && e.provider === 'meta'));
});

test('detects mixtral-8x22b', () => {
  const r = extractMlModels('Server runs mixtral-8x22b');
  assert.ok(r.entries.some((e) => /mixtral/.test(e.id) && e.provider === 'mistral'));
});

test('detects deepseek-v3', () => {
  const r = extractMlModels('Switched to deepseek-v3');
  assert.ok(r.entries.some((e) => /deepseek-v3/.test(e.id)));
});

test('detects text-embedding-3-large', () => {
  const r = extractMlModels('embedder: text-embedding-3-large');
  assert.ok(r.entries.some((e) => e.kind === 'embedding'));
});

test('dedupes identical model ids', () => {
  const r = extractMlModels('gpt-4o here. gpt-4o again.');
  assert.equal(r.entries.filter((e) => e.id === 'gpt-4o').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  text += 'gpt-4o gpt-4o-mini gpt-4-turbo gpt-3.5-turbo o1 o1-mini o3 o3-mini ';
  text += 'claude-3-opus claude-3-5-sonnet claude-3-7-sonnet claude-opus-4-7 ';
  text += 'gemini-pro gemini-2.5-pro mistral-large mixtral-8x7b mixtral-8x22b ';
  text += 'codestral deepseek-v3 deepseek-r1 qwen-2.5 voyage-3 cohere-embed-v3 ';
  const r = extractMlModels(text);
  assert.ok(r.entries.length <= 20);
});

test('counts totals by provider/kind', () => {
  const r = extractMlModels('gpt-4o and claude-opus-4-7 and gemini-2.5-pro');
  const keys = Object.keys(r.totals);
  assert.ok(keys.length >= 3);
});

test('buildMlModelsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'gpt-4o' },
    { name: 'b.md', extractedText: 'claude-opus-4-7' },
  ];
  const r = buildMlModelsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMlModelsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'gpt-4o and claude-opus-4-7' }];
  const r = buildMlModelsForFiles(files);
  const md = renderMlModelsBlock(r);
  assert.match(md, /^## AI \/ ML MODELS/);
});

test('renderMlModelsBlock empty when nothing surfaces', () => {
  assert.equal(renderMlModelsBlock({ perFile: [] }), '');
  assert.equal(renderMlModelsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMlModelsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'gpt-4o' },
  ]);
  assert.equal(r.perFile.length, 1);
});
