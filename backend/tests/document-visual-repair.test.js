'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { INTERNAL } = require('../src/services/document-pipeline/advanced-document-pipeline');

const { highSeverityVisualDefects, applyVisualCritiqueToPlan, repairPlan } = INTERNAL;

test('highSeverityVisualDefects ignores skipped reports and non-high items', () => {
  assert.deepEqual(highSeverityVisualDefects({ skipped: true }), []);
  assert.deepEqual(highSeverityVisualDefects({
    skipped: false,
    report: {
      defects: [
        { page: 1, defect: 'mitad inferior en blanco', severity: 'high' },
        { page: 2, defect: 'margen justo', severity: 'low' },
      ],
    },
  }), [{ page: 1, defect: 'mitad inferior en blanco', severity: 'high' }]);
});

test('applyVisualCritiqueToPlan drops blank PPTX slides and records notes', () => {
  const plan = {
    format: 'pptx',
    complexity: 'standard',
    sections: ['Intro', 'Riesgos'],
    slidePlan: {
      slides: [
        { role: 'cover', title: 'Portada' },
        { role: 'content', title: 'Intro' },
        { role: 'content', title: 'Vacía' },
        { role: 'closing', title: 'Cierre' },
      ],
      manifest: { totalSlides: 4, contentSlides: 2 },
    },
  };
  const critique = {
    skipped: false,
    report: {
      overall: 'needs_work',
      defects: [
        { page: 3, defect: 'lámina casi en blanco', severity: 'high', suggestion: 'llenar o quitar la lámina' },
      ],
    },
  };
  const next = applyVisualCritiqueToPlan(plan, critique);
  assert.equal(next.repairedFromVisual, true);
  assert.equal(next.complexity, 'high');
  assert.equal(next.slidePlan.slides.length, 3);
  assert.equal(next.slidePlan.slides.some((s) => s.title === 'Vacía'), false);
  assert.equal(next.slidePlan.manifest.totalSlides, 3);
  assert.ok(next.visualRepairNotes[0].includes('llenar o quitar'));
});

test('repairPlan still rebuilds a PPTX after visual notes are attached', () => {
  const plan = applyVisualCritiqueToPlan({
    format: 'pptx',
    title: 'Gestión',
    userRequest: 'Crea una PPT en 6 diapositivas sobre gestión de empresas. Debe incluir riesgos.',
    template: 'business',
    complexity: 'standard',
    sections: ['Contexto', 'Riesgos', 'Plan'],
    blocks: [],
    slideTarget: 6,
    presentationBrief: { mustInclude: ['riesgos'] },
  }, {
    skipped: false,
    report: {
      defects: [{ page: 1, defect: 'texto cortado', severity: 'high', suggestion: 'reducir el cuerpo' }],
    },
  });
  const repaired = repairPlan(plan, { passed: false, details: { visualCritique: { overall: 'needs_work' } } });
  assert.equal(repaired.repairedFromVisual, true);
  assert.ok(repaired.slidePlan);
  assert.ok(Array.isArray(repaired.slidePlan.slides));
  assert.ok(repaired.slidePlan.slides.length >= 2);
});
