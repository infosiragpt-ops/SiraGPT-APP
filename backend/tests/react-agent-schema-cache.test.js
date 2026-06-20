'use strict';

// Unit tests for the bounded LRU compiled-schema validator cache in
// react-agent.js. Each distinct tool `parameters` schema compiles an Ajv
// validator that used to be cached forever (a module-scope Map with no
// eviction). Custom GPT Actions each carry a unique schema, so the cache could
// grow without bound across turns. These tests pin the bound + LRU behaviour.
//
// The cache is module-scope, so node --test's fresh process starts it empty.

const test = require('node:test');
const assert = require('node:assert/strict');

const ra = require('../src/services/react-agent');
const MAX = ra.SCHEMA_VALIDATOR_CACHE_MAX;

function toolWith(i) {
  return {
    name: `tool_${i}`,
    parameters: {
      type: 'object',
      properties: { [`p_${i}`]: { type: 'string' } },
      additionalProperties: false,
    },
  };
}

test('schema validator cache is bounded to SCHEMA_VALIDATOR_CACHE_MAX', () => {
  assert.ok(MAX >= 64, 'cap is a sane lower bound');
  for (let i = 0; i < MAX + 100; i++) {
    ra.validatorForTool(toolWith(i));
  }
  assert.ok(
    ra._schemaValidatorCacheSize() <= MAX,
    `cache size ${ra._schemaValidatorCacheSize()} must stay <= ${MAX}`,
  );
});

test('LRU: a repeatedly-accessed schema is not evicted (same cached validator)', () => {
  const hot = toolWith(10_000_000);
  const v1 = ra.validatorForTool(hot); // compile + insert
  // Churn enough new schemas to overflow the cache several times over, but
  // re-touch `hot` each round so it stays most-recently-used.
  for (let i = 0; i < MAX * 2; i++) {
    ra.validatorForTool(toolWith(20_000_000 + i));
    ra.validatorForTool(hot);
  }
  const v2 = ra.validatorForTool(hot);
  assert.equal(v1, v2, 'hot schema kept its cached validator (not recompiled)');
  assert.ok(ra._schemaValidatorCacheSize() <= MAX);
});

test('validatorForTool returns null for a tool without an object schema', () => {
  assert.equal(ra.validatorForTool({ name: 'x' }), null);
  assert.equal(ra.validatorForTool({ name: 'x', parameters: 'nope' }), null);
});
