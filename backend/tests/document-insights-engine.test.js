'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-insights-engine');
const {
  extractDocumentInsights,
  renderInsightsBlock,
  buildInsightsForFiles,
} = engine;

test('extractDocumentInsights: returns empty report for empty input', () => {
  const r = extractDocumentInsights('');
  assert.deepEqual(r.entities.persons, []);
  assert.deepEqual(r.entities.organizations, []);
  assert.deepEqual(r.numbers.money, []);
  assert.equal(r.metrics.words, 0);
});

test('extractDocumentInsights: tolerates non-string input', () => {
  const r = extractDocumentInsights(null);
  assert.equal(r.metrics.words, 0);
  assert.deepEqual(r.actionItems, []);
});

test('extractEntities: detects titled persons', () => {
  const text = 'En la reunión asistieron Dr. Carlos Pérez y Sra. Laura Quispe del comité.';
  const r = extractDocumentInsights(text);
  assert.ok(r.entities.persons.some(p => p.includes('Carlos Pérez')), `expected Carlos Pérez in ${JSON.stringify(r.entities.persons)}`);
  assert.ok(r.entities.persons.some(p => p.includes('Laura Quispe')));
});

test('extractEntities: detects organizations with corporate suffix', () => {
  const text = 'El contrato es entre Acme Corp. y Globex Inc. El proveedor es ServiHub LLC, basado en Lima.';
  const r = extractDocumentInsights(text);
  assert.ok(r.entities.organizations.some(o => /Acme Corp/.test(o)));
  assert.ok(r.entities.organizations.some(o => /Globex Inc/.test(o)));
});

test('extractContacts: extracts urls, emails, phones', () => {
  const text = 'Para más info visita https://example.com/api o escribe a soporte@example.com. Llama al +51 999 888 777.';
  const r = extractDocumentInsights(text);
  assert.ok(r.contacts.urls.some(u => u.includes('example.com')));
  assert.ok(r.contacts.emails.includes('soporte@example.com'));
  assert.ok(r.contacts.phones.length >= 1);
});

test('extractDates: detects ISO and named dates', () => {
  const text = 'La fecha límite es 2026-05-30. La sesión inicia el 15 de junio de 2026 a las 10:00.';
  const r = extractDocumentInsights(text);
  assert.ok(r.dates.absolute.includes('2026-05-30'));
  assert.ok(r.dates.absolute.some(d => /15\s+de\s+junio\s+de\s+2026/i.test(d)));
});

test('extractDates: detects relative time markers', () => {
  const text = 'Vamos a entregarlo esta semana y la siguiente tarea es el próximo mes.';
  const r = extractDocumentInsights(text);
  assert.ok(r.dates.relative.length >= 1);
});

test('extractKeyNumbers: detects monetary amounts and percentages', () => {
  const text = 'El presupuesto es de $1,200,000 USD y el margen objetivo es 18.5% YoY. Total: 12,000 EUR.';
  const r = extractDocumentInsights(text);
  assert.ok(r.numbers.money.length >= 2, `expected money entries, got ${JSON.stringify(r.numbers.money)}`);
  assert.ok(r.numbers.percentages.some(p => p.includes('18.5')));
});

test('extractActionItems: picks up TODO bullets', () => {
  const text = `
- TODO: Revisar el contrato con legal
- ACCIÓN: Enviar la propuesta al cliente
- FIXME: corregir validación en submitForm()`.trim();
  const r = extractDocumentInsights(text);
  assert.ok(r.actionItems.length >= 2, `got ${JSON.stringify(r.actionItems)}`);
});

test('extractActionItems: picks up "we will/we must" phrasing', () => {
  const text = 'We will deliver the dashboard by Friday. The team must validate the SLA before launch.';
  const r = extractDocumentInsights(text);
  assert.ok(r.actionItems.length >= 1, `got ${JSON.stringify(r.actionItems)}`);
});

test('extractQuestions: collects in-document questions', () => {
  const text = '¿Qué pasaría si triplicamos los nodos? ¿Cuál es el costo proyectado del clúster?';
  const r = extractDocumentInsights(text);
  assert.ok(r.questions.length >= 2, `got ${JSON.stringify(r.questions)}`);
});

test('extractRisks: detects risk-language sentences', () => {
  const text = 'Existe un riesgo crítico de exposición de datos si no aplicamos el patch antes del 30 de mayo. Risk: vendor lock-in puede causar fragilidad.';
  const r = extractDocumentInsights(text);
  assert.ok(r.risks.length >= 1, `got ${JSON.stringify(r.risks)}`);
});

test('extractClaims: detects conclusion-style sentences', () => {
  const text = 'Nuestros resultados muestran una mejora del 23% en latencia. Therefore, the new architecture should be adopted.';
  const r = extractDocumentInsights(text);
  assert.ok(r.claims.length >= 1, `got ${JSON.stringify(r.claims)}`);
});

test('computeContentMetrics: returns sane stats for prose', () => {
  const text = 'Lorem ipsum dolor sit amet. Consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  const r = extractDocumentInsights(text);
  assert.ok(r.metrics.words >= 15);
  assert.ok(r.metrics.sentences >= 2);
  assert.ok(r.metrics.readingMinutes >= 1);
});

test('renderInsightsBlock: includes section headers when data exists', () => {
  const text = 'Dr. Ana López revisará el contrato con Acme Corp. La fecha límite es 2026-05-30 y el presupuesto es $50,000 USD. ¿Qué pasa si no se firma a tiempo?';
  const report = extractDocumentInsights(text);
  const block = renderInsightsBlock(report);
  assert.match(block, /## EXTRACTED INSIGHTS/);
  assert.match(block, /Named entities/);
  assert.match(block, /Key numbers/);
  assert.match(block, /Dates/);
  assert.match(block, /Open questions/);
});

test('renderInsightsBlock: handles empty report gracefully', () => {
  const report = extractDocumentInsights('');
  const block = renderInsightsBlock(report);
  assert.match(block, /## EXTRACTED INSIGHTS/);
  // No section headers when nothing found
  assert.doesNotMatch(block, /Named entities/);
  assert.doesNotMatch(block, /Key numbers/);
});

test('renderInsightsBlock: includes file label when provided', () => {
  const report = extractDocumentInsights('Hola mundo');
  const block = renderInsightsBlock(report, { fileLabel: 'demo.txt' });
  assert.match(block, /demo\.txt/);
});

test('buildInsightsForFiles: produces per-file and aggregate reports', () => {
  const files = [
    { originalName: 'memo.txt', extractedText: 'Carlos Pérez revisará la propuesta. Presupuesto: $25,000 USD. Fecha: 2026-06-01.' },
    { originalName: 'plan.md', extractedText: 'Acme Corp y Globex Inc colaboran. Fecha límite: 2026-06-15. Riesgo: dependencia del proveedor.' },
  ];
  const out = buildInsightsForFiles(files);
  assert.equal(out.perFile.length, 2);
  assert.equal(out.perFile[0].file, 'memo.txt');
  assert.equal(out.perFile[1].file, 'plan.md');
  // Aggregate should contain entities from both
  assert.ok(out.aggregate.entities.organizations.some(o => /Acme/.test(o)));
  assert.ok(out.aggregate.entities.persons.some(p => /Carlos/.test(p)));
});

test('buildInsightsForFiles: skips files without extractable text', () => {
  const files = [
    { originalName: 'a.txt', extractedText: '' },
    { originalName: 'b.txt', extractedText: 'Algún contenido con $1,000 USD.' },
    { originalName: 'c.txt' },
  ];
  const out = buildInsightsForFiles(files);
  assert.equal(out.perFile.length, 1);
  assert.equal(out.perFile[0].file, 'b.txt');
});

test('buildInsightsForFiles: returns empty result for non-array input', () => {
  const out = buildInsightsForFiles(null);
  assert.deepEqual(out.perFile, []);
});

test('extractor caps results to per-type maximums', () => {
  // Many distinct money mentions to verify capping
  const lines = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}: $${1000 + i * 13}`);
  const text = lines.join('\n');
  const r = extractDocumentInsights(text);
  assert.ok(r.numbers.money.length <= 16, `expected ≤16 money entries (cap), got ${r.numbers.money.length}`);
});
