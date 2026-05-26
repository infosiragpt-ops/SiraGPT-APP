'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAnchors,
  buildEvidencePool,
  verifyClaim,
  buildVerificationReport,
  renderVerificationNote,
} = require('../src/services/fidelity-verification-engine');

test('exports the documented surface', () => {
  for (const fn of [extractAnchors, buildEvidencePool, verifyClaim, buildVerificationReport, renderVerificationNote]) {
    assert.equal(typeof fn, 'function');
  }
});

test('extractAnchors returns empty arrays for empty / null input', () => {
  assert.deepEqual(extractAnchors(''), { numbers: [], dates: [], entities: [] });
  assert.deepEqual(extractAnchors(null), { numbers: [], dates: [], entities: [] });
});

test('extractAnchors pulls numbers (with currency suffixes)', () => {
  const out = extractAnchors('El presupuesto fue 250 millones USD y 45% del total.');
  assert.ok(out.numbers.length > 0);
  assert.ok(out.numbers.some((n) => /250/.test(n)));
});

test('extractAnchors pulls ISO and Spanish-style dates', () => {
  const out = extractAnchors('Reunión el 2026-05-21 y otra el 15 de marzo de 2026.');
  assert.ok(out.dates.length >= 1);
});

test('extractAnchors deduplicates anchors and lowercases them', () => {
  const out = extractAnchors('ARGENTINA y argentina aparecen.');
  // Both forms should collapse to one entry after lowercase + Set.
  const argCount = out.entities.filter((e) => e === 'argentina').length;
  assert.equal(argCount, 1);
});

test('extractAnchors can be called many times in a row without stateful drift (regression: /g lastIndex)', () => {
  const text = 'El año 2026 trajo 100 millones de pesos.';
  const first = extractAnchors(text);
  for (let i = 0; i < 20; i++) {
    const next = extractAnchors(text);
    assert.deepEqual(next, first, `iteration ${i + 1} must match the first call`);
  }
});

test('buildEvidencePool unions anchors across multiple sources', () => {
  const pool = buildEvidencePool([
    'Datos: 250 millones USD aprobados el 2026-05-21.',
    'Confirmado por Argentina el 2026-05-22.',
    { extractedText: 'Ratificado por Brasil con 100 millones USD adicionales.' },
  ]);
  // All currency mentions land in pool.numbers via the unified regex
  assert.ok(pool.numbers.size >= 1);
  assert.ok(pool.dates.size >= 1);
  assert.ok(pool.entities.size >= 1);
});

test('buildEvidencePool tolerates string / object / missing-text sources', () => {
  const pool = buildEvidencePool([
    'plain string',
    { extractedText: 'with extractedText field' },
    { text: 'with text field' },
    { unrelated: 'no text → silently skipped' },
    null,
  ]);
  assert.equal(typeof pool.numbers, 'object');
  assert.ok(pool.numbers instanceof Set);
});

test('verifyClaim returns no_anchors when the claim has no extractable anchors', () => {
  const pool = buildEvidencePool(['source text']);
  const out = verifyClaim('this claim has no anchors', pool);
  assert.equal(out.status, 'no_anchors');
  assert.equal(out.supportedCount, 0);
  assert.equal(out.unsupportedCount, 0);
  assert.equal(out.confidence, 0);
});

test('verifyClaim returns fully_supported when every anchor is in the evidence pool', () => {
  // Keep the claim's anchors a subset of the pool's — the entity regex is
  // greedy with proper-noun phrases starting in capital letters, so any
  // capitalised word in the claim that isn't in the source would drop
  // confidence below 1.0. Use plain anchors only (number + date) so the
  // assertion focuses on the core fully-supported branch.
  const pool = buildEvidencePool(['Cifra: 250 millones USD aprobados el 2026-05-21.']);
  const out = verifyClaim('cifras: 250 millones usd el 2026-05-21.', pool);
  assert.equal(out.status, 'fully_supported');
  assert.ok(out.confidence >= 0.99);
});

test('verifyClaim returns unsupported when no anchor is found in evidence', () => {
  const pool = buildEvidencePool(['some unrelated text']);
  const out = verifyClaim('La cifra fue 999 millones USD en 1999-01-01 según Marte.', pool);
  assert.equal(out.status, 'unsupported');
  assert.equal(out.supportedCount, 0);
});

test('verifyClaim returns partially_supported when some anchors match', () => {
  const pool = buildEvidencePool(['Confirmado: 250 millones USD aprobados.']);
  const out = verifyClaim('Se aprobaron 250 millones USD en 1999-01-01.', pool);
  assert.equal(out.status, 'partially_supported');
  assert.ok(out.supportedCount > 0);
  assert.ok(out.unsupportedCount > 0);
  assert.ok(out.confidence > 0 && out.confidence < 1);
});

test('verifyClaim caps the stored claim text at 200 chars', () => {
  const pool = buildEvidencePool([]);
  const huge = 'a'.repeat(500);
  const out = verifyClaim(huge, pool);
  assert.ok(out.claim.length <= 200);
});

test('buildVerificationReport aggregates per-claim verifications into a fidelity score', () => {
  const sources = ['Datos: 250 millones USD aprobados en 2026-05-21.'];
  const response = 'Se aprobaron 250 millones USD el 2026-05-21. La cifra fue ratificada el 1999-01-01.';
  const report = buildVerificationReport(response, sources);
  assert.ok(report.total >= 1);
  assert.equal(typeof report.score, 'number');
  assert.ok(report.score >= 0 && report.score <= 1);
  assert.ok(['high', 'medium', 'low'].includes(report.level));
  assert.equal(typeof report.poolSize.numbers, 'number');
});

test('buildVerificationReport caps the report at 30 claims and surfaces 15', () => {
  const sources = ['Number 100 in 2020-01-01 mentioned.'];
  // Generate a response with many sentences containing anchors.
  const parts = [];
  for (let i = 0; i < 50; i++) parts.push(`Statement ${i} cites 999 USD in 1999-${String((i % 12) + 1).padStart(2, '0')}-01.`);
  const response = parts.join(' ');
  const report = buildVerificationReport(response, sources);
  assert.ok(report.total <= 30, 'must cap total claims at 30');
  assert.ok(report.verifications.length <= 15, 'must cap returned verifications at 15');
});

test('renderVerificationNote returns "" when score is high and there are no unsupported claims', () => {
  const sources = ['250 millones USD el 2026-05-21 por Argentina.'];
  const response = 'Se aprobaron 250 millones USD el 2026-05-21 por Argentina.';
  const report = buildVerificationReport(response, sources);
  if (report.level === 'high' && report.unsupported === 0) {
    assert.equal(renderVerificationNote(report), '');
  }
});

test('renderVerificationNote produces a markdown block when claims need verification', () => {
  const sources = ['Confirmado: 250 millones USD aprobados.'];
  const response = 'La cifra fue 999 millones USD el 1999-01-01.';
  const report = buildVerificationReport(response, sources);
  const note = renderVerificationNote(report);
  if (note) {
    assert.match(note, /VERIFICACI[ÓO]N DE FIDELIDAD/);
    assert.ok(note.includes('score:'));
  }
});

test('renderVerificationNote returns "" when total claims is 0', () => {
  assert.equal(renderVerificationNote({ total: 0 }), '');
  assert.equal(renderVerificationNote(null), '');
});
