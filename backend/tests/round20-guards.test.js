'use strict';

// Source-level regression guards for round-20 fixes whose live paths are
// route-level / harness-heavy to drive deterministically offline.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

test('search-brain-universal awaits settings.get()', () => {
  const src = read('routes/search-brain-universal.js');
  assert.match(src, /const userSettings = await settings\.get\(/, 'settings.get must be awaited');
});

test('search.js imports runAgenticBatch (used in the /web stream route)', () => {
  const src = read('routes/search.js');
  assert.match(src, /require\(['"]\.\.\/services\/searchBrain\/agenticBatch['"]\)/, 'runAgenticBatch import present');
  assert.match(src, /\brunAgenticBatch\b/, 'runAgenticBatch referenced');
  // It must actually be imported (not just used) — load the module to prove the
  // reference resolves at require-time without a ReferenceError.
  assert.doesNotThrow(() => require('../src/routes/search'));
});

test('prompt-provenance re-aligns the map after truncation', () => {
  const src = read('services/prompt-provenance-tracker.js');
  // After slicing the prompt, entries beyond the cut are dropped and the
  // spanning one is clamped — so attribute(offset) never points past the end.
  assert.match(src, /if \(e\.offset >= cut\) continue;/, 'drops entries entirely past the cut');
  assert.match(src, /Math\.min\(e\.length, cut - e\.offset\)/, 'clamps the spanning entry length');
});

test('coref-resolver detectAnaphors iterates all matches (matchAll, not first match)', () => {
  const src = read('services/agents/coref-resolver.js');
  assert.ok(!/const m = prompt\.match\(re\);/.test(src), 'must not use single match()');
  assert.match(src, /prompt\.matchAll\(/, 'uses matchAll to find every anaphor');
});

test('triple-extractor clamps confidence to [0,1]', () => {
  const src = read('services/triple-extractor.js');
  assert.match(src, /Math\.max\(0, Math\.min\(1, raw\.confidence\)\)/, 'confidence clamped to [0,1]');
});

test('images /history clamps the page limit to >= 1', () => {
  const src = read('routes/images.js');
  assert.match(src, /Math\.max\(1, Math\.min\(parseInt\(req\.query\.limit/, 'limit clamped to [1,100]');
});
