'use strict';

// Regression — decodeHtml must never throw on a malformed numeric entity.
//
// decodeHtml expanded &#xNNNN; / &#NNNN; via String.fromCodePoint(parseInt(...)),
// which throws RangeError for code points < 0 or > 0x10FFFF. A crafted snippet
// (e.g. &#x110000; or &#9999999999;) returned by DuckDuckGo would crash the
// provider — the free web-search fallback — taking down the whole search. Out-of-
// range / unparsable entities are now passed through verbatim.

const test = require('node:test');
const assert = require('node:assert/strict');

const ddg = require('../src/services/agents/web-search/providers/duckduckgo');
const { decodeHtml } = ddg._internal;

test('decodeHtml decodes valid named + numeric entities', () => {
  assert.equal(decodeHtml('a &amp; b'), 'a & b');
  assert.equal(decodeHtml('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeHtml('caf&#233;'), 'café');       // decimal
  assert.equal(decodeHtml('&#x1F600;'), '\u{1F600}');  // emoji via hex (astral plane)
  assert.equal(decodeHtml('it&#39;s'), "it's");
});

test('decodeHtml does NOT throw on out-of-range numeric entities', () => {
  // Just above the Unicode max (0x10FFFF) and an absurd decimal.
  assert.doesNotThrow(() => decodeHtml('boom &#x110000; end'));
  assert.doesNotThrow(() => decodeHtml('boom &#9999999999; end'));
  // Out-of-range entities are left verbatim, valid neighbours still decode.
  assert.equal(decodeHtml('&#x110000; &amp; ok'), '&#x110000; & ok');
  assert.equal(decodeHtml('&#9999999999;'), '&#9999999999;');
});
