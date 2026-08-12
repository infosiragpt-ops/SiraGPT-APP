'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAddSlidesIntent,
  parseOfficeUserIntent,
  buildAddSlideOperations,
  repairOfficeTypos,
  looksLikePromptDump,
} = require('../src/services/document-editing/user-intent-parser');

describe('office user-intent parser — PPT slide append', () => {
  test('repairs slaind / bibliografi / amdinistrativa', () => {
    const repaired = repairOfficeTypos('5 slaind de gestion amdinistrativa y bliografia');
    assert.match(repaired, /slides/);
    assert.match(repaired, /administrativa/);
    assert.match(repaired, /bibliografia/);
  });

  test('owner phrasing: 5 slides on examples, last is bibliography', () => {
    const intent = parseAddSlidesIntent(
      'en esta misma ppt agrega 5 slaind mas sobre ejemplos y 1 de bibliografi',
    );
    assert.equal(intent.kind, 'add_slides');
    assert.equal(intent.count, 5);
    assert.equal(intent.lastIsBibliography, true);
    assert.equal(intent.sameDocument, true);
    assert.match(intent.topic, /ejemplos/);
  });

  test('explicit "la última es bibliografía" keeps count at 5', () => {
    const intent = parseAddSlidesIntent(
      'agrega 5 diapositivas de ejemplos y de las 5 la ultima es bibliografia',
    );
    assert.equal(intent.count, 5);
    assert.equal(intent.lastIsBibliography, true);
  });

  test('single new slide about a topic', () => {
    const intent = parseAddSlidesIntent('agrega una diapositiva sobre matriz de riesgos de IA');
    assert.equal(intent.count, 1);
    assert.equal(intent.lastIsBibliography, false);
    assert.match(intent.topic, /matriz de riesgos/);
  });

  test('filename gestión administrativa wins over generic slide titles', () => {
    const intent = parseAddSlidesIntent('en esta misma ppt agrega 5 slides mas sobre ejemplos y 1 de bibliografia');
    const ops = buildAddSlideOperations(intent, {
      sourceText: 'Título viejo\nContenido base',
      originalName: 'Gestion_amdinistrativa.pptx',
    });
    assert.equal(ops.length, 5);
    assert.ok(ops.slice(0, 4).every((op) => /Caso/.test(op.title)));
    assert.doesNotMatch(JSON.stringify(ops), /Título viejo/);
  });

  test('builds 5 professional slides grounded in gestión administrativa', () => {
    const intent = parseOfficeUserIntent(
      'en esta misma ppt agrega 5 slaind mas sobre ejemplos y 1 de bibliografia',
      { format: 'pptx' },
    );
    const ops = buildAddSlideOperations(intent, {
      sourceText: 'BRIEFING EJECUTIVO\nGestión administrativa',
      originalName: 'Gestion_amdinistrativa.pptx',
    });
    assert.equal(ops.length, 5);
    assert.equal(ops[4].title, 'Referencias bibliográficas');
    assert.ok(ops[4].bullets.some((item) => /Chiavenato|Robbins|ISO 9001/.test(item)));
    assert.ok(ops.slice(0, 4).every((op) => /Caso/.test(op.title)));
    const blob = JSON.stringify(ops);
    assert.equal(looksLikePromptDump(blob), false);
    assert.doesNotMatch(blob, /Contenido agregado/);
  });

  test('replace+append requests still parse the add-slide half', () => {
    const intent = parseAddSlidesIntent(
      'reemplaza "Título viejo" por "Título nuevo" y agrega una diapositiva sobre matriz de riesgos de IA',
    );
    assert.equal(intent.count, 1);
    assert.match(intent.topic, /matriz de riesgos/);
  });
});
