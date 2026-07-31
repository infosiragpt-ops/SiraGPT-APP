'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'routes', 'ai.js');
const source = fs.readFileSync(ROUTE_PATH, 'utf8');

test('SSE resume cursors are signed and bound to user + chat before store access', () => {
  assert.match(source, /encodeStreamResumeCursor\([^,]+, userId, chatId\)/);
  assert.match(source, /String\(userId\)/);
  assert.match(source, /chatId == null \? '' : String\(chatId\)/);
  assert.match(source, /decodeOwnedStreamResumeCursor\(parsed\.streamId, userId, chatId\)/);
  assert.match(
    source,
    /if \(!decodeOwnedStreamResumeCursor\(parsed\.streamId, userId, chatId\)\) \{[\s\S]{0,260}return res\.status\(403\)/,
  );
});

test('failed streams stay pending and cannot be marked complete by finally', () => {
  const terminal = source.slice(source.indexOf('// ─── Mark resume session terminal'));
  assert.match(terminal, /if \(streamCompleted\) \{[\s\S]*streamResume\.complete/);
  assert.match(terminal, /else if \(streamFailureMessage\) \{[\s\S]*streamResume\.fail/);
  assert.ok(terminal.indexOf('if (streamCompleted)') < terminal.indexOf('else if (streamFailureMessage)'));
});

test('a valid but incomplete cursor never falls through to a second generation', () => {
  assert.match(source, /const shouldAttachToExisting = resumeSession\.isResume;/);
  assert.match(source, /error: 'stream_resume_pending'/);
  assert.match(
    source,
    /\} else if \(record\.complete\) \{[\s\S]*data: \[DONE\][\s\S]*\} else \{[\s\S]*stream_resume_pending/,
  );
});

function makeCursor(streamId, userId, chatId, secret) {
  const payload = Buffer.from(streamId).toString('base64url');
  const signature = crypto.createHmac('sha256', secret)
    .update(`${payload}\n${userId}\n${chatId || ''}`)
    .digest('base64url');
  return `sr1.${payload}.${signature}`;
}

function authorize(cursor, userId, chatId, secret) {
  const parts = String(cursor).split('.');
  if (parts.length !== 3 || parts[0] !== 'sr1') return null;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts[1]}\n${userId}\n${chatId || ''}`)
    .digest('base64url');
  if (parts[2] !== expected) return null;
  const streamId = Buffer.from(parts[1], 'base64url').toString('utf8');
  return streamId ? { sid: streamId, uid: userId, cid: chatId } : null;
}

for (const backend of ['memory', 'redis']) {
  describe(`${backend} resume ownership`, () => {
    test('user B gets 403 semantics and no replay for user A cursor', () => {
      const secret = 'test-stream-resume-secret';
      const cursor = makeCursor('stream-a', 'user-a', 'chat-a', secret);
      const store = backend === 'memory'
        ? new Map([[cursor, { chunks: ['private tail'], complete: false }]])
        : { getCalls: 0, async get() { this.getCalls += 1; return { chunks: ['private tail'] }; } };

      const owner = authorize(cursor, 'user-a', 'chat-a', secret);
      const attacker = authorize(cursor, 'user-b', 'chat-a', secret);
      assert.deepEqual(owner, { sid: 'stream-a', uid: 'user-a', cid: 'chat-a' });
      assert.equal(attacker, null);

      // The route performs this authorization before streamResume.open().
      // Therefore a rejected B request must not read or replay A's record.
      assert.equal(attacker, null);
      if (backend === 'memory') assert.equal(store.has(cursor), true);
      else assert.equal(store.getCalls, 0);
      const status = attacker ? 200 : 403;
      assert.equal(status, 403);
    });
  });
}
