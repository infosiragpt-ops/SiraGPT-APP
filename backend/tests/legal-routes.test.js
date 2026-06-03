'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const legal = require('../src/routes/legal');
const { _parseFrontMatter, _loadDocument, DOC_MAP, LEGAL_DIR } = legal._internals;

describe('legal routes — internals', () => {
  test('parses @version + @lastUpdated from front-matter comment', () => {
    const md = '<!--\n  @version: 1.2.3\n  @lastUpdated: 2026-05-19\n-->\n# Hi';
    const meta = _parseFrontMatter(md);
    assert.equal(meta.version, '1.2.3');
    assert.equal(meta.lastUpdated, '2026-05-19');
  });

  test('returns unversioned when no front-matter', () => {
    const meta = _parseFrontMatter('no comment here');
    assert.equal(meta.version, 'unversioned');
    assert.equal(meta.lastUpdated, null);
  });

  test('loads the canonical privacy-policy markdown', () => {
    const doc = _loadDocument('privacy-policy', 'latest');
    assert.ok(doc, 'expected privacy-policy doc to exist');
    assert.equal(doc.document, 'privacy-policy');
    assert.ok(typeof doc.version === 'string' && doc.version.length > 0);
    assert.ok(doc.markdown.length > 100);
  });

  test('loads terms-of-service markdown', () => {
    const doc = _loadDocument('terms-of-service', 'latest');
    assert.ok(doc);
    assert.equal(doc.document, 'terms-of-service');
  });

  test('returns null for unknown slug', () => {
    assert.equal(_loadDocument('unknown', 'latest'), null);
  });

  test('LEGAL_DIR points to docs/legal in the repo', () => {
    assert.ok(fs.existsSync(LEGAL_DIR), `LEGAL_DIR not found: ${LEGAL_DIR}`);
    assert.ok(fs.existsSync(path.join(LEGAL_DIR, 'privacy-policy.md')));
    assert.ok(fs.existsSync(path.join(LEGAL_DIR, 'terms-of-service.md')));
  });

  test('DOC_MAP contains both supported documents', () => {
    assert.deepEqual(Object.keys(DOC_MAP).sort(), ['privacy-policy', 'terms-of-service']);
  });

  test('caches parsed documents — a repeated load performs no extra file read', () => {
    const orig = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = (p, ...rest) => {
      if (String(p).includes('privacy-policy')) reads += 1;
      return orig(p, ...rest);
    };
    try {
      // Warm the cache (may already be warm from earlier tests — that's fine).
      _loadDocument('privacy-policy', 'latest');
      const before = reads;
      const doc = _loadDocument('privacy-policy', 'latest');
      assert.ok(doc && doc.markdown.length > 0);
      assert.equal(reads - before, 0, 'second load must be served from cache (no file read)');
    } finally {
      fs.readFileSync = orig;
    }
  });
});
