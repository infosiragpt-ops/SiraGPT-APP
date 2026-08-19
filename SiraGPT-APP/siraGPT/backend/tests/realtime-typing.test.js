/**
 * Tests for services/realtime/typing-indicator.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TypingIndicator } = require('../src/services/realtime/typing-indicator');

test('typing: start emits once, stop emits explicit', () => {
  const ti = new TypingIndicator({ ttlMs: 1000 });
  const events = [];
  ti.on('start', (e) => events.push(['start', e.chatId, e.userId]));
  ti.on('stop', (e) => events.push(['stop', e.chatId, e.userId, e.reason]));
  const r1 = ti.start('c1', 'u1');
  const r2 = ti.start('c1', 'u1'); // renewal — should NOT re-emit start
  assert.equal(r1.started, true);
  assert.equal(r2.started, false);
  ti.stop('c1', 'u1');
  assert.deepEqual(events, [['start', 'c1', 'u1'], ['stop', 'c1', 'u1', 'explicit']]);
  ti.dispose();
});

test('typing: auto-stop after ttl with reason=timeout', async () => {
  const ti = new TypingIndicator({ ttlMs: 30 });
  let stopReason = null;
  ti.on('stop', (e) => { stopReason = e.reason; });
  ti.start('c2', 'u2');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stopReason, 'timeout');
  assert.deepEqual(ti.whoIsTyping('c2'), []);
  ti.dispose();
});

test('typing: whoIsTyping returns active users', () => {
  const ti = new TypingIndicator({ ttlMs: 1000 });
  ti.start('chatA', 'u1');
  ti.start('chatA', 'u2');
  ti.start('chatB', 'u3');
  assert.deepEqual(ti.whoIsTyping('chatA').sort(), ['u1', 'u2']);
  assert.deepEqual(ti.whoIsTyping('chatB'), ['u3']);
  assert.deepEqual(ti.whoIsTyping('chatZ'), []);
  ti.dispose();
});

test('typing: validates inputs', () => {
  const ti = new TypingIndicator();
  assert.throws(() => ti.start('', 'u'), /chatId and userId/);
  assert.throws(() => ti.start('c', ''), /chatId and userId/);
  ti.dispose();
});
