'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCodexV2Enabled } = require('../src/services/codex/flags');

test('disabled by default (empty env)', () => {
  assert.equal(isCodexV2Enabled({}), false);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: '' }), false);
});

test('enabled with 1 / true / on (case-insensitive, trimmed)', () => {
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: '1' }), true);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: 'true' }), true);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: ' ON ' }), true);
});

test('disabled with 0 / false / garbage', () => {
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: '0' }), false);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: 'false' }), false);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: 'yes please' }), false);
});
