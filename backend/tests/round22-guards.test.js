'use strict';

// Source-level regression guards for round-22 fixes whose live paths are
// module-load consts / stream internals (not cleanly testable offline).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('attribution-replay tolerance accepts an explicit 0', () => {
  const src = read('services/attribution-replay-engine.js');
  assert.ok(!/Number\(opts\.numericTolerance\)\s*>\s*0\s*\?/.test(src), 'must not gate tolerance by > 0');
  assert.match(src, /opts\.numericTolerance != null && Number\.isFinite/, 'tolerance accepts 0, rejects NaN');
});

test('reasoning-orchestrator penalty knobs accept an explicit 0', () => {
  const src = read('services/reasoning-orchestrator.js');
  assert.ok(!/SIRAGPT_ROUTING_PENALTY_THRESHOLD\) \|\| 0\.4/.test(src), 'threshold must not use || 0.4');
  assert.ok(!/SIRAGPT_ROUTING_PENALTY_MARGIN\) \|\| 0\.1/.test(src), 'margin must not use || 0.1');
  assert.match(src, /Number\.isFinite\(Number\(process\.env\.SIRAGPT_ROUTING_PENALTY_THRESHOLD\)\)/, 'threshold NaN-only fallback');
});

test('test-time-compute MAX_DIRECTIVE_CHARS accepts an explicit 0', () => {
  const src = read('services/test-time-compute.js');
  assert.ok(!/SIRAGPT_TEST_TIME_COMPUTE_MAX_CHARS\) \|\| 1400/.test(src), 'must not use || 1400');
  assert.match(src, /Number\.isFinite\(_rawMaxDirectiveChars\)/, 'NaN-only fallback');
});

test('streaming-docx tears down the stream on normal completion too', () => {
  const src = read('services/document/streaming-docx.js');
  // The destroy must NOT be gated on `aborted`.
  assert.ok(!/stream\.destroy === 'function' && aborted/.test(src), 'destroy must not be gated on abort only');
  assert.match(src, /removeAllListeners/, 'listeners removed in finally');
});
