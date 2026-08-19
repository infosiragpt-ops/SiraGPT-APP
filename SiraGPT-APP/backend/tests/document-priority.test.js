'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-priority');
const { extractPriorities, buildPrioritiesForFiles, renderPrioritiesBlock, _internal } = engine;
const { normaliseLevel } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractPriorities('').total, 0);
  assert.equal(extractPriorities(null).total, 0);
});

test('normaliseLevel: critical/high/medium/low/trivial mapping', () => {
  assert.equal(normaliseLevel('Critical'), 'critical');
  assert.equal(normaliseLevel('High'), 'high');
  assert.equal(normaliseLevel('Medium'), 'medium');
  assert.equal(normaliseLevel('Low'), 'low');
  assert.equal(normaliseLevel('Trivial'), 'trivial');
  assert.equal(normaliseLevel('P0'), 'critical');
  assert.equal(normaliseLevel('P1'), 'high');
});

test('detects P0', () => {
  const r = extractPriorities('Issue P0: data loss bug');
  const p0 = r.tags.find((t) => t.label === 'P0');
  assert.ok(p0);
  assert.equal(p0.level, 'critical');
});

test('detects P1', () => {
  const r = extractPriorities('Ticket P1: dashboard slow');
  assert.ok(r.tags.some((t) => t.label === 'P1' && t.level === 'high'));
});

test('detects SEV-1', () => {
  const r = extractPriorities('Incident SEV-1: outage');
  assert.ok(r.tags.some((t) => t.label === 'SEV-1' && t.level === 'critical'));
});

test('detects SEV 2 (with space)', () => {
  const r = extractPriorities('Incident SEV 2: degraded');
  assert.ok(r.tags.some((t) => t.level === 'high'));
});

test('detects Blocker / Critical / Major / Minor / Trivial', () => {
  const r = extractPriorities('Blocker bug. Critical issue. Major flaw. Minor nit. Trivial typo.');
  const labels = r.tags.map((t) => t.label);
  assert.ok(labels.includes('Blocker'));
  assert.ok(labels.includes('Critical'));
  assert.ok(labels.includes('Major'));
  assert.ok(labels.includes('Minor'));
  assert.ok(labels.includes('Trivial'));
});

test('detects Urgent', () => {
  const r = extractPriorities('Urgent fix needed before launch.');
  assert.ok(r.tags.some((t) => t.label === 'Urgent'));
});

test('detects Spanish equivalents Crítico / Alto / Bajo', () => {
  const r = extractPriorities('Severidad: Crítico. Prioridad: Alto. Otro item: Bajo.');
  const levels = r.tags.map((t) => t.level);
  assert.ok(levels.includes('critical'));
  assert.ok(levels.includes('high'));
  assert.ok(levels.includes('low'));
});

test('detects labeled line "Priority: High"', () => {
  const r = extractPriorities('Priority: High\nSome description.');
  assert.ok(r.tags.some((t) => t.labeled));
});

test('detects labeled line "Severity: P1"', () => {
  const r = extractPriorities('Severity: P1');
  assert.ok(r.tags.some((t) => t.labeled || t.label === 'P1'));
});

test('counts totals correctly', () => {
  const r = extractPriorities('P0 issue. P0 also. P1 case. Critical bug.');
  assert.ok(r.totals.critical >= 1);
  assert.ok(r.totals.high >= 1);
});

test('caps tags per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `Ticket P0-${i}: foo. `;
  const r = extractPriorities(text);
  assert.ok(r.tags.length <= 25);
});

test('dedupes identical contexts', () => {
  const r = extractPriorities('P0 critical bug. P0 critical bug. P0 critical bug.');
  // Same context → deduped down significantly
  assert.ok(r.tags.filter((t) => t.label === 'P0').length <= 3);
});

test('buildPrioritiesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'P0 outage detected.' },
    { name: 'b.md', extractedText: 'Severity: Critical' },
  ];
  const r = buildPrioritiesForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.totals.critical >= 2);
});

test('renderPrioritiesBlock returns markdown', () => {
  const files = [{ name: 'doc.md', extractedText: 'P0 outage' }];
  const r = buildPrioritiesForFiles(files);
  const md = renderPrioritiesBlock(r);
  assert.match(md, /^## PRIORITY \/ SEVERITY TAGS/);
});

test('renderPrioritiesBlock includes totals line', () => {
  const files = [{ name: 'doc.md', extractedText: 'P0 outage. P1 slow. Critical bug.' }];
  const r = buildPrioritiesForFiles(files);
  const md = renderPrioritiesBlock(r);
  assert.match(md, /Totals/);
  assert.match(md, /critical=/);
});

test('renderPrioritiesBlock empty when nothing surfaces', () => {
  assert.equal(renderPrioritiesBlock({ perFile: [] }), '');
  assert.equal(renderPrioritiesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPrioritiesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'P0 outage' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('does not match P0 as part of another word', () => {
  const r = extractPriorities('Visit shop SP0RT for deals');
  // SP0RT contains "P0" but should not match (preceded by S, a letter)
  assert.equal(r.tags.filter((t) => t.label === 'P0').length, 0);
});
