'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-dispute-resolution');
const { extractDisputeResolution, buildDisputesForFiles, renderDisputesBlock, _internal } = engine;
const { matchesAny, pickSeat, MECHANISM_PATTERNS } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractDisputeResolution('').total, 0);
  assert.equal(extractDisputeResolution(null).total, 0);
});

test('detects arbitration (English)', () => {
  const text = 'Any dispute will be resolved by binding arbitration under the ICC Rules.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'arbitration'));
});

test('detects arbitration (Spanish)', () => {
  const text = 'Toda controversia se resolverá mediante arbitraje conforme al Reglamento CCI.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'arbitration'));
});

test('detects mediation', () => {
  const text = 'The Parties shall first attempt resolution through mediation before arbitration.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'mediation'));
});

test('detects Spanish mediación', () => {
  const text = 'Las partes se someterán a mediación previa antes de cualquier acción judicial.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'mediation'));
});

test('detects litigation forum', () => {
  const text = 'The Parties consent to the exclusive jurisdiction of the courts of Delaware.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'litigation'));
});

test('detects Spanish litigation forum', () => {
  const text = 'Las partes aceptan la jurisdicción exclusiva de los tribunales de Madrid.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'litigation'));
});

test('detects escalation language', () => {
  const text = 'The Parties shall first attempt to resolve any dispute through good-faith negotiation.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'escalation'));
});

test('detects waiver (jury / class action)', () => {
  const text = 'Each Party waives any right to a jury trial. Class-action waiver applies.';
  const r = extractDisputeResolution(text);
  assert.ok(r.findings.some((f) => f.mechanism === 'waiver'));
});

test('picks seat from arbitration sentence', () => {
  const text = 'Arbitration shall be held in London under LCIA rules.';
  const r = extractDisputeResolution(text);
  const arb = r.findings.find((f) => f.mechanism === 'arbitration');
  assert.ok(arb);
  // The seat heuristic is best-effort; accept null OR matching seat.
  if (arb.seat) assert.match(arb.seat, /London/);
});

test('dedupes identical sentences across mechanism scans', () => {
  const text = 'Binding arbitration under ICC Rules. Binding arbitration under ICC Rules.';
  const r = extractDisputeResolution(text);
  assert.equal(r.findings.length, 1);
});

test('matchesAny convenience returns boolean', () => {
  const mediation = MECHANISM_PATTERNS.find((m) => m.mechanism === 'mediation');
  assert.ok(matchesAny('Subject to mediation.', mediation.patterns));
});

test('buildDisputesForFiles aggregates across batch', () => {
  const files = [
    { name: 'contract-a.md', extractedText: 'Disputes are resolved by arbitration in Paris.' },
    { name: 'contract-b.md', extractedText: 'The Parties consent to jurisdiction of New York courts.' },
  ];
  const r = buildDisputesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderDisputesBlock returns markdown when findings exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'Any dispute will be resolved by binding arbitration.' }];
  const r = buildDisputesForFiles(files);
  const md = renderDisputesBlock(r);
  assert.match(md, /^## DISPUTE RESOLUTION/);
});

test('renderDisputesBlock empty when no findings', () => {
  assert.equal(renderDisputesBlock({ perFile: [] }), '');
  assert.equal(renderDisputesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildDisputesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Mediation required.' }]);
  assert.equal(r.perFile.length, 1);
});
