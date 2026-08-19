/**
 * Tests for the Anthropic Contextual Retrieval helper.
 *
 * No real API calls — every test injects a fake Anthropic SDK with
 * `messages.create()`. Coverage:
 *   - System block is built with the document inside <document> tags
 *     and tagged with cache_control: ephemeral
 *   - Each chunk gets a separate API call with the same cached system
 *   - Failures on one chunk don't stop the rest; surface in failures[]
 *   - Document is truncated when it exceeds maxDocChars
 *   - Empty/invalid chunks are filtered out
 *   - Usage tokens accumulate across calls (incl. cache_read tokens)
 *   - Context is clamped at maxContextChars; index-ready string format
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ctx = require('../src/services/rag/contextual-chunking');

function fakeAnthropic({ contextFn, throwsAt = null } = {}) {
  const calls = [];
  const client = {
    messages: {
      create: async (req) => {
        calls.push(req);
        if (throwsAt !== null && calls.length === throwsAt + 1) {
          throw new Error('upstream 429');
        }
        const userText = req.messages?.[0]?.content || '';
        const ctxText = typeof contextFn === 'function' ? contextFn(userText, calls.length - 1) : `context for call ${calls.length}`;
        return {
          content: [{ type: 'text', text: ctxText }],
          usage: {
            input_tokens: 100,
            output_tokens: 30,
            cache_read_input_tokens: calls.length === 1 ? 0 : 1000,
            cache_creation_input_tokens: calls.length === 1 ? 1000 : 0,
          },
        };
      },
    },
  };
  client.__calls = calls;
  return client;
}

// ── happy path ────────────────────────────────────────────────────────────

test('contextualizeChunks returns one record per chunk with context prepended', async () => {
  const anthropic = fakeAnthropic({
    contextFn: (_user, idx) => `Section ${idx}: belongs to chapter X.`,
  });
  const out = await ctx.contextualizeChunks({
    document: 'A long document body about clima en CDMX...'.repeat(20),
    chunks: ['chunk one body', 'chunk two body', 'chunk three body'],
    anthropic,
  });
  assert.equal(out.contextualizedChunks.length, 3);
  assert.equal(out.contextualizedChunks[0].original, 'chunk one body');
  assert.equal(out.contextualizedChunks[0].context, 'Section 0: belongs to chapter X.');
  assert.equal(out.contextualizedChunks[0].contextualized, 'Section 0: belongs to chapter X.\n\nchunk one body');
  assert.deepEqual(out.contextualized, [
    'Section 0: belongs to chapter X.\n\nchunk one body',
    'Section 1: belongs to chapter X.\n\nchunk two body',
    'Section 2: belongs to chapter X.\n\nchunk three body',
  ]);
  assert.equal(out.failures.length, 0);
  assert.equal(anthropic.__calls.length, 3);
});

test('contextualizeChunks accepts {id, text} objects and preserves the id', async () => {
  const anthropic = fakeAnthropic();
  const out = await ctx.contextualizeChunks({
    document: 'doc body',
    chunks: [{ id: 'chunk-A', text: 'first' }, { id: 'chunk-B', text: 'second' }],
    anthropic,
  });
  assert.deepEqual(out.contextualizedChunks.map((c) => c.id), ['chunk-A', 'chunk-B']);
});

test('contextualizeChunks tags the system block with cache_control ephemeral', async () => {
  const anthropic = fakeAnthropic();
  await ctx.contextualizeChunks({
    document: 'body',
    chunks: ['only one chunk'],
    anthropic,
  });
  const sys = anthropic.__calls[0].system;
  assert.equal(Array.isArray(sys), true);
  assert.equal(sys[0].type, 'text');
  assert.equal(sys[0].cache_control.type, 'ephemeral');
  assert.match(sys[0].text, /<document>[\s\S]*body[\s\S]*<\/document>/);
});

test('contextualizeChunks truncates the document at maxDocChars and notes the truncation', async () => {
  const anthropic = fakeAnthropic();
  const long = 'X'.repeat(500);
  await ctx.contextualizeChunks({
    document: long,
    chunks: ['c'],
    anthropic,
    options: { maxDocChars: 100 },
  });
  const sys = anthropic.__calls[0].system[0].text;
  assert.match(sys, /document truncated/);
  // Content beyond the cap must not leak into the system block.
  assert.ok(sys.length < long.length + 200);
});

// ── failure isolation ────────────────────────────────────────────────────

test('contextualizeChunks isolates per-chunk failures and falls back to the original text', async () => {
  const anthropic = fakeAnthropic({ throwsAt: 1 }); // second chunk throws
  const out = await ctx.contextualizeChunks({
    document: 'body',
    chunks: ['first', 'second', 'third'],
    anthropic,
    options: { concurrency: 1 }, // serialize so throwsAt is deterministic
  });
  assert.equal(out.contextualizedChunks.length, 3);
  assert.equal(out.contextualizedChunks[1].context, '', 'failed chunk has no context');
  assert.equal(out.contextualizedChunks[1].contextualized, 'second', 'falls back to original text');
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].index, 1);
});

// ── input validation ─────────────────────────────────────────────────────

test('contextualizeChunks throws contextual_no_client without an SDK client', async () => {
  await assert.rejects(
    () => ctx.contextualizeChunks({ document: 'd', chunks: ['c'] }),
    (err) => err.code === 'contextual_no_client',
  );
});

test('contextualizeChunks throws contextual_empty_document on blank document', async () => {
  const anthropic = fakeAnthropic();
  await assert.rejects(
    () => ctx.contextualizeChunks({ document: '   ', chunks: ['c'], anthropic }),
    (err) => err.code === 'contextual_empty_document',
  );
});

test('contextualizeChunks returns empty result when no usable chunks are provided', async () => {
  const anthropic = fakeAnthropic();
  const out = await ctx.contextualizeChunks({
    document: 'body',
    chunks: [null, 123, '   ', { foo: 'bar' }],
    anthropic,
  });
  assert.equal(out.contextualizedChunks.length, 0);
  assert.equal(out.contextualized.length, 0);
  assert.equal(anthropic.__calls.length, 0);
});

// ── usage accumulation ───────────────────────────────────────────────────

test('contextualizeChunks accumulates token usage across chunks', async () => {
  const anthropic = fakeAnthropic();
  const out = await ctx.contextualizeChunks({
    document: 'body',
    chunks: ['a', 'b', 'c'],
    anthropic,
    options: { concurrency: 1 },
  });
  assert.equal(out.usage.input_tokens, 300);
  assert.equal(out.usage.output_tokens, 90);
  // First call: cache_creation only. Subsequent: cache_read only.
  assert.equal(out.usage.cache_creation_input_tokens, 1000);
  assert.equal(out.usage.cache_read_input_tokens, 2000);
});

// ── clamping + helpers ───────────────────────────────────────────────────

test('clampContext collapses whitespace and truncates with ellipsis', () => {
  const clamped = ctx.clampContext('  this   has\nspaces  and  is  far  too  long  ', 10);
  assert.equal(clamped.endsWith('…'), true);
  assert.ok(clamped.length <= 10);
});

test('formatChunkForRetrieval prefers contextualized; falls back to context+original then original', () => {
  assert.equal(ctx.formatChunkForRetrieval({ contextualized: 'a' }), 'a');
  assert.equal(ctx.formatChunkForRetrieval({ context: 'c', original: 'o' }), 'c\n\no');
  assert.equal(ctx.formatChunkForRetrieval({ original: 'o' }), 'o');
  assert.equal(ctx.formatChunkForRetrieval(null), '');
});

test('normalizeChunks accepts mixed strings + objects, drops invalid entries', () => {
  const out = ctx.normalizeChunks([
    'plain string',
    { id: 'x', text: 'with id' },
    { text: 'no id' },
    { not: 'a chunk' },
    null,
    '   ',
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[1].id, 'x');
  assert.equal(out[2].id, '2');
});
