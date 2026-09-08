'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { honorPickerModel, remapStaleClaudeId, lookupPickerDisplayName, ANTHROPIC_SONNET_ID } = require('../src/services/ai/honor-picker-model');

test('honorPickerModel keeps Anthropic / xAI ids off Kimi', () => {
  assert.deepEqual(
    honorPickerModel('anthropic/claude-sonnet-5', { provider: 'Kimi' }),
    { model: 'anthropic/claude-sonnet-5', provider: 'Anthropic', honored: true, fromPreferred: false },
  );
  assert.deepEqual(
    honorPickerModel('x-ai/grok-4.5', { provider: 'Kimi' }),
    { model: 'x-ai/grok-4.5', provider: 'xAI', honored: true, fromPreferred: false },
  );
  assert.deepEqual(
    honorPickerModel('gpt-5.6-terra', { provider: 'OpenRouter' }),
    { model: 'gpt-5.6-terra', provider: 'OpenAI', honored: true, fromPreferred: false },
  );
  const kimi = honorPickerModel('moonshotai/kimi-k2.7-code', { provider: 'Kimi' });
  assert.equal(kimi.model, 'moonshotai/kimi-k2.7-code');
  assert.equal(kimi.provider, 'Kimi');
});

test('honorPickerModel does not invent a preferred model when the picker sent one', () => {
  const picked = honorPickerModel('x-ai/grok-4.20', {
    provider: 'xAI',
    preferredModel: 'moonshotai/kimi-k2.7-code',
  });
  assert.equal(picked.model, 'x-ai/grok-4.20');
  assert.equal(picked.provider, 'xAI');
  assert.equal(picked.fromPreferred, false);
});

test('empty picker may use org preferred; never remaps a live pick to Kimi', () => {
  const fallback = honorPickerModel('', { preferredModel: 'anthropic/claude-sonnet-5' });
  assert.equal(fallback.model, 'anthropic/claude-sonnet-5');
  assert.equal(fallback.provider, 'Anthropic');
  assert.equal(fallback.honored, false);
  assert.equal(fallback.fromPreferred, true);

  const empty = honorPickerModel('');
  assert.equal(empty.model, '');
  assert.equal(empty.honored, false);
});

test('lookupPickerDisplayName uses the visible catalog label, not a raw id', () => {
  assert.equal(lookupPickerDisplayName('x-ai/grok-4.20'), 'Grok 4.2');
  assert.equal(lookupPickerDisplayName('anthropic/claude-opus-4.7'), 'Opus 4.7');
});

test('grok-4.5 DB passthrough badges as Grok 4.5, never curated Grok 4.2', () => {
  assert.equal(lookupPickerDisplayName('grok-4.5'), 'Grok 4.5');
  assert.equal(lookupPickerDisplayName('x-ai/grok-4.5'), 'Grok 4.5');
  assert.notEqual(lookupPickerDisplayName('grok-4.5'), 'Grok 4.2');
  assert.doesNotMatch(lookupPickerDisplayName('grok-4.5'), /DeepSeek|OpenRouter|x-ai\//i);
});

test('stale Claude Sonnet 3 labels resolve to current Anthropic Sonnet', () => {
  assert.equal(remapStaleClaudeId('Claude Sonnet 3'), ANTHROPIC_SONNET_ID);
  assert.equal(remapStaleClaudeId('claude-3.5-sonnet'), ANTHROPIC_SONNET_ID);
  const honored = honorPickerModel('Claude Sonnet 3', { provider: 'OpenRouter' });
  assert.equal(honored.model, ANTHROPIC_SONNET_ID);
  assert.equal(honored.provider, 'Anthropic');
});

test('generate route honors the picker before provider resolution', () => {
  const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(aiRoute, /honorPickerModel\(model, \{ provider \}\)/);
  assert.match(aiRoute, /pickerModel/);
  assert.match(aiRoute, /pickerDisplayName/);
  assert.match(aiRoute, /honorPickerModel\(model, \{ provider \}\)/);
  assert.match(aiRoute, /connected: providerConnectionReady\(connectionProvider\)/);
  assert.match(aiRoute, /honoredImagePick = honorPickerModel\(model, \{ provider \}\)/);
  assert.match(aiRoute, /honorPickerModel\(req\.body\.model, \{ provider: req\.body\.provider \}\)/);
});
