/**
 * New output formats wired through the registry:
 *   txt, json, xml, yaml, rtf, odt, epub
 *
 * The registry must:
 *   1. Resolve the format from MIME and from extension.
 *   2. Return at least one runtime-allowed generator.
 *   3. Pick the highest-preference candidate first.
 *   4. Pass the integrity audit (no duplicate ids).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseGenerators,
  inferFormat,
  integrity,
} = require('../src/services/sira/document-pipeline-registry');

const NEW_FORMATS = [
  { format: 'txt',  ext: 'txt',  mime: 'text/plain' },
  { format: 'json', ext: 'json', mime: 'application/json' },
  { format: 'xml',  ext: 'xml',  mime: 'application/xml' },
  { format: 'yaml', ext: 'yml',  mime: 'application/yaml' },
  { format: 'rtf',  ext: 'rtf',  mime: 'application/rtf' },
  { format: 'odt',  ext: 'odt',  mime: 'application/vnd.oasis.opendocument.text' },
  { format: 'epub', ext: 'epub', mime: 'application/epub+zip' },
];

for (const { format, ext, mime } of NEW_FORMATS) {
  test(`registry: ${format} resolves from mime + ext`, () => {
    assert.equal(inferFormat(mime, null), format);
    assert.equal(inferFormat(null, ext), format);
    assert.equal(inferFormat(null, '.' + ext), format);
  });

  test(`registry: ${format} has at least one generator`, () => {
    const { generators } = chooseGenerators({ format });
    assert.ok(generators.length >= 1, `expected ≥1 generator for ${format}`);
    // Highest-preference first
    for (let i = 1; i < generators.length; i++) {
      assert.ok(generators[i - 1].preference >= generators[i].preference);
    }
  });
}

test('registry: yml extension normalises to yaml format', () => {
  assert.equal(inferFormat(null, 'yml'), 'yaml');
});

test('registry: htm extension normalises to html format', () => {
  assert.equal(inferFormat(null, 'htm'), 'html');
});

test('registry: integrity audit passes after additions', () => {
  const r = integrity();
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});

test('registry: pure-node runtime can still produce txt/json', () => {
  const nodeOnly = { python: false, node: true, binary: false };
  for (const fmt of ['txt', 'json', 'xml', 'yaml']) {
    const { generators } = chooseGenerators({ format: fmt, runtime: nodeOnly });
    assert.ok(generators.length >= 1, `${fmt} needs a node generator`);
    assert.ok(generators.every(g => g.language === 'node'));
  }
});

test('registry: rtf falls back to node when binary unavailable', () => {
  const { generators } = chooseGenerators({
    format: 'rtf',
    runtime: { python: false, node: true, binary: false },
  });
  assert.ok(generators.length >= 1);
  assert.equal(generators[0].id, 'rtf-writer');
});
