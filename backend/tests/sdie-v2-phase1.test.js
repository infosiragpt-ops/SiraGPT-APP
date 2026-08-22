'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sdie = require('../src/services/sdie');
const { compileIntent, shouldHandle } = require('../src/services/sdie/request-spec');
const { validateAnswer, splitParagraphs, hasHeading, hasBullets } = require('../src/services/sdie/validators');
const { isEditorialLine, collectEditorialSnippets } = require('../src/services/sdie/editorial');
const { assertDeepSeekOnly } = require('../src/services/sdie/generate');
const { isSdieV2Enabled } = require('../src/services/sdie/flags');

const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'sdie-narrative-review-template.txt'),
  'utf8',
);

const SCREENSHOT_PROMPT = 'dame un resumen en un solo párrafo';

const CONTAMINATED_SCREENSHOT_ANSWER = [
  'Formato para el artículo de revisión narrativa',
  '',
  'Incluir la imagen del reporte de similitud con el porcentaje de coincidencia.',
  '',
  'Matriz de sistematización de los treinta estudios incluidos.',
].join('\n');

function fixtureFiles() {
  return [{
    originalName: 'Formato_para_el_articulo_de_revision_narrativa.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extractedText: FIXTURE,
  }];
}

describe('SDIE v2 Phase 1 · intent compiler', () => {
  it('compiles «dame un resumen en un solo párrafo» to summarize_full + 1 paragraph', () => {
    const spec = compileIntent(SCREENSHOT_PROMPT);
    assert.equal(spec.version, 2);
    assert.equal(spec.intent, 'summarize');
    assert.equal(spec.strategy, 'summarize_full');
    assert.equal(spec.scope.coverage, 'full');
    assert.equal(spec.scope.excludeEditorial, true);
    assert.equal(spec.output.paragraphs, 1);
    assert.equal(spec.output.headings, false);
    assert.equal(spec.output.bullets, false);
    assert.equal(spec.output.language, 'es');
    assert.equal(spec.grounding.untrustedDocument, true);
    assert.equal(spec.grounding.allowInvention, false);
    assert.equal(sdie.shouldSkipTopK(spec), true);
  });

  it('detects English single-paragraph summaries', () => {
    const spec = compileIntent('please summarize this document in one paragraph');
    assert.equal(spec.intent, 'summarize');
    assert.equal(spec.output.paragraphs, 1);
    assert.equal(spec.output.language, 'en');
    assert.equal(spec.strategy, 'summarize_full');
  });

  it('honours an explicit paragraph count', () => {
    const spec = compileIntent('dame un resumen de este documento en 3 párrafos');
    assert.equal(spec.output.paragraphs, 3);
    assert.equal(spec.strategy, 'summarize_full');
  });

  it('does not claim Word transforms or new deliverables', () => {
    assert.equal(shouldHandle({ prompt: 'borra el jurado evaluador', files: fixtureFiles() }), false);
    assert.equal(shouldHandle({ prompt: 'hazme un Word con el resumen', files: fixtureFiles() }), false);
    assert.equal(shouldHandle({ prompt: SCREENSHOT_PROMPT, files: fixtureFiles() }), true);
    assert.equal(shouldHandle({ prompt: SCREENSHOT_PROMPT, files: [] }), false);
  });
});

describe('SDIE v2 Phase 1 · paragraph validator', () => {
  const spec = compileIntent(SCREENSHOT_PROMPT);

  it('accepts exactly one synthesizing paragraph', () => {
    const answer = 'La revisión narrativa sintetiza evidencia clínica de treinta estudios y concluye que los programas estructurados reducen la ansiedad adolescente cuando se implementan con supervisión.';
    const result = validateAnswer(answer, spec, { editorial: [] });
    assert.equal(result.ok, true);
    assert.equal(result.paragraphs.length, 1);
    assert.equal(hasHeading(answer), false);
    assert.equal(hasBullets(answer), false);
  });

  it('rejects headings, bullets, and the wrong paragraph count', () => {
    assert.equal(validateAnswer('# Resumen\n\nTexto de síntesis clínica que cubre métodos y resultados con suficiente detalle.', spec).ok, false);
    assert.equal(validateAnswer('- punto uno\n- punto dos de la evidencia clínica publicada en la década reciente.', spec).ok, false);
    const two = validateAnswer(
      'Primer párrafo de síntesis clínica con métodos y hallazgos relevantes.\n\nSegundo párrafo adicional que no fue solicitado.',
      spec,
    );
    assert.equal(two.ok, false);
    assert.ok(two.violations.some((v) => v.code === 'paragraph_count'));
    assert.equal(splitParagraphs('uno.\n\ndos.').length, 2);
  });

  it('rejects editorial contamination from the uploaded template', () => {
    const editorial = collectEditorialSnippets(FIXTURE);
    assert.ok(editorial.some((line) => /similitud/i.test(line)));
    const result = validateAnswer(CONTAMINATED_SCREENSHOT_ANSWER, spec, { editorial });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'editorial_contamination'));
  });
});

describe('SDIE v2 Phase 1 · screenshot fixture', () => {
  it('tags template instructions as untrusted editorial, not evidence', () => {
    assert.equal(isEditorialLine('Incluir la imagen del reporte de similitud con el porcentaje de coincidencia.'), true);
    assert.equal(isEditorialLine('Matriz de sistematización de los treinta estudios incluidos.'), true);
    assert.equal(isEditorialLine('Los estudios coinciden en que la intervención reduce la sintomatología ansiosa.'), false);
  });

  it('walks every section (no top-k) and returns one clean paragraph', async () => {
    const result = await sdie.runSdieTurn({
      prompt: SCREENSHOT_PROMPT,
      files: fixtureFiles(),
      surface: 'chat',
      complete: async () => CONTAMINATED_SCREENSHOT_ANSWER,
    });

    assert.equal(result.handled, true, JSON.stringify(result.generated || result.reason));
    assert.equal(result.spec.output.paragraphs, 1);
    assert.equal(result.plan.useTopK, false);
    assert.ok(result.plan.sectionNotes.length >= 3, 'must walk intro/methods/results/conclusion');
    assert.equal(result.plan.coverage, 'full');

    const answer = result.answer;
    assert.equal(typeof answer, 'string');
    assert.equal(splitParagraphs(answer).length, 1);
    assert.equal(hasHeading(answer), false);
    assert.equal(hasBullets(answer), false);
    assert.doesNotMatch(answer, /Incluir la imagen del reporte de similitud/i);
    assert.doesNotMatch(answer, /Matriz de sistematizaci[oó]n/i);
    assert.doesNotMatch(answer, /Formato para el art[ií]culo/i);
    assert.match(answer, /revisi[oó]n narrativa|estudios|ansiedad|evidencia/i);
    assert.ok(answer.length >= 80);
  });

  it('does not intercept FEATURE_DOC_ENGINE-style edit turns', async () => {
    const result = await sdie.runSdieTurn({
      prompt: 'borra el jurado evaluador del documento',
      files: fixtureFiles(),
    });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'not_sdie_turn');
  });
});

describe('SDIE v2 Phase 1 · DeepSeek-only + flag', () => {
  it('rejects OpenRouter and non-DeepSeek model ids', () => {
    assert.throws(() => assertDeepSeekOnly('openrouter/deepseek-v4-flash'), /DeepSeek/);
    assert.throws(() => assertDeepSeekOnly('openai/gpt-4o'), /DeepSeek/);
    assert.equal(assertDeepSeekOnly('deepseek-v4-flash'), 'deepseek-v4-flash');
    assert.equal(assertDeepSeekOnly('deepseek-v4-pro'), 'deepseek-v4-pro');
  });

  it('honours FEATURE_SDIE_V2=0', () => {
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: '0' }), false);
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: '1' }), true);
    assert.equal(isSdieV2Enabled({}), true);
  });
});
