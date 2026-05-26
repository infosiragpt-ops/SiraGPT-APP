'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  shouldUseAnthropicCache,
  buildSystemContentBlocks,
  formatSystemMessageWithCache,
  applyAnthropicCacheToMessages,
  countCacheBreakpoints,
  ANTHROPIC_CACHE_BREAKPOINT_LIMIT,
} = require('../src/services/anthropic-cache-formatter');

test('shouldUseAnthropicCache: anthropic provider always wins', () => {
  assert.strictEqual(shouldUseAnthropicCache('anthropic', 'claude-3-5-sonnet'), true);
  assert.strictEqual(shouldUseAnthropicCache('ANTHROPIC', 'claude-opus-4-7'), true);
});

test('shouldUseAnthropicCache: openrouter + claude model matches', () => {
  assert.strictEqual(shouldUseAnthropicCache('openrouter', 'anthropic/claude-3-5-sonnet'), true);
  assert.strictEqual(shouldUseAnthropicCache('openrouter', 'claude-3-5-haiku'), true);
});

test('shouldUseAnthropicCache: openrouter + non-claude model returns false', () => {
  assert.strictEqual(shouldUseAnthropicCache('openrouter', 'openai/gpt-oss-120b'), false);
  assert.strictEqual(shouldUseAnthropicCache('openrouter', 'moonshotai/kimi-k2'), false);
});

test('shouldUseAnthropicCache: openai/google/deepseek never use anthropic cache', () => {
  assert.strictEqual(shouldUseAnthropicCache('openai', 'gpt-4o'), false);
  assert.strictEqual(shouldUseAnthropicCache('google', 'gemini-2.5-flash'), false);
  assert.strictEqual(shouldUseAnthropicCache('deepseek', 'deepseek-v4-pro'), false);
});

test('shouldUseAnthropicCache: missing provider infers from model name', () => {
  assert.strictEqual(shouldUseAnthropicCache(null, 'claude-3-5-sonnet-20240620'), true);
  assert.strictEqual(shouldUseAnthropicCache(undefined, 'anthropic/claude-haiku'), true);
  assert.strictEqual(shouldUseAnthropicCache('', 'gpt-4o'), false);
});

test('shouldUseAnthropicCache: empty model returns false even with anthropic provider', () => {
  assert.strictEqual(shouldUseAnthropicCache('anthropic', ''), false);
  assert.strictEqual(shouldUseAnthropicCache('anthropic', null), false);
});

test('buildSystemContentBlocks: skips empty blocks', () => {
  const out = buildSystemContentBlocks([
    { kind: 'rules', text: 'A', cacheable: true },
    { kind: 'empty', text: '', cacheable: false },
    null,
    { kind: 'user', text: 'B', cacheable: false },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].text, 'A');
  assert.strictEqual(out[1].text, 'B');
});

test('buildSystemContentBlocks: places cache_control on last block of cacheable run', () => {
  const out = buildSystemContentBlocks([
    { kind: 'rules', text: 'rules-text', cacheable: true },
    { kind: 'persona', text: 'persona-text', cacheable: true },
    { kind: 'user', text: 'user-profile', cacheable: true },
    { kind: 'dynamic', text: 'dynamic-evidence', cacheable: false },
  ]);
  assert.strictEqual(out.length, 4);
  // Single contiguous cacheable run → exactly one breakpoint at the end of the run (index 2).
  assert.deepStrictEqual(out[0], { type: 'text', text: 'rules-text' });
  assert.deepStrictEqual(out[1], { type: 'text', text: 'persona-text' });
  assert.deepStrictEqual(out[2], { type: 'text', text: 'user-profile', cache_control: { type: 'ephemeral' } });
  assert.deepStrictEqual(out[3], { type: 'text', text: 'dynamic-evidence' });
});

test('buildSystemContentBlocks: marks end of each cacheable run separately', () => {
  const out = buildSystemContentBlocks([
    { text: 'A', cacheable: true },
    { text: 'B', cacheable: true },
    { text: 'C', cacheable: false },
    { text: 'D', cacheable: true },
    { text: 'E', cacheable: false },
  ]);
  const breakpoints = out.filter((b) => b.cache_control).map((b) => b.text);
  assert.deepStrictEqual(breakpoints, ['B', 'D']);
});

test('buildSystemContentBlocks: clamps to ANTHROPIC_CACHE_BREAKPOINT_LIMIT', () => {
  const blocks = [];
  for (let i = 0; i < 10; i += 1) {
    blocks.push({ text: `c${i}`, cacheable: true });
    blocks.push({ text: `n${i}`, cacheable: false });
  }
  const out = buildSystemContentBlocks(blocks);
  const breakpointCount = out.filter((b) => b.cache_control).length;
  assert.strictEqual(breakpointCount, ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
});

test('buildSystemContentBlocks: no cacheable blocks → no cache_control markers', () => {
  const out = buildSystemContentBlocks([
    { text: 'X', cacheable: false },
    { text: 'Y', cacheable: false },
  ]);
  assert.strictEqual(out.filter((b) => b.cache_control).length, 0);
});

test('buildSystemContentBlocks: accepts plain strings as non-cacheable', () => {
  const out = buildSystemContentBlocks(['hello world']);
  assert.deepStrictEqual(out, [{ type: 'text', text: 'hello world' }]);
});

test('formatSystemMessageWithCache: produces a valid system message', () => {
  const msg = formatSystemMessageWithCache([
    { text: 'rules', cacheable: true },
    { text: 'dynamic', cacheable: false },
  ]);
  assert.strictEqual(msg.role, 'system');
  assert.ok(Array.isArray(msg.content));
  assert.strictEqual(msg.content.length, 2);
  assert.deepStrictEqual(msg.content[0].cache_control, { type: 'ephemeral' });
});

test('applyAnthropicCacheToMessages: no-op on non-anthropic providers', () => {
  const original = [
    { role: 'system', content: 'plain system' },
    { role: 'user', content: 'hi' },
  ];
  const result = applyAnthropicCacheToMessages(original, [
    { text: 'rules', cacheable: true },
  ], { provider: 'openai', model: 'gpt-4o' });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.breakpoints, 0);
  assert.strictEqual(result.messages, original);
});

test('applyAnthropicCacheToMessages: rewrites system message for anthropic provider', () => {
  const original = [
    { role: 'system', content: 'plain' },
    { role: 'user', content: 'hi' },
  ];
  const result = applyAnthropicCacheToMessages(original, [
    { text: 'rules', cacheable: true },
    { text: 'persona', cacheable: true },
    { text: 'dynamic', cacheable: false },
  ], { provider: 'anthropic', model: 'claude-opus-4-7' });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.breakpoints, 1);
  assert.notStrictEqual(result.messages, original);
  assert.strictEqual(result.messages[0].role, 'system');
  assert.ok(Array.isArray(result.messages[0].content));
  // Ensures we did not mutate the user turn.
  assert.deepStrictEqual(result.messages[1], { role: 'user', content: 'hi' });
});

test('applyAnthropicCacheToMessages: skips when no system message is present', () => {
  const original = [
    { role: 'user', content: 'hi' },
  ];
  const result = applyAnthropicCacheToMessages(original, [
    { text: 'rules', cacheable: true },
  ], { provider: 'anthropic', model: 'claude-opus-4-7' });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.messages, original);
});

test('applyAnthropicCacheToMessages: skips when blocks are empty', () => {
  const original = [
    { role: 'system', content: 'plain' },
    { role: 'user', content: 'hi' },
  ];
  const result = applyAnthropicCacheToMessages(original, [], {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.messages, original);
});

test('countCacheBreakpoints: counts ephemeral markers correctly', () => {
  const msg = {
    role: 'system',
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'd' },
    ],
  };
  assert.strictEqual(countCacheBreakpoints(msg), 2);
});

test('countCacheBreakpoints: tolerates string content', () => {
  const msg = { role: 'system', content: 'flat string' };
  assert.strictEqual(countCacheBreakpoints(msg), 0);
});
