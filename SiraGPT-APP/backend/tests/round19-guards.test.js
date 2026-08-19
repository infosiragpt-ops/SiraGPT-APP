'use strict';

// Source-level regression guards for round-19 fixes whose live paths are
// internal/error-path and impractical to drive deterministically offline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('litellm enforceBudget treats max_cost_usd=0 as an enforced limit', () => {
  const src = read('services/ai-product-os/litellm-gateway.js');
  // Target the actual guard CONDITION (not the explanatory comment): early
  // return must use `max < 0` (unset), not `max <= 0` (which skipped a 0 budget).
  assert.match(src, /typeof max !== "number" \|\| max < 0 \|\|/, 'guard uses max < 0');
  assert.ok(
    !/typeof max !== "number" \|\| max <= 0 \|\|/.test(src),
    'guard must not use max <= 0 (skips a zero budget)',
  );
});

test('link-preview readBodyCapped cancels the reader in a finally', () => {
  const src = read('routes/link-preview.js');
  const fn = src.match(/async function readBodyCapped[\s\S]*?\n}/);
  assert.ok(fn, 'found readBodyCapped');
  assert.match(fn[0], /finally\s*{[\s\S]*?reader\.cancel\(/, 'reader must be cancelled in a finally');
});

test('skills-registry unregister removes now-empty index sets', () => {
  const src = read('services/skills-registry.js');
  const fn = src.match(/function unregisterSkill[\s\S]*?\n}/);
  assert.ok(fn, 'found unregisterSkill');
  assert.match(fn[0], /categoryIndex\.delete\(/, 'empty category set is removed');
  assert.match(fn[0], /tagIndex\.delete\(/, 'empty tag set is removed');
});

test('hosting build.service removes the abort listener on the error path', () => {
  const src = read('services/hosting/build.service.js');
  const errHandler = src.match(/proc\.on\('error'[\s\S]*?\}\);/);
  assert.ok(errHandler, 'found proc error handler');
  assert.match(errHandler[0], /removeEventListener\?\.\('abort'/, 'abort listener removed on spawn error');
});

test('visual-media scene breakdown clamps the last-scene duration to >= 1', () => {
  const src = read('services/agents/visual-media-tools.js');
  assert.match(
    src,
    /const remainingDuration = Math\.max\(1,/,
    'remainingDuration must be clamped to at least 1 second',
  );
});
