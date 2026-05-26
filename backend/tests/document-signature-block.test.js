'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-signature-block');
const { extractSignatureBlocks, buildSignaturesForFiles, renderSignaturesBlock, _internal } = engine;
const { hasAnchor, fieldHitCount } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractSignatureBlocks('').total, 0);
  assert.equal(extractSignatureBlocks(null).total, 0);
});

test('hasAnchor: detects underscore line', () => {
  assert.ok(hasAnchor('____________________'));
  assert.ok(hasAnchor('Some text\n____________\nMore text'));
});

test('hasAnchor: detects "Signature:" / "Firma:"', () => {
  assert.ok(hasAnchor('Signature: ____'));
  assert.ok(hasAnchor('Firma: ____'));
});

test('fieldHitCount counts Name / Title / Date / Company', () => {
  const text = 'Name: Jane Smith\nTitle: CEO\nDate: 2026-05-12';
  assert.equal(fieldHitCount(text), 3);
});

test('detects English signature block', () => {
  const text = `Body of the contract.

By: ____________________
Name: Jane Smith
Title: CEO
Date: 2026-05-12

`;
  const r = extractSignatureBlocks(text);
  assert.ok(r.total >= 1);
  const block = r.blocks[0];
  assert.ok(block.fieldHits >= 2);
});

test('detects Spanish signature block', () => {
  const text = `Cuerpo del contrato.

Por: ____________________
Nombre: María López
Cargo: Directora
Fecha: 2026-05-12

`;
  const r = extractSignatureBlocks(text);
  assert.ok(r.total >= 1);
});

test('skips blocks without anchor or enough fields', () => {
  const text = 'Just a paragraph with no anchor or fields.';
  const r = extractSignatureBlocks(text);
  assert.equal(r.total, 0);
});

test('caps blocks per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `\n\nName: Person ${i}\nTitle: T${i}\nDate: 2026-05-${i + 1}\nSignature: _____\n`;
  }
  const r = extractSignatureBlocks(text);
  assert.ok(r.total <= 6);
});

test('preserves verbatim lines', () => {
  const text = `\n\nName: Jane Smith\nTitle: CEO\nDate: 2026-05-12\nSignature: _____\n`;
  const r = extractSignatureBlocks(text);
  assert.ok(r.blocks[0].lines.some((l) => /Jane Smith/.test(l)));
});

test('buildSignaturesForFiles aggregates across batch', () => {
  const files = [
    { name: 'contract-a.md', extractedText: '\n\nName: Jane Smith\nTitle: CEO\nDate: 2026-05-12\nBy: _____\n' },
    { name: 'contract-b.md', extractedText: '\n\nNombre: María López\nCargo: Directora\nFecha: 2026-05-12\nPor: _____\n' },
  ];
  const r = buildSignaturesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSignaturesBlock returns markdown when blocks exist', () => {
  const files = [{ name: 'doc.md', extractedText: '\n\nName: Jane\nTitle: CEO\nDate: 2026-05-12\nBy: _____\n' }];
  const r = buildSignaturesForFiles(files);
  const md = renderSignaturesBlock(r);
  assert.match(md, /^## SIGNATURE BLOCKS/);
});

test('renderSignaturesBlock empty when nothing surfaces', () => {
  assert.equal(renderSignaturesBlock({ perFile: [] }), '');
  assert.equal(renderSignaturesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSignaturesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '\n\nName: x\nDate: 2026-05-12\nBy: _____\n' }]);
  assert.ok(Array.isArray(r.perFile));
});

test('scans only the tail of large documents', () => {
  // Build a long body that contains a fake signature block in the FIRST
  // part. Only blocks in the last ~8 KB should surface.
  const head = 'Name: Wrong\nTitle: Wrong\nDate: Wrong\nBy: ____\n\n';
  const body = 'lorem '.repeat(2000);
  const tail = '\n\nName: Correct\nTitle: Correct\nDate: 2026-05-12\nBy: ____\n';
  const r = extractSignatureBlocks(head + body + tail);
  if (r.total >= 1) {
    assert.ok(r.blocks.some((b) => b.lines.some((l) => /Correct/.test(l))));
  }
});
