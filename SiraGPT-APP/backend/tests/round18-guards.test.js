'use strict';

// Source-level regression guards for two round-18 fixes whose live paths are
// impractical to exercise deterministically offline (an internal withTimeout
// helper; an adversarial-score threshold whose effect on realistic prompts is
// not observable because the verdict gate only fires at score ≥ 0.5).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('conversation-summarizer withTimeout clears the race timer', () => {
  const src = read('services/conversation-summarizer.js');
  const fn = src.match(/async function withTimeout[\s\S]*?\n}/);
  assert.ok(fn, 'found withTimeout');
  assert.match(fn[0], /clearTimeout\(/, 'the timeout timer must be cleared when the promise wins the race');
});

test('adversarial-prompt-detector minScore threshold accepts an explicit 0', () => {
  const src = read('services/adversarial-prompt-detector.js');
  // Must NOT use the falsy-0 form `Number(opts.minScore) > 0 ? … : 0.5`.
  assert.ok(
    !/Number\(opts\.minScore\)\s*>\s*0\s*\?/.test(src),
    "minScore must not be gated by `> 0` (rejects an explicit 0)",
  );
  assert.match(src, /opts\.minScore\s*!=\s*null/, 'minScore is accepted when explicitly provided (incl. 0)');
});
