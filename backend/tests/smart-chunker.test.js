'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const smartChunker = require('../src/services/rag/smart-chunker');

// The 'code' chunking strategy was dead for a long time: smart-chunker required
// './code-chunker' (nonexistent — the real module is ../code-chunker) and called
// a nonexistent .chunk(); the bare try/catch swallowed both errors so every code
// document silently degraded to generic recursive chunking. These pin the fix.
test('smart-chunker: code strategy returns string chunks (not silently degraded)', async () => {
  const code = 'function foo(){\n  return 1;\n}\n\nfunction bar(){\n  return 2;\n}\n';
  const out = await smartChunker.chunkWithStrategy({ text: code, title: 'sample.ts' }, { strategy: 'code' });
  assert.equal(out.strategy, 'code', 'code strategy is used, not degraded to recursive');
  assert.ok(Array.isArray(out.chunks) && out.chunks.length > 0, 'produces chunks');
  assert.ok(out.chunks.every((c) => typeof c === 'string'), 'chunks honor the string[] contract');
});

test('smart-chunker: code strategy on empty text returns the none strategy', async () => {
  const out = await smartChunker.chunkWithStrategy({ text: '', title: 'x.ts' }, { strategy: 'code' });
  assert.equal(out.strategy, 'none');
  assert.deepEqual(out.chunks, []);
});

// The 4 sandbox document tools were fully disabled by a wrong require path
// ('../sandbox/...' resolved into agent-harness/sandbox/ which doesn't exist),
// throwing MODULE_NOT_FOUND that run-agent-turn swallowed. Pin that it loads.
test('sandbox-doc-tools module loads (require path restored)', () => {
  const m = require('../src/services/agent-harness/tools/sandbox-doc-tools');
  assert.equal(typeof m.buildSandboxDocTools, 'function');
});
