'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAddSlidesIntent,
  parseOfficeUserIntent,
  parseStructuralAppendIntent,
  buildAddSlideOperations,
  buildAddSectionOperations,
  repairOfficeTypos,
  looksLikePromptDump,
} = require('../src/services/document-editing/user-intent-parser');

describe('office user-intent parser — general structural append', () => {
  test('repairs common office typos without assuming a subject', () => {
    const repaired = repairOfficeTypos('5 slaind y bliografia de forma profeiosnal');
    assert.match(repaired, /slides/);
    assert.match(repaired, /bibliografia/);
    assert.match(repaired, /profesional/);
  });

  test('owner phrasing: N slides, last bibliography, same file', () => {
    const intent = parseAddSlidesIntent(
      'en esta misma ppt agrega 5 slaind mas sobre ejemplos y 1 de bibliografi',
    );
    assert.equal(intent.kind, 'add_slides');
    assert.equal(intent.count, 5);
    assert.equal(intent.lastIsBibliography, true);
    assert.equal(intent.sameDocument, true);
    assert.match(intent.topic, /ejemplos/);
  });

  test('live prompt: 5 ppts más, estas mimas, casos de éxito, APA 7', () => {
    const prompt = 'agrega 5 ppts mas en estas mimas diapositivas ## Gestion_amdinistrativa.pptx que hablen sobre ejemplos de casos de exito y la ultima d elas 5 que sean sobre bibliografia en apa 7ma edicion';
    const intent = parseAddSlidesIntent(prompt);
    assert.equal(intent.count, 5);
    assert.equal(intent.lastIsBibliography, true);
    assert.equal(intent.sameDocument, true);
    assert.equal(intent.citationStyle, 'apa7');
    assert.match(intent.topic, /casos de exito/);
    const ops = buildAddSlideOperations(intent, {
      sourceText: 'Gestión administrativa\nEl ciclo planificar-organizar-dirigir-controlar reduce incertidumbre',
      originalName: 'Gestion_amdinistrativa.pptx',
      requestText: prompt,
    });
    assert.equal(ops.length, 5);
    assert.ok(ops.slice(0, 4).every((op) => /Caso de éxito/i.test(op.title)));
    assert.match(ops[4].title, /APA 7/i);
    assert.match(ops[4].bullets.join(' '), /American Psychological Association/);
    assert.doesNotMatch(JSON.stringify(ops), /Cómo se implementa ejemplos/);
  });

  test('works for any topic — marketing, onboarding, clinical', () => {
    const marketing = parseAddSlidesIntent('en esta misma ppt agrega 4 slides sobre funnel de conversion');
    assert.equal(marketing.count, 4);
    assert.equal(marketing.lastIsBibliography, false);
    assert.match(marketing.topic, /funnel de conversion/);

    const clinic = parseAddSlidesIntent('agrega 3 diapositivas sobre triaje pediatrico y la ultima es bibliografia');
    assert.equal(clinic.count, 3);
    assert.equal(clinic.lastIsBibliography, true);
    assert.match(clinic.topic, /triaje pediatrico/);
  });

  test('single new slide about a precise topic', () => {
    const intent = parseAddSlidesIntent('agrega una diapositiva sobre matriz de riesgos de IA');
    assert.equal(intent.count, 1);
    assert.equal(intent.lastIsBibliography, false);
    assert.match(intent.topic, /matriz de riesgos/);
  });

  test('filename topic wins over generic placeholder titles for any subject', () => {
    const intent = parseAddSlidesIntent('en esta misma ppt agrega 5 slides mas sobre ejemplos y 1 de bibliografia');
    const ops = buildAddSlideOperations(intent, {
      sourceText: 'Título viejo\nContenido base',
      originalName: 'Funnel_conversion_Q3.pptx',
    });
    assert.equal(ops.length, 5);
    assert.match(ops[0].title, /Funnel|conversion|Ejemplo/i);
    assert.equal(ops[4].title, 'Referencias bibliográficas');
    assert.doesNotMatch(JSON.stringify(ops), /Título viejo/);
    assert.doesNotMatch(JSON.stringify(ops), /Chiavenato|Pyme comercial/);
  });

  test('grounds example slides in the source document, not a hardcoded domain pack', () => {
    const intent = parseOfficeUserIntent(
      'en esta misma ppt agrega 5 slaind mas sobre ejemplos y 1 de bibliografia',
      { format: 'pptx' },
    );
    const ops = buildAddSlideOperations(intent, {
      sourceText: 'Retención de cohortes\nEl churn del canal orgánico bajó 4 puntos en marzo\nSmith (2022)',
      originalName: 'retencion-cohortes.pptx',
    });
    assert.equal(ops.length, 5);
    assert.equal(ops[4].title, 'Referencias bibliográficas');
    assert.match(JSON.stringify(ops.slice(0, 4)), /churn|cohortes|Retenci/i);
    assert.match(ops[4].bullets.join(' '), /Smith \(2022\)/);
    const blob = JSON.stringify(ops);
    assert.equal(looksLikePromptDump(blob), false);
    assert.doesNotMatch(blob, /Contenido agregado|Chiavenato|ANEXOS/);
  });

  test('Word: N sections + last bibliography on the same document', () => {
    const intent = parseStructuralAppendIntent(
      'en este mismo word agrega 5 secciones sobre ejemplos y 1 de bibliografia',
      { format: 'docx' },
    );
    assert.equal(intent.kind, 'add_sections');
    assert.equal(intent.count, 5);
    assert.equal(intent.lastIsBibliography, true);
    const ops = buildAddSectionOperations(intent, {
      sourceText: 'Protocolo de alta temprana\nCriterio de seguridad al egreso',
      originalName: 'protocolo-alta.docx',
    });
    assert.equal(ops.length, 5);
    assert.ok(ops.every((op) => op.kind === 'append_section'));
    assert.equal(ops[4].sectionTitle, 'Referencias bibliográficas');
  });

  test('replace+append requests still parse the add-slide half', () => {
    const intent = parseAddSlidesIntent(
      'reemplaza "Título viejo" por "Título nuevo" y agrega una diapositiva sobre matriz de riesgos de IA',
    );
    assert.equal(intent.count, 1);
    assert.match(intent.topic, /matriz de riesgos/);
  });
});
