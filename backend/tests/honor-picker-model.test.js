'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  ANTHROPIC_SONNET_ID,
  honorPickerModel,
  publicBadgeLabel,
  resolveClaudeApiId,
} = require('../src/services/ai/honor-picker-model');
const {
  inferProviderFromModelId,
  resolveGenerateProvider,
} = require('../src/services/ai/provider-inference');
const { serializeMessage } = require('../src/utils/bigint-serializer');

const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');

test('picker Claude Sonnet 3 generates on Anthropic Sonnet, not Sira Rápido', () => {
  for (const picked of ['Claude Sonnet 3', 'claude-3-sonnet', 'anthropic/claude-3.5-sonnet']) {
    const honored = honorPickerModel(picked);
    assert.equal(honored.honored, true, `expected honored for "${picked}"`);
    assert.equal(honored.fromPreferred, false);
    assert.equal(honored.model, ANTHROPIC_SONNET_ID, `expected ${ANTHROPIC_SONNET_ID} for "${picked}"`);
    assert.equal(honored.provider, 'Anthropic');
    assert.equal(honored.pickerModel, picked);
    assert.notEqual(honored.publicLabel, 'Sira Rápido');
    assert.doesNotMatch(honored.publicLabel, /deepseek|openrouter|claude-sonnet-4-6/i);
    assert.equal(inferProviderFromModelId(picked), 'Anthropic');
    assert.equal(resolveGenerateProvider('DeepSeek', picked), 'Anthropic');
  }
  const stale = honorPickerModel('Claude Sonnet 3');
  assert.equal(stale.publicLabel, 'Claude Sonnet 3');
});

test('empty picker applies org preferredModel only', () => {
  const empty = honorPickerModel('');
  assert.equal(empty.honored, false);
  assert.equal(empty.fromPreferred, false);
  assert.equal(empty.model, '');
  assert.equal(empty.publicLabel, '');

  const preferred = honorPickerModel('', {
    preferredModel: 'deepseek-v4-flash',
    preferredProvider: 'DeepSeek',
  });
  assert.equal(preferred.honored, false);
  assert.equal(preferred.fromPreferred, true);
  assert.equal(preferred.model, 'deepseek-v4-flash');
  assert.equal(preferred.publicLabel, 'Sira Rápido');
  assert.equal(preferred.pickerModel, '');

  const preferredClaude = honorPickerModel('', { preferredModel: 'Claude Sonnet 3' });
  assert.equal(preferredClaude.fromPreferred, true);
  assert.equal(preferredClaude.honored, false);
  assert.equal(preferredClaude.model, ANTHROPIC_SONNET_ID);
  assert.equal(preferredClaude.provider, 'Anthropic');
  assert.notEqual(preferredClaude.publicLabel, 'Sira Rápido');
});

test('picked model is never overwritten by org preferredModel', () => {
  const honored = honorPickerModel('Claude Sonnet 3', {
    preferredModel: 'deepseek-v4-flash',
    preferredProvider: 'DeepSeek',
  });
  assert.equal(honored.honored, true);
  assert.equal(honored.fromPreferred, false);
  assert.equal(honored.model, ANTHROPIC_SONNET_ID);
  assert.equal(honored.provider, 'Anthropic');
  assert.equal(honored.publicLabel, 'Claude Sonnet 3');
});

test('picking Sira Rápido still shows Sira Rápido', () => {
  const honored = honorPickerModel('deepseek-v4-flash');
  assert.equal(honored.honored, true);
  assert.equal(honored.model, 'deepseek-v4-flash');
  assert.equal(honored.publicLabel, 'Sira Rápido');
  assert.equal(publicBadgeLabel('deepseek-v4-flash'), 'Sira Rápido');
  assert.equal(publicBadgeLabel('Sira Rápido'), 'Sira Rápido');
});

test('publicBadgeLabel never invents Sira Rápido for an empty source', () => {
  assert.equal(publicBadgeLabel(''), '');
  assert.equal(publicBadgeLabel(null), '');
  assert.equal(publicBadgeLabel(undefined), '');
  assert.equal(publicBadgeLabel({}), '');
  assert.doesNotMatch(publicBadgeLabel('Claude Sonnet 3'), /DeepSeek|OpenRouter|Sira Rápido/);
});

test('stale Claude 3 ids resolve to current Anthropic Sonnet', () => {
  assert.equal(resolveClaudeApiId('Claude Sonnet 3'), ANTHROPIC_SONNET_ID);
  assert.equal(resolveClaudeApiId('claude-3-sonnet'), ANTHROPIC_SONNET_ID);
  assert.equal(resolveClaudeApiId('anthropic/claude-3.5-sonnet'), ANTHROPIC_SONNET_ID);
  assert.equal(resolveClaudeApiId('claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('serializeMessage surfaces persisted publicLabel as the badge model', () => {
  const withLabel = serializeMessage({
    id: 'm1',
    tokens: 3n,
    metadata: { publicLabel: 'Claude Sonnet 3', pickerModel: 'Claude Sonnet 3' },
  });
  assert.equal(withLabel.model, 'Claude Sonnet 3');
  assert.notEqual(withLabel.model, 'Sira Rápido');

  const empty = serializeMessage({ id: 'm2', tokens: 1 });
  assert.equal(empty.model, undefined);
});

test('generate honors picker before org preferred and keeps honorUserModel', () => {
  assert.match(aiRoute, /honorPickerModel\(model\)/);
  assert.match(aiRoute, /Honor the \/agentes picker/);
  assert.match(
    aiRoute,
    /if \(!customGpt && !String\(model \|\| ''\)\.trim\(\)\)/,
    'preferredModel may apply only when the client sent no model',
  );
  assert.match(
    aiRoute,
    /const honorUserModel = String\(model \|\| ''\)\.trim\(\)\.length > 0/,
  );
  assert.match(aiRoute, /&& !honorUserModel/);
  assert.match(aiRoute, /publicLabel: req\._pickerHonor\.publicLabel/);
});
