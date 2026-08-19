'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-modals');
const { extractModals, buildModalsForFiles, renderModalsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractModals('').total, 0);
  assert.equal(extractModals(null).total, 0);
});

test('detects strong "must"', () => {
  const r = extractModals('Users must accept terms before access.');
  assert.ok(r.entries.some((e) => e.kind === 'strong'));
});

test('detects strong "shall"', () => {
  const r = extractModals('The system shall validate input.');
  assert.ok(r.entries.some((e) => e.kind === 'strong'));
});

test('detects Spanish "deberá"', () => {
  const r = extractModals('El sistema deberá validar entrada.');
  assert.ok(r.entries.some((e) => e.kind === 'strong'));
});

test('detects recommended "should"', () => {
  const r = extractModals('Operators should monitor logs daily.');
  assert.ok(r.entries.some((e) => e.kind === 'recommended'));
});

test('detects Spanish "debería"', () => {
  const r = extractModals('El operador debería monitorear los logs.');
  assert.ok(r.entries.some((e) => e.kind === 'recommended'));
});

test('detects permitted "may"', () => {
  const r = extractModals('Admins may grant elevated access.');
  assert.ok(r.entries.some((e) => e.kind === 'permitted'));
});

test('detects possibility "might"', () => {
  const r = extractModals('Latency might increase during peak hours.');
  assert.ok(r.entries.some((e) => e.kind === 'possibility'));
});

test('detects prohibited "must not"', () => {
  const r = extractModals('Users must not share credentials.');
  assert.ok(r.entries.some((e) => e.kind === 'prohibited'));
});

test('detects prohibited "shall not"', () => {
  const r = extractModals('The system shall not log PII.');
  assert.ok(r.entries.some((e) => e.kind === 'prohibited'));
});

test('detects Spanish "se prohíbe"', () => {
  const r = extractModals('Se prohíbe el uso comercial.');
  assert.ok(r.entries.some((e) => e.kind === 'prohibited'));
});

test('counts byKind', () => {
  const r = extractModals('Users must agree. Admins should review. Users may opt-out. Users must not share.');
  assert.ok(r.totals.strong >= 1);
  assert.ok(r.totals.recommended >= 1);
  assert.ok(r.totals.permitted >= 1);
  assert.ok(r.totals.prohibited >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Users must do ${i}. `;
  const r = extractModals(text);
  assert.ok(r.entries.length <= 24);
});

test('buildModalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Users must agree.' },
    { name: 'b.md', extractedText: 'Admins may review.' },
  ];
  const r = buildModalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderModalsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Users must agree.' }];
  const r = buildModalsForFiles(files);
  const md = renderModalsBlock(r);
  assert.match(md, /^## MODAL VERBS/);
});

test('renderModalsBlock empty when nothing surfaces', () => {
  assert.equal(renderModalsBlock({ perFile: [] }), '');
  assert.equal(renderModalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildModalsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Users must agree.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
