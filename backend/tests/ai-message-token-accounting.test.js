'use strict';

/**
 * Regression guard — the assistant Message row must store the REAL token count.
 *
 * saveChatAndTrackUsage() receives a `tokens` param that callers compute as a
 * char-length approximation (`fullResponseContent.length + prompt.length`).
 * The function ALSO computes the correct tiktoken count (`totalTokens` via
 * usageService.calculateTextTokens over the saved content) and uses it for
 * ApiUsage.recordUsage — but the assistant Message row used to persist the
 * char-length `tokens` param instead, so Message.tokens disagreed with
 * ApiUsage.tokens and corrupted per-message analytics/billing.
 *
 * Like ai-generate-chat-idor-guard.test.js, we assert on the source (the route
 * is ~10k lines and pulls in Prisma + dozens of services) so the wiring can't
 * silently regress.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');

test('totalTokens is the tiktoken count of the saved content', () => {
  assert.match(src, /responseTokens\s*=\s*usageService\.calculateTextTokens\(/);
  assert.match(src, /const totalTokens\s*=\s*promptTokens\s*\+\s*responseTokens;/);
});

test('the assistant Message row stores tokens: totalTokens (not the char-length param)', () => {
  // Match the assistant message.create data block and require the real count.
  assert.match(
    src,
    /role:\s*'ASSISTANT',[\s\S]{0,500}?tokens:\s*totalTokens,/,
    'assistant Message.tokens must be totalTokens, not the bare char-length `tokens` param',
  );
  // And it must NOT have regressed to the bare shorthand inside that block.
  const block = src.match(/role:\s*'ASSISTANT',[\s\S]{0,500}?files:/);
  assert.ok(block, 'found the assistant message.create block');
  assert.ok(!/\n\s*tokens,\n/.test(block[0]), 'must not store the bare char-length `tokens` shorthand');
});
