'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-deep-analyzer');
const {
  analyzeText,
  buildDeepAnalysisForFiles,
  renderDeepAnalysisBlock,
  _internal,
} = engine;

test('analyzeText: empty / non-string input → empty report', () => {
  const r1 = analyzeText('');
  assert.equal(r1.sentenceCount, 0);
  assert.deepEqual(r1.claims, []);
  const r2 = analyzeText(null);
  assert.equal(r2.sentenceCount, 0);
  const r3 = analyzeText(undefined);
  assert.equal(r3.sentenceCount, 0);
  const r4 = analyzeText({ not: 'a string' });
  assert.equal(r4.sentenceCount, 0);
});

test('analyzeText: extracts action items in Spanish & English', () => {
  const text = `Resumen del proyecto.

Debemos entregar el reporte antes del 2026-06-30.
El equipo tiene que coordinar la reunión con el cliente.
Action item: ship the production deploy by end of week.
TODO: review the security audit findings.`;
  const r = analyzeText(text);
  assert.ok(r.actions.length >= 3, `expected ≥3 actions, got ${r.actions.length}: ${JSON.stringify(r.actions)}`);
  assert.ok(r.actions.some((s) => /entregar el reporte/i.test(s)));
  assert.ok(r.actions.some((s) => /ship the production deploy/i.test(s)));
});

test('analyzeText: extracts decisions', () => {
  const text = `Acta de la reunión.

Se aprobó el presupuesto de $50,000 USD para Q3.
The board approved the new vendor contract on 2026-04-15.
La propuesta fue rechazada por el comité.`;
  const r = analyzeText(text);
  assert.ok(r.decisions.length >= 2, `expected ≥2 decisions: ${JSON.stringify(r.decisions)}`);
  assert.ok(r.decisions.some((s) => /aprob[óo] el presupuesto/i.test(s)));
  assert.ok(r.decisions.some((s) => /approved the new vendor/i.test(s)));
});

test('analyzeText: extracts open questions', () => {
  const text = `Notas de planning.

¿Quién será el responsable del módulo de pagos?
Fecha de lanzamiento: TBD.
Should we use Postgres or MySQL?
La integración con SAP está por definir.`;
  const r = analyzeText(text);
  assert.ok(r.openQuestions.length >= 3, `expected ≥3 questions: ${JSON.stringify(r.openQuestions)}`);
  assert.ok(r.openQuestions.some((s) => s.includes('TBD')));
});

test('analyzeText: extracts risks / red flags', () => {
  const text = `Análisis de riesgos.

El riesgo principal es la dependencia del proveedor único.
There is significant exposure to currency fluctuations.
Detected vulnerability in the authentication module.
Incumplimiento de la normativa GDPR podría generar multas.`;
  const r = analyzeText(text);
  assert.ok(r.risks.length >= 3, `expected ≥3 risks: ${JSON.stringify(r.risks)}`);
  assert.ok(r.risks.some((s) => /vulnerability/i.test(s)));
  assert.ok(r.risks.some((s) => /incumplimiento|multas/i.test(s)));
});

test('analyzeText: extracts claims with numbers/dates', () => {
  const text = `Reporte financiero del Q2 2026.

Los ingresos crecieron 24% respecto al trimestre anterior.
According to the audit, the company recorded $1,250,000 USD in revenue.
The new policy applies starting 2026-09-01.
Maybe the market will rebound next year.`;
  const r = analyzeText(text);
  assert.ok(r.claims.length >= 2, `expected ≥2 claims: ${JSON.stringify(r.claims)}`);
  // Hedged "maybe" sentence must NOT appear as a claim.
  assert.ok(!r.claims.some((s) => /maybe the market/i.test(s)),
    'hedged sentence leaked into claims');
});

test('analyzeText: caps per-bucket count', () => {
  const lines = [];
  for (let i = 0; i < 30; i += 1) {
    lines.push(`Debemos completar la tarea número ${i + 1} antes de la fecha límite.`);
  }
  const r = analyzeText(lines.join('\n'));
  assert.ok(r.actions.length <= _internal.MAX_PER_BUCKET,
    `actions exceeded MAX_PER_BUCKET: ${r.actions.length}`);
});

test('analyzeText: dedupes near-identical sentences', () => {
  const text = `Debemos enviar el contrato al cliente.
Debemos enviar el contrato al cliente.
Debemos enviar el contrato al cliente!`;
  const r = analyzeText(text);
  assert.equal(r.actions.length, 1, `dedupe failed: ${JSON.stringify(r.actions)}`);
});

test('buildDeepAnalysisForFiles: aggregates across files', () => {
  const files = [
    {
      originalName: 'a.txt',
      extractedText: 'Se aprobó el presupuesto de $50,000 USD.\nDebemos entregar el reporte.',
    },
    {
      originalName: 'b.txt',
      extractedText: 'The board approved the vendor contract on 2026-04-15.\nAction item: ship the deploy.',
    },
  ];
  const { perFile, aggregate } = buildDeepAnalysisForFiles(files);
  assert.equal(perFile.length, 2);
  assert.ok(aggregate.totals.decisions >= 2, 'aggregate decisions should be ≥2');
  assert.ok(aggregate.totals.actions >= 2, 'aggregate actions should be ≥2');
});

test('buildDeepAnalysisForFiles: skips files with empty text', () => {
  const files = [
    { originalName: 'empty.txt', extractedText: '' },
    { originalName: 'short.txt', extractedText: 'hi.' },
    { originalName: 'ok.txt', extractedText: 'Debemos coordinar la entrega antes del 2026-06-30.' },
  ];
  const { perFile } = buildDeepAnalysisForFiles(files);
  assert.equal(perFile.length, 1);
  assert.equal(perFile[0].file, 'ok.txt');
});

test('buildDeepAnalysisForFiles: tolerates malformed input', () => {
  assert.doesNotThrow(() => buildDeepAnalysisForFiles(null));
  assert.doesNotThrow(() => buildDeepAnalysisForFiles(undefined));
  assert.doesNotThrow(() => buildDeepAnalysisForFiles([null, undefined, 42, 'string']));
  const { perFile } = buildDeepAnalysisForFiles([null, undefined, 42]);
  assert.equal(perFile.length, 0);
});

test('renderDeepAnalysisBlock: empty report → empty string', () => {
  assert.equal(renderDeepAnalysisBlock(null), '');
  assert.equal(renderDeepAnalysisBlock({ perFile: [], aggregate: {} }), '');
  // Report with zero findings on every bucket → still empty.
  const empty = {
    perFile: [{
      file: 'x.txt',
      report: {
        claims: [], actions: [], decisions: [], openQuestions: [], risks: [],
        totals: { claims: 0, actions: 0, decisions: 0, openQuestions: 0, risks: 0 },
        sentenceCount: 5,
      },
    }],
    aggregate: {
      claims: [], actions: [], decisions: [], openQuestions: [], risks: [],
      totals: { claims: 0, actions: 0, decisions: 0, openQuestions: 0, risks: 0 },
      sentenceCount: 5,
    },
  };
  assert.equal(renderDeepAnalysisBlock(empty), '');
});

test('renderDeepAnalysisBlock: single-file rendering contains headings', () => {
  const text = `Se aprobó el presupuesto de $50,000 USD para Q3 2026.
Debemos entregar la versión beta antes del 2026-06-30.
¿Quién será el responsable del módulo de pagos?
El riesgo principal es la dependencia del proveedor único.`;
  const { perFile, aggregate } = buildDeepAnalysisForFiles([{
    originalName: 'plan.txt', extractedText: text,
  }]);
  const md = renderDeepAnalysisBlock({ perFile, aggregate });
  assert.ok(md.includes('## DEEP DOCUMENT ANALYSIS'));
  assert.ok(md.includes('### File: plan.txt'));
  assert.ok(/Action items|Decisions|Open questions|Risks/.test(md));
});

test('renderDeepAnalysisBlock: multi-file rendering has aggregate + per-file', () => {
  const files = [
    {
      originalName: 'a.txt',
      extractedText: 'Se aprobó el presupuesto de $50,000 USD. Debemos entregar el reporte el 2026-07-01.',
    },
    {
      originalName: 'b.txt',
      extractedText: 'Action item: deploy v2 by 2026-08-15. Risk: vendor lock-in could cost $200,000.',
    },
  ];
  const md = renderDeepAnalysisBlock(buildDeepAnalysisForFiles(files));
  assert.ok(md.includes('Aggregate across all files'));
  assert.ok(md.includes('### File: a.txt'));
  assert.ok(md.includes('### File: b.txt'));
});

test('renderDeepAnalysisBlock: respects MAX_BLOCK_CHARS budget', () => {
  // Build a giant doc with many findings to force truncation.
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(`Debemos completar la tarea ${i} antes del 2026-0${(i % 9) + 1}-15.`);
    lines.push(`Se aprobó la inversión de $${1000 + i},000 USD en el proyecto ${i}.`);
    lines.push(`¿Cuál será el responsable del módulo ${i}?`);
    lines.push(`El riesgo de fallo en el sistema ${i} podría generar incumplimiento.`);
  }
  const files = [{ originalName: 'huge.txt', extractedText: lines.join('\n') }];
  const md = renderDeepAnalysisBlock(buildDeepAnalysisForFiles(files));
  assert.ok(md.length <= _internal.MAX_BLOCK_CHARS,
    `block exceeded budget: ${md.length} > ${_internal.MAX_BLOCK_CHARS}`);
});

test('integration: professional-analyzer exposes deepAnalysisBlock', async () => {
  const pa = require('../src/services/document-professional-analyzer');
  const result = await pa.buildEnrichedFileContext({
    prisma: null,
    processedFiles: [{
      id: 'f1',
      originalName: 'meeting.txt',
      extractedText: `Acta de reunión del 2026-05-12.
Se aprobó el presupuesto de $80,000 USD para el Q3.
Debemos entregar la propuesta antes del 2026-06-01.
¿Cuándo será la próxima revisión?
El riesgo principal es el retraso en la integración.`,
    }],
  });
  assert.ok(typeof result.deepAnalysisBlock === 'string',
    'enrichment should expose deepAnalysisBlock field');
  assert.ok(result.deepAnalysisBlock.includes('DEEP DOCUMENT ANALYSIS'));
});
