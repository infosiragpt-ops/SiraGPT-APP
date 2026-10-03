'use strict';

// Prod 2026-10-03: `corrective pass failed: Request was aborted.` — our own
// 8 s ceiling surfaces through the OpenAI SDK as APIUserAbortError, not
// AbortError, so it was logged as a provider failure; a user Stop was logged
// the same way. The catch block must classify by the signals, not err.name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('corrective pass classifies abort by signal state, not error name', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  const start = src.indexOf('async _runCorrectivePass(');
  assert.ok(start > 0);
  const block = src.slice(start, start + 4000);
  assert.match(block, /const parentAborted = Boolean\(signal\?\.aborted\);/);
  assert.match(block, /const wasTimeout = timeoutCtrl\.signal\.aborted && !parentAborted;/);
  assert.doesNotMatch(block, /err\?\.name === 'AbortError'/);
  assert.match(block, /else if \(!parentAborted\) \{\s*console\.warn\('corrective pass failed:'/);
});
