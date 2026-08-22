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
const { isSdieV2Enabled, truthyFlag } = require('../src/services/sdie/flags');
const { shouldSkipRetrieveEvidence } = require('../src/services/sdie/request-spec');
const {
  buildUploadedFileContext,
  shouldSkipRetrieveEvidenceForQuery,
} = require('../src/services/message-attachments');

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

  it('honours FEATURE_SDIE_V2 with live FEATURE_* style (1/true/on)', () => {
    assert.equal(truthyFlag('1'), true);
    assert.equal(truthyFlag('true'), true);
    assert.equal(truthyFlag('on'), true);
    assert.equal(truthyFlag('0'), false);
    assert.equal(truthyFlag('false'), false);
    assert.equal(truthyFlag('off'), false);
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: '0' }), false);
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: 'false' }), false);
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: '1' }), true);
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: 'true' }), true);
    assert.equal(isSdieV2Enabled({ FEATURE_SDIE_V2: 'on' }), true);
    assert.equal(isSdieV2Enabled({}), true);
  });
});

describe('SDIE v2 Phase 1 · retrieveEvidence bypass', () => {
  it('skips documentIntelligence.retrieveEvidence for summarize_full', () => {
    assert.equal(shouldSkipRetrieveEvidence(SCREENSHOT_PROMPT), true);
    assert.equal(shouldSkipRetrieveEvidenceForQuery(SCREENSHOT_PROMPT), true);
    assert.equal(shouldSkipRetrieveEvidence('extrae el DOI del tercer estudio'), false);
    assert.equal(shouldSkipRetrieveEvidence(SCREENSHOT_PROMPT, { FEATURE_SDIE_V2: '0' }), false);
  });

  it('buildUploadedFileContext does not call retrieveEvidence for «dame un resumen en un solo párrafo»', async () => {
    const rows = [{
      id: 'file-narrative',
      filename: 'Formato_para_el_articulo_de_revision_narrativa.docx',
      originalName: 'Formato_para_el_articulo_de_revision_narrativa.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractedText: FIXTURE,
      openaiFileId: null,
      documentAnalysis: {
        id: 'analysis-1',
        summary: 'Incluir la imagen del reporte de similitud',
        chunkCount: 2,
        chunks: [
          { ordinal: 1, sectionTitle: 'Portada', text: 'Incluir la imagen del reporte de similitud con el porcentaje de coincidencia.' },
          { ordinal: 2, sectionTitle: 'Matriz', text: 'Matriz de sistematización de los treinta estudios incluidos.' },
        ],
        tables: [],
      },
    }];
    const prisma = {
      file: {
        findMany: async ({ where }) => {
          const wanted = new Set((where?.id?.in || []).map(String));
          return rows.filter((row) => wanted.has(row.id));
        },
      },
    };

    let retrieveCalls = 0;
    const context = await buildUploadedFileContext(prisma, {
      userId: 'user-1',
      fileIds: ['file-narrative'],
      query: SCREENSHOT_PROMPT,
      maxChars: 24000,
      retrieveEvidenceFn: async () => {
        retrieveCalls += 1;
        return [{
          id: 'bad',
          sectionTitle: 'Portada',
          text: 'Incluir la imagen del reporte de similitud con el porcentaje de coincidencia.',
        }];
      },
    });

    assert.equal(retrieveCalls, 0);
    assert.doesNotMatch(context, /Contenido relevante recuperado/);
    assert.doesNotMatch(context, /Evidencia 1/);
    assert.doesNotMatch(context, /Primeras referencias estructuradas/);
    assert.match(context, /revisi[oó]n narrativa|ansiedad|estudios/i);

    let extractCalls = 0;
    const extractContext = await buildUploadedFileContext(prisma, {
      userId: 'user-1',
      fileIds: ['file-narrative'],
      query: 'extrae el DOI del tercer estudio',
      maxChars: 24000,
      retrieveEvidenceFn: async () => {
        extractCalls += 1;
        return [{ id: 'doi', sectionTitle: 'Refs', text: 'DOI 10.1234/example' }];
      },
    });
    assert.equal(extractCalls, 1);
    assert.match(extractContext, /DOI 10\.1234\/example/);

    let flagOffCalls = 0;
    await buildUploadedFileContext(prisma, {
      userId: 'user-1',
      fileIds: ['file-narrative'],
      query: SCREENSHOT_PROMPT,
      maxChars: 24000,
      env: { FEATURE_SDIE_V2: '0' },
      retrieveEvidenceFn: async () => {
        flagOffCalls += 1;
        return [{ id: 'bad', text: 'Incluir la imagen del reporte de similitud' }];
      },
    });
    assert.equal(flagOffCalls, 1);
  });
});

describe('SDIE v2 Phase 1 · wiring', () => {
  it('inserts SDIE in ai.js after enrichment and not in the OOXML edit slot', () => {
    const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
    const stream = fs.readFileSync(path.join(__dirname, '../src/services/agentic-chat-stream.js'), 'utf8');
    const attachments = fs.readFileSync(path.join(__dirname, '../src/services/message-attachments.js'), 'utf8');

    assert.match(ai, /runSdieTurn/);
    assert.match(ai, /AFTER file context \+ RAG \+ enrichment/);
    assert.match(ai, /BEFORE agentic gate/);
    assert.doesNotMatch(stream, /runSdieTurn/);
    assert.match(attachments, /shouldSkipRetrieveEvidenceForQuery/);
    assert.match(attachments, /skipTopKEvidence/);
  });
});
