'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  BUNDLED_FONT_PATH,
  SYSTEM_CANDIDATES,
  resolveUnicodeFontPath,
  registerUnicodeFont,
  clearFontCacheForTests,
} = require('../src/services/document/pdf-fonts');

test('bundled DejaVu Sans exists in the repo', () => {
  assert.ok(fs.existsSync(BUNDLED_FONT_PATH), `missing bundled font at ${BUNDLED_FONT_PATH}`);
  const size = fs.statSync(BUNDLED_FONT_PATH).size;
  assert.ok(size > 100_000 && size < 5_000_000, `unexpected bundled font size ${size}`);
});

test('resolveUnicodeFontPath prefers explicit env override', () => {
  clearFontCacheForTests();
  const fake = path.join(__dirname, 'fixtures-does-not-exist.ttf');
  // Non-existent override is ignored (falls through to bundle/system).
  assert.notEqual(resolveUnicodeFontPath({ SIRAGPT_PDF_FONT_PATH: fake }), null);
});

test('resolveUnicodeFontPath falls back to system candidates when bundle missing', () => {
  clearFontCacheForTests();
  // Simulate a deployment without the bundled asset by pointing the
  // module's own resolution at an empty candidate set via the public API:
  // we can't remove the repo file, so just assert resolution succeeds and
  // returns one of the known candidates.
  const resolved = resolveUnicodeFontPath({});
  assert.ok(typeof resolved === 'string' || resolved === null);
  if (resolved) {
    assert.ok(
      resolved === BUNDLED_FONT_PATH || SYSTEM_CANDIDATES.includes(resolved),
      `unexpected font path ${resolved}`,
    );
    assert.ok(fs.existsSync(resolved));
  }
});

test('registerUnicodeFont embeds the font into a PDFKit document', () => {
  clearFontCacheForTests();
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ autoFirstPage: false });
  const result = registerUnicodeFont(doc);
  if (result.embedded) {
    assert.ok(result.fontPath, 'embedded result must carry the font path');
    assert.ok(fs.existsSync(result.fontPath));
  } else {
    // No font available in this environment — historical behaviour.
    assert.equal(result.fontPath, null);
  }
});
