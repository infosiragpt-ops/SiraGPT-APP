'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-disclosures');
const { extractDisclosures, buildDisclosuresForFiles, renderDisclosuresBlock, _internal } = engine;
const { detectKind } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractDisclosures('').total, 0);
  assert.equal(extractDisclosures(null).total, 0);
});

test('detectKind: forward-looking statement', () => {
  assert.equal(detectKind('This presentation contains forward-looking statements.'), 'forward-looking');
  assert.equal(detectKind('Este documento contiene declaraciones prospectivas.'), 'forward-looking');
});

test('detectKind: safe harbour', () => {
  assert.equal(detectKind('Statements made are protected by safe harbor provisions.'), 'safe-harbour');
});

test('detectKind: risk warning', () => {
  assert.equal(detectKind('Investing involves risk, including potential loss of capital.'), 'risk-warning');
  assert.equal(detectKind('Past performance is not indicative of future results.'), 'risk-warning');
  assert.equal(detectKind('Las rentabilidades pasadas no garantizan resultados futuros.'), 'risk-warning');
});

test('detectKind: conflict of interest', () => {
  assert.equal(detectKind('There is a potential conflict of interest between the parties.'), 'conflict');
  assert.equal(detectKind('Se declara un potencial conflicto de intereses.'), 'conflict');
});

test('detectKind: regulatory advisory', () => {
  assert.equal(detectKind('This information is not financial advice and you should consult your adviser.'), 'regulatory');
  assert.equal(detectKind('Esta información no constituye asesoría financiera; consulte a su asesor.'), 'regulatory');
});

test('detectKind: non-disclosure returns null', () => {
  assert.equal(detectKind('The team had lunch on Tuesday in the cafeteria.'), null);
});

test('extracts multiple kinds in one document', () => {
  const text = `This presentation contains forward-looking statements. Investing involves risk. There is a potential conflict of interest. This is not financial advice.`;
  const r = extractDisclosures(text);
  assert.ok(r.total >= 3);
  const kinds = r.disclosures.map((d) => d.kind);
  assert.ok(kinds.includes('forward-looking'));
  assert.ok(kinds.includes('risk-warning'));
});

test('dedupes identical disclosures', () => {
  const text = 'Past performance is not indicative of future results. Past performance is not indicative of future results.';
  const r = extractDisclosures(text);
  assert.equal(r.total, 1);
});

test('buildDisclosuresForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'This document contains forward-looking statements.' },
    { name: 'b.md', extractedText: 'Past performance is not indicative of future results.' },
  ];
  const r = buildDisclosuresForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDisclosuresBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'This document contains forward-looking statements.' }];
  const r = buildDisclosuresForFiles(files);
  const md = renderDisclosuresBlock(r);
  assert.match(md, /^## REGULATORY DISCLOSURES/);
});

test('renderDisclosuresBlock empty when nothing surfaces', () => {
  assert.equal(renderDisclosuresBlock({ perFile: [] }), '');
  assert.equal(renderDisclosuresBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDisclosuresForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Forward-looking statements apply here.' }]);
  assert.ok(Array.isArray(r.perFile));
});
