'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attributeClaim,
  annotateClaims,
  renderAttributionSuffix,
  _internal,
} = require('../src/services/document-claim-attribution');

test('attributeClaim: empty / non-string input → null source, document type', () => {
  assert.deepEqual(attributeClaim('').sourceType, 'document');
  assert.equal(attributeClaim(null).source, null);
  assert.equal(attributeClaim(undefined).source, null);
  assert.equal(attributeClaim(42).source, null);
});

test('attributeClaim: "según X" picks up explicit Spanish attribution to a known person', () => {
  const r = attributeClaim('Según Maria Solís, los ingresos crecieron 24% en Q3.', {
    persons: ['Maria Solís', 'Pedro Rojas'],
  });
  assert.equal(r.source, 'Maria Solís');
  assert.equal(r.sourceType, 'person');
  assert.ok(r.confidence >= 0.9);
  assert.equal(r.anchor, 'según');
});

test('attributeClaim: "according to Acme Corp" maps to a known organization', () => {
  const r = attributeClaim('According to Acme Corp, revenue grew 24% in Q3 2026.', {
    organizations: ['Acme Corp', 'GlobalCo'],
  });
  assert.equal(r.source, 'Acme Corp');
  assert.equal(r.sourceType, 'org');
  assert.ok(r.confidence >= 0.9);
});

test('attributeClaim: explicit attribution to unknown subject still flagged', () => {
  const r = attributeClaim('Según el Banco Mundial, la inflación subió 5%.');
  // No entity list passed → still detected, sourceType=unknown.
  assert.equal(r.sourceType, 'unknown');
  assert.ok(r.source.toLowerCase().includes('banco mundial'));
  assert.equal(r.anchor, 'según');
});

test('attributeClaim: post-anchor verb pattern — "Acme states that…"', () => {
  const r = attributeClaim('Acme Corp reports that revenue grew 24%.', {
    organizations: ['Acme Corp'],
  });
  assert.equal(r.source, 'Acme Corp');
  assert.equal(r.sourceType, 'org');
  assert.equal(r.anchor, 'verb');
});

test('attributeClaim: Spanish post-anchor — "Pedro Rojas afirma…"', () => {
  const r = attributeClaim('Pedro Rojas afirma que el proyecto se entregará a tiempo.', {
    persons: ['Pedro Rojas'],
  });
  assert.equal(r.source, 'Pedro Rojas');
  assert.equal(r.sourceType, 'person');
});

test('attributeClaim: bare co-occurrence → lower confidence attribution', () => {
  const r = attributeClaim('El reporte menciona el contrato con Acme Corp.', {
    organizations: ['Acme Corp'],
  });
  assert.equal(r.source, 'Acme Corp');
  assert.equal(r.anchor, 'co-occurrence');
  assert.ok(r.confidence < 0.6);
});

test('attributeClaim: no entity, no anchor → falls back to "document"', () => {
  const r = attributeClaim('Revenue grew 24% in Q3 2026.');
  assert.equal(r.source, null);
  assert.equal(r.sourceType, 'document');
  assert.ok(r.confidence < 0.5);
});

test('attributeClaim: prefers explicit attribution over co-occurrence', () => {
  // Sentence mentions both "Maria" (anchored) and "Acme" (co-occurring).
  const r = attributeClaim('Según Maria Solís, el contrato con Acme Corp se firmó ayer.', {
    persons: ['Maria Solís'],
    organizations: ['Acme Corp'],
  });
  assert.equal(r.source, 'Maria Solís');
  assert.equal(r.sourceType, 'person');
});

test('attributeClaim: tolerates trailing function words in capture', () => {
  // The capture group greedily grabs through "en"; cleanCandidate should strip.
  const candidate = _internal.cleanCandidate('Acme Corp en');
  assert.equal(candidate, 'Acme Corp');
});

test('annotateClaims: maps over claim list preserving order', () => {
  const claims = [
    'Según Acme Corp, los ingresos subieron.',
    'Revenue stayed flat in Q4.',
  ];
  const out = annotateClaims(claims, { organizations: ['Acme Corp'] });
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'Acme Corp');
  assert.equal(out[0].sourceType, 'org');
  assert.equal(out[1].source, null);
  assert.equal(out[1].sourceType, 'document');
});

test('annotateClaims: tolerates malformed input', () => {
  assert.deepEqual(annotateClaims(null), []);
  assert.deepEqual(annotateClaims(undefined), []);
  assert.deepEqual(annotateClaims([null, undefined, 42]), []);
});

test('renderAttributionSuffix: empty for document/null sources', () => {
  assert.equal(renderAttributionSuffix(null), '');
  assert.equal(renderAttributionSuffix({ source: null, sourceType: 'document' }), '');
});

test('renderAttributionSuffix: renders italic suffix for resolved attributions', () => {
  assert.equal(
    renderAttributionSuffix({ source: 'Acme Corp', sourceType: 'org' }),
    ' — _organización: Acme Corp_',
  );
  assert.equal(
    renderAttributionSuffix({ source: 'Maria Solís', sourceType: 'person' }),
    ' — _persona: Maria Solís_',
  );
});

test('deep-analyzer integration: claims carry attribution suffix in rendered block', () => {
  const da = require('../src/services/document-deep-analyzer');
  const text = `Reporte de auditoría 2026.

Según Acme Corp, los ingresos crecieron 24% en Q3 2026.
Maria Solís afirma que el cierre contable se completó el 2026-04-30.`;
  const { perFile, aggregate } = da.buildDeepAnalysisForFiles([
    { originalName: 'audit.txt', extractedText: text },
  ]);
  const md = da.renderDeepAnalysisBlock({ perFile, aggregate });
  assert.ok(md.includes('organización: Acme Corp') || md.includes('persona: Maria Solís'),
    `expected an attribution suffix in the rendered block, got:\n${md}`);
});

test('deep-analyzer: claimAttributions array is attached to per-file reports', () => {
  const da = require('../src/services/document-deep-analyzer');
  const text = 'Según Acme Corp, los ingresos crecieron 24% en Q3 2026.';
  const { perFile } = da.buildDeepAnalysisForFiles([
    { originalName: 'note.txt', extractedText: text },
  ]);
  assert.ok(perFile.length >= 1);
  const r = perFile[0].report;
  assert.ok(Array.isArray(r.claimAttributions));
  if (r.claims.length > 0) {
    assert.ok(r.claimAttributions.length >= 1);
  }
});
