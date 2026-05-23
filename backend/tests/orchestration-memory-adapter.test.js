'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryAdapter } = require('../src/orchestration/memory-adapter');

test('memory adapter recall is a function', () => {
  const adapter = createMemoryAdapter();
  assert.equal(typeof adapter.recall, 'function');
  assert.equal(typeof adapter.clear, 'function');
  assert.equal(typeof adapter.stats, 'function');
});

test('memory adapter capabilities report pgvector and mem0 compatibility', () => {
  const adapter = createMemoryAdapter();
  const caps = adapter.capabilities();
  assert.equal(caps.mem0Compatible, true);
  assert.equal(caps.semantic, true);
  assert.equal(caps.episodic, true);
  assert.equal(typeof caps.pgvector, 'boolean');
});
