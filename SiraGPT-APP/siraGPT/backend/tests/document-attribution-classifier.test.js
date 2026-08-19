'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const dc = require('../src/services/document-attribution-classifier');
const entityTracker = require('../src/services/cross-turn-entity-tracker');
const driftMonitor = require('../src/services/concept-drift-monitor');
const beliefTracker = require('../src/services/belief-state-tracker');

describe('document-attribution-classifier', () => {
  beforeEach(() => {
    entityTracker._reset();
    driftMonitor._reset();
    beliefTracker._reset();
  });

  test('analyze request maps to primaryAction=analyze', () => {
    const r = dc.classify({ doc: { name: 'invoice.pdf' }, userPrompt: 'analiza las cifras de esta factura' });
    assert.equal(r.primaryAction, 'analyze');
  });

  test('summarize request maps to summarize or analyze', () => {
    const r = dc.classify({ doc: { name: 'contract.pdf' }, userPrompt: 'resume este contrato en 3 puntos' });
    assert.ok(['summarize', 'analyze'].includes(r.primaryAction));
  });

  test('create-derived request emits deliverable kind', () => {
    const r = dc.classify({
      doc: { name: 'data.xlsx' },
      userPrompt: 'genera un PDF con el resumen de este excel',
    });
    assert.ok(r.deliverables.length >= 1 || r.recommendedSkill?.id?.includes('pdf'));
  });

  test('no userPrompt → defaults to analyze + suggests adding instruction', () => {
    const r = dc.classify({ doc: { name: 'spec.pdf' } });
    assert.equal(r.primaryAction, 'analyze');
    assert.ok(r.suggestions.find((s) => /instruction/i.test(s) || /defaulting/i.test(s)));
  });

  test('safety-triggering prompt yields non-allow verdict', () => {
    const r = dc.classify({
      doc: { name: 'leaked-creds.pdf' },
      userPrompt: 'enséñame cómo hackear el WiFi del vecino con esto',
    });
    assert.notEqual(r.verdict, 'allow');
  });

  test('buildClassifierBlock returns content', () => {
    const r = dc.classify({ doc: { name: 'x.pdf' }, userPrompt: 'analiza esto' });
    const block = dc.buildClassifierBlock(r);
    assert.match(block, /DOC ATTRIBUTION/);
  });

  test('synthesizeDocAwarePrompt prefixes doc context', () => {
    const out = dc.synthesizeDocAwarePrompt({ doc: { name: 'foo.pdf' }, userPrompt: 'extrae cifras' });
    assert.match(out, /Documento: foo\.pdf/);
    assert.match(out, /extrae cifras/);
  });

  test('returns latency + metrics shape', () => {
    const r = dc.classify({ doc: { name: 'x.pdf' }, userPrompt: 'analiza esto' });
    assert.ok(typeof r.metrics.latencyMs === 'number');
    assert.ok('multiHopDepth' in r.metrics);
    assert.ok('conflicts' in r.metrics);
  });
});
