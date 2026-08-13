'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STOPPED_BY_USER_MARKER,
  resolveAbortedAssistantContent,
} = require('../src/services/chat-abort-persistence');

test('resolveAbortedAssistantContent keeps partial model text', () => {
  assert.equal(
    resolveAbortedAssistantContent('  Primer párrafo de la respuesta.  '),
    'Primer párrafo de la respuesta.',
  );
});

test('resolveAbortedAssistantContent persists a stop marker when the stream is empty', () => {
  assert.equal(resolveAbortedAssistantContent(''), STOPPED_BY_USER_MARKER);
  assert.equal(resolveAbortedAssistantContent('   '), STOPPED_BY_USER_MARKER);
  assert.equal(resolveAbortedAssistantContent(null), STOPPED_BY_USER_MARKER);
});

test('generate route persists aborted turns without a 40-character floor', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(source, /resolveAbortedAssistantContent\(fullResponseContent\)/);
  assert.match(source, /if \(canPersist\) \{/);
  assert.doesNotMatch(source, /abortedContent\.length >= 40 && canPersist/);
});
