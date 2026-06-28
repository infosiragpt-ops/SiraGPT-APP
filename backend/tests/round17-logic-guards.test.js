'use strict';

// Source-level regression guards for two round-17 logic fixes whose live paths
// are impractical to drive deterministically in an offline unit test (the
// faithfulness verdict classifier is fuzzy; the react-agent stoppedReason path
// sits deep in the run loop). We assert the corrected expressions on the source,
// like ai-generate-chat-idor-guard.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('reasoning-faithfulness normalises the unsupported penalty inside the division', () => {
  const src = read('services/reasoning-faithfulness-check.js');
  // Correct: (supported - unsupported * 0.25) / steps.length
  assert.match(
    src,
    /clamp\(\s*\(\s*supported\s*-\s*unsupported\s*\*\s*0\.25\s*\)\s*\/\s*steps\.length\s*\)/,
    'penalty must be normalised by steps.length (inside the division)',
  );
  // Must NOT be the old precedence bug: supported / steps.length - unsupported * 0.25
  assert.ok(
    !/clamp\(\s*supported\s*\/\s*steps\.length\s*-\s*unsupported\s*\*\s*0\.25\s*\)/.test(src),
    'must not apply the penalty on the absolute scale',
  );
});

test('react-agent sets degraded_no_finalize unconditionally in the no-tools branch', () => {
  const src = read('services/react-agent.js');
  // The buggy `stoppedReason = stoppedReason || 'degraded_no_finalize'` kept
  // 'max_steps'; the fix assigns it unconditionally.
  assert.ok(
    !/stoppedReason\s*=\s*stoppedReason\s*\|\|\s*'degraded_no_finalize'/.test(src),
    "must not OR-default (keeps 'max_steps')",
  );
  assert.match(src, /stoppedReason = 'degraded_no_finalize';/, 'assigns degraded_no_finalize unconditionally');
});
