'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-signoffs');
const { extractSignoffs, buildSignoffsForFiles, renderSignoffsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractSignoffs('').total, 0);
  assert.equal(extractSignoffs(null).total, 0);
});

test('detects "Sincerely," + name', () => {
  const r = extractSignoffs('Body of email.\n\nSincerely,\nAlice Smith');
  assert.ok(r.entries.some((e) => e.phrase === 'Sincerely' && /Alice/.test(e.name || '')));
});

test('detects "Best regards," + name', () => {
  const r = extractSignoffs('Body.\n\nBest regards,\nBob Jones');
  assert.ok(r.entries.some((e) => e.phrase === 'Best regards'));
});

test('detects Spanish "Saludos cordiales,"', () => {
  const r = extractSignoffs('Cuerpo del mensaje.\n\nSaludos cordiales,\nPedro');
  assert.ok(r.entries.some((e) => e.phrase === 'Saludos cordiales'));
});

test('detects "Atentamente,"', () => {
  const r = extractSignoffs('Mensaje.\n\nAtentamente,\nMaría');
  assert.ok(r.entries.some((e) => e.phrase === 'Atentamente'));
});

test('detects "Cheers,"', () => {
  const r = extractSignoffs('Body.\n\nCheers,\nDana');
  assert.ok(r.entries.some((e) => e.phrase === 'Cheers'));
});

test('handles sign-off without trailing name', () => {
  const r = extractSignoffs('Body.\n\nSincerely,');
  assert.ok(r.entries.length >= 1);
});

test('dedupes identical sign-offs', () => {
  const r = extractSignoffs('Hi.\n\nThanks,\nAlice\n\n---\n\nThanks,\nAlice');
  assert.equal(r.entries.filter((e) => e.phrase === 'Thanks' && /Alice/.test(e.name || '')).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 15; i++) text += `Body ${i}.\n\nSincerely,\nName${i}\n\n`;
  const r = extractSignoffs(text);
  assert.ok(r.entries.length <= 8);
});

test('buildSignoffsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Body.\n\nSincerely,\nAlice' },
    { name: 'b.md', extractedText: 'Body.\n\nCheers,\nBob' },
  ];
  const r = buildSignoffsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSignoffsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Body.\n\nSincerely,\nAlice' }];
  const r = buildSignoffsForFiles(files);
  const md = renderSignoffsBlock(r);
  assert.match(md, /^## SIGN-OFFS/);
});

test('renderSignoffsBlock empty when nothing surfaces', () => {
  assert.equal(renderSignoffsBlock({ perFile: [] }), '');
  assert.equal(renderSignoffsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSignoffsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Body.\n\nSincerely,\nName' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('rejects sign-off in middle of paragraph (no preceding newline)', () => {
  const r = extractSignoffs('We say sincerely, this works.');
  // Inline "Sincerely," with text following, not a sign-off block — but our regex
  // does require beginning of line / preceding newline. So should not match.
  assert.equal(r.entries.length, 0);
});
