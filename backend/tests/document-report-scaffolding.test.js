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
