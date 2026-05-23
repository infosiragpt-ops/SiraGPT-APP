'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-wiki-refs');
const { extractWikiRefs, buildWikiRefsForFiles, renderWikiRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractWikiRefs('').total, 0);
  assert.equal(extractWikiRefs(null).total, 0);
});

test('detects English Wikipedia URL', () => {
  const r = extractWikiRefs('https://en.wikipedia.org/wiki/Quantum_mechanics');
  assert.ok(r.entries.some((e) => e.kind === 'wikipedia' && e.lang === 'en' && /Quantum mechanics/.test(e.title)));
});

test('detects Spanish Wikipedia URL', () => {
  const r = extractWikiRefs('https://es.wikipedia.org/wiki/Mecanica_cuantica');
  assert.ok(r.entries.some((e) => e.kind === 'wikipedia' && e.lang === 'es'));
});

test('decodes URL-encoded titles', () => {
  const r = extractWikiRefs('https://en.wikipedia.org/wiki/Quantum_field_theory');
  assert.ok(r.entries.some((e) => /Quantum field theory/.test(e.title)));
});

test('detects Wikidata Q-ID', () => {
  const r = extractWikiRefs('Reference: Q42 (Douglas Adams)');
  assert.ok(r.entries.some((e) => e.kind === 'wikidata' || e.kind === 'mediawiki'));
});

test('rejects small Q IDs (Q1-Q99)', () => {
  const r = extractWikiRefs('Q1 universe');
  assert.equal(r.entries.filter((e) => e.kind === 'wikidata').length, 0);
});

test('detects MediaWiki [[Article]] link', () => {
  const r = extractWikiRefs('See [[Quantum mechanics]] for background.');
  assert.ok(r.entries.some((e) => e.kind === 'mediawiki' && /Quantum mechanics/.test(e.title)));
});

test('detects [[Article|display]] form', () => {
  const r = extractWikiRefs('See [[Quantum mechanics|QM]] for background.');
  const entry = r.entries.find((e) => e.kind === 'mediawiki');
  assert.equal(entry.display, 'QM');
});

test('detects DBPedia resource URL', () => {
  const r = extractWikiRefs('https://dbpedia.org/resource/Quantum_mechanics');
  assert.ok(r.entries.some((e) => e.kind === 'dbpedia'));
});

test('detects Wikipedia api.php URL', () => {
  const r = extractWikiRefs('GET https://en.wikipedia.org/w/api.php?action=query&list=search');
  assert.ok(r.entries.some((e) => e.kind === 'wikipedia'));
});

test('dedupes identical entries', () => {
  const r = extractWikiRefs('[[Quantum mechanics]] and [[Quantum mechanics]] again');
  assert.equal(r.entries.filter((e) => e.kind === 'mediawiki' && /Quantum mechanics/.test(e.title)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `[[Article ${i + 100}]] `;
  const r = extractWikiRefs(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractWikiRefs(
    'https://en.wikipedia.org/wiki/X and Q123456 and [[Y]]'
  );
  assert.ok(r.totals.wikipedia >= 1);
  assert.ok(r.totals.wikidata >= 1);
  assert.ok(r.totals.mediawiki >= 1);
});

test('buildWikiRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'https://en.wikipedia.org/wiki/X' },
    { name: 'b', extractedText: '[[Article Y]]' },
  ];
  const r = buildWikiRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWikiRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'paper', extractedText: 'https://en.wikipedia.org/wiki/X' }];
  const r = buildWikiRefsForFiles(files);
  const md = renderWikiRefsBlock(r);
  assert.match(md, /^## WIKIPEDIA/);
});

test('renderWikiRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderWikiRefsBlock({ perFile: [] }), '');
  assert.equal(renderWikiRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWikiRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'https://en.wikipedia.org/wiki/X' },
  ]);
  assert.equal(r.perFile.length, 1);
});
