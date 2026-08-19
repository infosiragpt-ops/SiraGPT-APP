'use strict';

// Source-level regression guard for the round-21 fileProcessor falsy-0 fix
// (the vision-fallback threshold lives inside a method, not a clean export).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('fileProcessor vision-fallback thresholds use NaN-only fallbacks (honour a configured 0)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fileProcessor.js'), 'utf8');
  // Must NOT use `parseInt(...) || 100` / `parseFloat(...) || 0.5` which dropped
  // a legitimate 0 (minChars=0 → never fall back on char count).
  assert.ok(
    !/SIRAGPT_VISION_FALLBACK_MIN_CHARS, 10\) \|\| 100/.test(src),
    'minChars must not use `|| 100`',
  );
  assert.match(src, /Number\.isFinite\(rawMinChars\) \? rawMinChars : 100/, 'minChars NaN-only fallback');
  assert.match(src, /Number\.isFinite\(rawMinConf\) \? rawMinConf : 0\.5/, 'minConf NaN-only fallback');
});
