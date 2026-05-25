'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ce = require('../src/services/concept-extractor');

describe('concept-extractor', () => {
  test('returns empty result on empty input', () => {
    const r = ce.extractConcepts('');
    assert.equal(r.concepts.length, 0);
    assert.equal(r.language, 'unknown');
  });

  test('detects Spanish action and entity', () => {
    const r = ce.extractConcepts('Por favor crea un nuevo componente en el frontend.');
    assert.equal(r.language, 'es');
    assert.ok(r.concepts.some((c) => c.type === 'action' && c.normalized === 'create'));
    assert.ok(r.concepts.some((c) => c.type === 'entity' && c.normalized === 'ui'));
  });

  test('detects English action and code entity', () => {
    const r = ce.extractConcepts('Please fix the bug in the function login()');
    assert.equal(r.language, 'en');
    assert.ok(r.concepts.some((c) => c.type === 'action' && c.normalized === 'fix'));
    assert.ok(r.concepts.some((c) => c.type === 'entity' && c.normalized === 'code'));
  });

  test('extracts constraint (negation)', () => {
    const c = ce.extractConstraints('no modifiques la UI ni cambies los estilos');
    assert.ok(c.some((x) => x.kind === 'constraint.negation'));
  });

  test('extracts references (anaphora)', () => {
    const refs = ce.extractReferences('Como te dije antes, eso no funciona aún');
    assert.ok(refs.length >= 1);
  });

  test('extracts goal phrase', () => {
    const g = ce.extractGoals('Necesito que generes un PDF con el resumen del mes');
    assert.ok(g.length >= 1);
    assert.match(g[0].surface, /PDF/i);
  });

  test('dedup merges duplicate concepts and bumps weight', () => {
    const merged = ce.mergeConcepts(
      ce.extractActions('crea crea crea'),
      ce.extractActions('crea'),
    );
    const create = merged.find((c) => c.normalized === 'create');
    assert.ok(create);
    assert.ok(create.weight > 0.4);
  });

  test('conceptDistance is 0 for identical sets and 1 for disjoint sets', () => {
    const a = ce.extractConcepts('crea un componente nuevo').concepts;
    const b = ce.extractConcepts('busca información del cliente').concepts;
    const same = ce.conceptDistance(a, a);
    const diff = ce.conceptDistance(a, b);
    assert.equal(same, 0);
    assert.ok(diff > 0);
  });

  test('detects modality question and command', () => {
    const q = ce.extractModality('¿Qué es esto?');
    assert.ok(q.some((m) => m.normalized === 'question'));
    const c = ce.extractModality('Crea el archivo ahora');
    assert.ok(c.some((m) => m.normalized === 'command'));
  });

  test('extracts file paths and named entities', () => {
    const r = ce.extractEntities('Look at backend/src/routes/ai.js and update Login component');
    assert.ok(r.some((e) => e.kind === 'entity.path' && e.surface.endsWith('ai.js')));
    assert.ok(r.some((e) => e.kind === 'entity.named'));
  });

  test('describeConcept produces readable label', () => {
    const [c] = ce.extractActions('arregla el bug');
    assert.match(ce.describeConcept(c), /action/);
  });
});
