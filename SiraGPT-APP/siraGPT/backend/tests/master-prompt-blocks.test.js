'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildSystemPrompt } = require('../src/services/master-prompt');

test('buildSystemPrompt returns systemBlocks array alongside flat string', () => {
  const out = buildSystemPrompt({
    language: 'es',
    userMessage: 'hola',
    userProfile: { name: 'Luis', locale: 'es-MX' },
  });
  assert.strictEqual(typeof out.system, 'string');
  assert.ok(out.system.length > 0);
  assert.ok(Array.isArray(out.systemBlocks));
  assert.ok(out.systemBlocks.length > 0);
});

test('buildSystemPrompt: blocks have kind/text/cacheable shape', () => {
  const out = buildSystemPrompt({ language: 'es', userMessage: 'test' });
  for (const block of out.systemBlocks) {
    assert.strictEqual(typeof block.kind, 'string', `block missing kind: ${JSON.stringify(block)}`);
    assert.strictEqual(typeof block.text, 'string', `block missing text: ${JSON.stringify(block)}`);
    assert.strictEqual(typeof block.cacheable, 'boolean', `block missing cacheable: ${JSON.stringify(block)}`);
    assert.ok(block.text.trim().length > 0, `block has empty text: ${JSON.stringify(block)}`);
  }
});

test('buildSystemPrompt: at least the rules block is cacheable', () => {
  const out = buildSystemPrompt({ language: 'es', userMessage: 'test' });
  const cacheable = out.systemBlocks.filter((b) => b.cacheable);
  assert.ok(cacheable.length >= 1, 'no cacheable blocks produced');
  assert.ok(out.systemBlocks.some((b) => b.kind === 'rules' && b.cacheable), 'rules block must be cacheable');
});

test('buildSystemPrompt: header block precedes rules block', () => {
  const out = buildSystemPrompt({ language: 'es', userMessage: 'test' });
  const headerIdx = out.systemBlocks.findIndex((b) => b.kind === 'header');
  const rulesIdx = out.systemBlocks.findIndex((b) => b.kind === 'rules');
  assert.ok(headerIdx !== -1, 'missing header block');
  assert.ok(rulesIdx !== -1, 'missing rules block');
  assert.ok(headerIdx < rulesIdx, 'header must come before rules');
});

test('buildSystemPrompt: dynamic intent-alignment block is NOT cacheable', () => {
  const out = buildSystemPrompt({ language: 'es', userMessage: 'analiza este archivo' });
  const intent = out.systemBlocks.find((b) => b.kind === 'intent-alignment');
  if (intent) assert.strictEqual(intent.cacheable, false);
});

test('buildSystemPrompt: formatting contract is the trailing non-cacheable block', () => {
  const out = buildSystemPrompt({ language: 'es', userMessage: 'test' });
  const last = out.systemBlocks[out.systemBlocks.length - 1];
  assert.strictEqual(last.kind, 'formatting-contract');
  assert.strictEqual(last.cacheable, false);
});

test('buildSystemPrompt: flat system string contains concatenated block content', () => {
  const out = buildSystemPrompt({
    language: 'es',
    userMessage: 'hola',
    userProfile: { name: 'Luis', preferredTone: 'profesional' },
  });
  for (const block of out.systemBlocks) {
    const trimmedSnippet = block.text.trim().slice(0, 40);
    if (trimmedSnippet.length > 0) {
      assert.ok(
        out.system.includes(trimmedSnippet),
        `flat system missing block "${block.kind}" snippet: "${trimmedSnippet}"`,
      );
    }
  }
});

test('buildSystemPrompt: with project, project block is present and cacheable', () => {
  const out = buildSystemPrompt({
    language: 'es',
    userMessage: 'test',
    project: { name: 'MyProj', description: 'A goal', instructions: 'Do X', files: [] },
  });
  const proj = out.systemBlocks.find((b) => b.kind === 'project');
  assert.ok(proj, 'project block missing');
  assert.strictEqual(proj.cacheable, true);
  assert.ok(proj.text.includes('MyProj'));
});

test('buildSystemPrompt: extra blocks are appended as non-cacheable', () => {
  const out = buildSystemPrompt({
    language: 'es',
    userMessage: 'test',
    extraBlocks: ['## EXTRA-A\nfoo', '## EXTRA-B\nbar'],
  });
  const extras = out.systemBlocks.filter((b) => b.kind === 'extra-block');
  assert.strictEqual(extras.length, 2);
  for (const e of extras) assert.strictEqual(e.cacheable, false);
});
