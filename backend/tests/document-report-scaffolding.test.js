'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { looksLikeReportExport, stripReportScaffolding } = require('../src/services/document-report-scaffolding');

// Shape of the Turnitin export Luis attached (cover + AI-writing overview, then the thesis).
const TURNITIN_EXPORT = [
  '202602 - DISTANCIA - H - LIMA NORTE - MAESTRÍA EN EDUCACIÓN - TRABAJO DE INVESTIGACIÓN II - A11 (Moodle TT).',
  '108236_YENY_ROSARIO_RODRIGUEZ_SOLANO_TRABAJO_DE_INVESTIGACION_14677794_1261054847.pdf',
  'Página 2 de 38 - Descripción general de la escritura con IA Identificador de la entrega trn:oid:::1:3718649943.',
  'El porcentaje indica la cantidad de texto calificado en la entrega que Es esencial comprender los límites de la detección de IA antes de tomar decisiones.',
  'Nuestra evaluación de escritura con IA está diseñada para ayudar a los académicos a identificar texto que podrían haberse preparado mediante una herramienta de IA generativa.',
  '38 páginas 12.730 palabras 70.746 caracteres',
  'Fecha de entrega 21 nov 2026, 7:54 p.m. GMT-5',
  'Página 3 de 38 - Entrega Identificador de la entrega trn:oid:::1:3718649943',
  'La presente investigación tiene como objetivo determinar la relación entre el liderazgo pedagógico y el desempeño docente en instituciones educativas de Lima Norte.',
  'Se aplicó un enfoque cuantitativo, de diseño no experimental y correlacional, con una muestra de 86 docentes.',
  'Los resultados evidencian una correlación positiva y significativa (Rho = 0,712; p < 0,05) entre ambas variables.',
  'Se concluye que fortalecer el liderazgo pedagógico mejora el desempeño docente y se recomienda implementar programas de acompañamiento.',
].join('\n');

test('Turnitin report chrome is removed and the author’s research content is kept', () => {
  assert.equal(looksLikeReportExport(TURNITIN_EXPORT), true);
  const cleaned = stripReportScaffolding(TURNITIN_EXPORT);
  assert.doesNotMatch(cleaned, /trn:oid|Página \d+ de 38|escritura con IA|texto calificado|herramienta de IA generativa|12\.730 palabras|Fecha de entrega|1261054847\.pdf/i);
  assert.match(cleaned, /liderazgo pedagógico y el desempeño docente/);
  assert.match(cleaned, /muestra de 86 docentes/);
  assert.match(cleaned, /Rho = 0,712/);
  assert.match(cleaned, /se recomienda implementar programas de acompañamiento/);
});

test('ordinary documents (even about AI) are never filtered', () => {
  const essay = 'La escritura con IA plantea retos éticos en la universidad. Este ensayo analiza la detección de IA y sus falsos positivos en tres facultades durante 2026.';
  assert.equal(looksLikeReportExport(essay), false);
  assert.equal(stripReportScaffolding(essay), essay);
  assert.equal(stripReportScaffolding(''), '');
});

test('agent attachment fast path lets the picked model write the answer before sentence extraction', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/agents/agent-task-runner.js'), 'utf8');
  const fast = src.slice(src.indexOf('if (deterministicAttachmentAnswer) {'), src.indexOf('if (!openai && hasAttachedFiles) {'));
  assert.match(fast, /const modelWrittenMarkdown = openai\s*\?\s*await buildLlmAttachmentRecoveryAnswer/);
  assert.match(fast, /pinnedRuntime: fastPathPinnedKept/);
  assert.match(fast, /const recoveredMarkdown = modelWrittenMarkdown \|\| buildBibliographyFallbackAnswer/);
  // The model prompt ignores report chrome and carries the exact format directive.
  assert.match(src, /stripReportScaffolding\(stripScaffolding\(uploadedFileContext\)\)/);
  assert.match(src, /ignora la portada del reporte/);
  assert.match(src, /outputFormat\.buildFormatDirectiveLines\(question/);
});

test('deterministic fallback for «resumen en 2 párrafos» returns exactly two paragraphs without a heading or report chrome', () => {
  const { buildAttachmentGroundedFallbackAnswer } = require('../src/services/agents/agent-task-runner');
  if (typeof buildAttachmentGroundedFallbackAnswer !== 'function') return;
  const answer = buildAttachmentGroundedFallbackAnswer({
    goal: 'dame un resumen en 2 párrafos',
    uploadedFileContext: TURNITIN_EXPORT,
  });
  assert.ok(answer, 'fallback produced an answer');
  assert.doesNotMatch(answer, /###|trn:oid|escritura con IA|Página \d+ de 38/i);
  assert.equal(answer.trim().split(/\n\s*\n/).length, 2);
});

test('dedupeRepeatedPageHeaders & messageAttachments strip repeated page headers across multi-page PDFs while keeping verbatim transcription intact', () => {
  const { dedupeRepeatedPageHeaders, cleanExtractedDocumentText } = require('../src/services/document-report-scaffolding');
  const messageAttachments = require('../src/services/message-attachments');

  const multiPagePdf = Array.from({ length: 6 }, (_, i) => [
    '202602 - DISTANCIA - H - LIMA NORTE - MAESTRÍA EN EDUCACIÓN - TRABAJO DE INVESTIGACIÓN II - A11 (Moodle TT)',
    `Página ${i + 1} de 38`,
    `Capítulo ${i + 1}: El análisis de la muestra evidenció avances sostenidos en las competencias pedagógicas del profesorado.`,
    'Universidad César Vallejo — Escuela de Posgrado — Informe Académico Anual',
  ].join('\n')).join('\n\n');

  const deduped = dedupeRepeatedPageHeaders(multiPagePdf);
  assert.doesNotMatch(deduped, /Moodle TT/i, 'Moodle running header dropped completely');
  assert.doesNotMatch(deduped, /^Página \d+ de 38$/m, 'standalone page counters dropped');
  const ucvMatches = deduped.match(/Universidad César Vallejo — Escuela de Posgrado/g) || [];
  assert.equal(ucvMatches.length, 1, 'non-LMS running header kept at most once across 6 pages');
  assert.match(deduped, /Capítulo 6: El análisis de la muestra/);

  // Verbatim mode leaves raw text untouched for literal transcription requests.
  assert.equal(cleanExtractedDocumentText(multiPagePdf, { preserveVerbatim: true }), multiPagePdf);

  // Synthesis prep runs report + header cleaning automatically.
  const synthPrepared = messageAttachments.prepareDocumentTextForProfessionalSynthesis(TURNITIN_EXPORT);
  assert.doesNotMatch(synthPrepared, /trn:oid|escritura con IA|Moodle TT/i);
  assert.match(synthPrepared, /liderazgo pedagógico/);
});

test('thesis TOC («Población, muestra y muestreo 16») is stripped and GPT-6-Luna strips temperature in attachment recovery', async () => {
  const messageAttachments = require('../src/services/message-attachments');
  const runner = require('../src/services/agents/agent-task-runner');

  const thesisDocx = [
    'UNIVERSIDAD PRIVADA DEL NORTE',
    'FACULTAD DE NEGOCIOS',
    'CARRERA DE ADMINISTRACIÓN',
    'PROYECTO DE TESIS',
    'Relación entre la experiencia del usuario y el comportamiento de compra en línea en una ferretería de Trujillo, 2026.',
    'Autor: Estudiante UPN',
    'Asesor: Mg. Docente UPN',
    'ÍNDICE',
    'CAPÍTULO I. INTRODUCCIÓN 4',
    '1.1. Realidad problemática 5',
    '1.2. Formulación del problema 7',
    'CAPÍTULO II. METODOLOGÍA 12',
    'Población, muestra y muestreo 16',
    'Técnicas e instrumentos de recolección de datos 18',
    'CAPÍTULO I. INTRODUCCIÓN',
    'Actualmente, el comercio electrónico en el sector ferretero de Trujillo ha crecido de manera acelerada, impulsando a las empresas a mejorar sus canales digitales para sostener su competitividad.',
    'El presente estudio tiene como objetivo determinar la relación entre la experiencia del usuario y el comportamiento de compra en línea de los clientes de una ferretería en Trujillo durante el año 2026.',
    'La investigación adopta un enfoque cuantitativo, de diseño no experimental y alcance correlacional, evaluando una muestra probabilística de 140 compradores digitales mediante dos cuestionarios validados.',
    'Los hallazgos preliminares evidencian que una navegación ágil, tiempos de carga reducidos y transparencia en los costos de envío incrementan significativamente la intención de recompra y la satisfacción del cliente.',
  ].join('\n');

  const prepared = messageAttachments.prepareDocumentTextForProfessionalSynthesis(thesisDocx);
  assert.doesNotMatch(prepared, /Población, muestra y muestreo 16/i);
  assert.doesNotMatch(prepared, /Realidad problemática 5/i);
  assert.match(prepared, /comercio electrónico en el sector ferretero de Trujillo/);
  assert.match(prepared, /intención de recompra/);

  // Deterministic fallback never quotes TOC lines even if LLM is unavailable.
  if (typeof runner.buildAttachmentGroundedFallbackAnswer === 'function') {
    const fallback = runner.buildAttachmentGroundedFallbackAnswer({
      goal: 'dame un resumen en 2 párrafos',
      uploadedFileContext: thesisDocx,
    });
    assert.doesNotMatch(fallback, /Población, muestra y muestreo 16/i);
    assert.doesNotMatch(fallback, /Realidad problemática 5/i);
    assert.equal(fallback.trim().split(/\n\s*\n/).length, 2);
  }

  // LLM recovery with gpt-6-luna must strip unsupported `temperature` and pass clean thesis body.
  if (typeof runner.buildLlmAttachmentRecoveryAnswer === 'function') {
    let seenPayload = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (payload) => {
            seenPayload = payload;
            return {
              choices: [{
                message: {
                  content: 'El proyecto de tesis analiza cómo la experiencia del usuario en canales digitales se relaciona con el comportamiento de compra en línea en una ferretería de Trujillo durante 2026.\n\nCon un diseño cuantitativo correlacional sobre 140 compradores digitales, el estudio concluye que una navegación ágil, carga rápida y transparencia de envíos elevan la intención de recompra.',
                },
              }],
            };
          },
        },
      },
    };
    const llmAnswer = await runner.buildLlmAttachmentRecoveryAnswer({
      goal: 'dame un resumen en 2 párrafos',
      uploadedFileContext: thesisDocx,
      env: { AGENT_TASK_LLM_RECOVERY: '1' },
      pinnedRuntime: { client: fakeClient, model: 'gpt-6-luna', provider: 'OpenAI' },
    });
    assert.ok(seenPayload, 'gpt-6-luna client was invoked');
    assert.equal(Object.prototype.hasOwnProperty.call(seenPayload, 'temperature'), false, 'gpt-6-luna must not receive temperature: 0.3');
    assert.doesNotMatch(seenPayload.messages[1].content, /Población, muestra y muestreo 16/i);
    assert.match(llmAnswer, /ferretería de Trujillo/);
    assert.equal(llmAnswer.trim().split(/\n\s*\n/).length, 2);
  }
});
