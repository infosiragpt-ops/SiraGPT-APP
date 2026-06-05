const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildPlan,
  detectFormat,
  validateDocument,
  INTERNAL,
} = require('../src/services/document-pipeline/advanced-document-pipeline');

test('advanced document pipeline: Word requests with mixed Excel/PDF wording stay DOCX', () => {
  const prompt = [
    'Genera un Word profesional de alta complejidad sobre gestión de riesgos de IA:',
    'incluye tabla Excel comparativa dentro del documento, menciona PDF solo como insumo,',
    'agrega índice, metodología, matriz de riesgos, conclusiones y recomendaciones.',
  ].join(' ');

  assert.equal(detectFormat(prompt), 'docx');
  assert.equal(detectFormat('Convierte mi Word a PDF profesional'), 'pdf');
});

test('advanced document pipeline: generated DOCX satisfies semantic Word quality gates', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'siragpt-word-quality-'));
  const prompt = [
    'Genera un Word profesional de alta complejidad sobre gestión de riesgos de IA:',
    'incluye tabla Excel comparativa dentro del documento, menciona PDF solo como insumo,',
    'agrega índice, metodología, matriz de riesgos, conclusiones y recomendaciones.',
  ].join(' ');

  const plan = buildPlan({
    prompt,
    format: 'docx',
    template: 'business',
    complexity: 'high',
  });

  assert.ok(plan.sections.includes('Metodología'));
  assert.ok(plan.sections.includes('Matriz de riesgos'));
  assert.ok(plan.sections.includes('Recomendaciones'));
  assert.deepEqual(plan.qualityTargets.requiredSections, ['Metodología', 'Matriz de riesgos', 'Conclusiones', 'Recomendaciones']);
  assert.ok(plan.qualityTargets.requiredTerms.includes('IA'));
  assert.ok(plan.qualityTargets.requiredTerms.includes('riesgos'));

  const artifact = await INTERNAL.buildDocumentFile({ plan, outputDir });
  const expected = INTERNAL.expectedFor(plan.format, plan.template, plan.complexity, plan);
  const validation = validateDocument({ format: 'docx', buffer: artifact.buffer, expected });

  assert.equal(validation.passed, true);
  assert.equal(validation.checks.requiredSections, true);
  assert.equal(validation.checks.requiredTerms, true);
  assert.equal(validation.checks.table, true);
  assert.ok(validation.details.paragraphs >= expected.minParagraphs);
  assert.ok(validation.details.tables >= 1);
  assert.deepEqual(validation.details.missingSections, []);
  assert.deepEqual(validation.details.missingTerms, []);
});
