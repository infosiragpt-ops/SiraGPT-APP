'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Hold the semantic ranking fixed to exercise lexical evidence independently
// of a paid embedding model. These tests are not a semantic quality benchmark.
let unavailable = false;
require.cache[require.resolve('../src/services/embedding-provider')] = {
  exports: {
    isAvailable: () => !unavailable,
    expectedSpace: () => 'document-retrieval-regression',
    embed: async texts => texts.map(() => new Float32Array([1, 0])),
  },
};
const rag = require('../src/services/rag-service');
const store = require('../src/services/rag-store');
const runtime = require('../src/services/rag/operational-runtime');
const { ndcgAtK } = require('../src/services/rag/ndcg');
const { documentTokens, queryFocusedExcerpt } = require('../src/services/rag/document-retrieval');

let sequence = 0;
async function corpus(docs, userId = `doc-eval-${++sequence}`, collection = 'documents') {
  await store.appendChunks(userId, collection, docs.map((doc, index) => ({
    source: `file:${index}`, title: 'Documento de referencia', embedding: new Float32Array([1, 0]), ...doc,
  })));
  return { userId, collection };
}
afterEach(() => { unavailable = false; rag._embedCache.clear(); });

test('hybrid ranks exact lexical evidence ahead of semantic-only distractors without phantom BM25 votes', async () => {
  const docs = Array.from({ length: 80 }, (_, index) => ({
    text: `Financial operations overview and performance report ${index}.`,
  }));
  docs.push({ source: 'file:answer', text: 'Contrato ZX900 tiene un importe de S/ 42.600.', embedding: new Float32Array([0.6, 0.8]) });
  const { userId, collection } = await corpus(docs);
  const hits = await rag.retrieve(userId, collection, 'ZX900', 3, { useHybrid: true, includeDiagnostics: true });
  assert.equal(hits[0].source, 'file:answer');
  const unrelated = hits.find(hit => hit.source !== 'file:answer');
  assert.equal(unrelated.diagnostics.textRank, null, 'a zero lexical score contributes no text rank');
});

const exactCases = [
  { query: 'comunicacion', wrong: 'Datos históricos de ventas por trimestre.', right: 'Área: Comunicación. Responsable: Elena.' },
  { query: 'ingenieria', wrong: 'Registro de talleres deportivos.', right: 'Área: Ingeniería. Responsable: Mario.' },
  { query: 'educacion', wrong: 'Datos de operaciones financieras.', right: 'Área: Educación. Responsable: Celia.' },
  { query: 'nutricion', wrong: 'Datos de operaciones financieras.', right: 'Área: Nutrición. Responsable: Ana.' },
  { query: '2026', wrong: 'Periodo de ejecución: 2025.', right: 'Periodo de ejecución: 2026.' },
  { query: '7', wrong: 'Cantidad de investigadores: 3.', right: 'Cantidad de investigadores: 7.' },
  { query: '0', wrong: 'Cantidad de incidencias: 4.', right: 'Cantidad de incidencias: 0.' },
  { query: '2.75', wrong: 'Promedio de la muestra: 2.50.', right: 'Promedio de la muestra: 2.75.' },
  { query: '0,05', wrong: 'Significancia: 0,01.', right: 'Significancia: 0,05.' },
  { query: 'RQ-007', wrong: 'Expediente RQ-008: pendiente.', right: 'Expediente RQ-007: aprobado.' },
  { query: 'SALUD', wrong: 'Fila 21: Estrategias de planificación.', right: 'Fila 43: Estrategias de planificación.', title: 'SALUD temas investigación 1.xlsx' },
  { query: 'DERECHO.xlsx', wrong: 'Fila 10: Regulación y sociedad.', right: 'Fila 20: Regulación y sociedad.', title: 'DERECHO.xlsx' },
];

test('document retrieval eval: exact accents, integers, decimals, identifiers and filenames remain retrievable', async t => {
  let firstHits = 0;
  let ndcg = 0;
  for (const [index, item] of exactCases.entries()) {
    const { userId, collection } = await corpus([
      { source: 'wrong', text: item.wrong },
      { source: 'right', text: item.right, title: item.title || 'Registro de datos' },
    ]);
    const hits = await rag.retrieve(userId, collection, item.query, 2, { useHybrid: true, documentMode: true });
    if (hits[0]?.source === 'right') firstHits += 1;
    ndcg += ndcgAtK(hits.map(hit => hit.source), { right: 1 }, 2);
    t.diagnostic(`case ${index + 1}: ${item.query} => ${hits[0]?.source || 'none'}`);
  }
  t.diagnostic(`Exact Hit@1: ${firstHits}/${exactCases.length}; mean nDCG@2: ${(ndcg / exactCases.length).toFixed(4)}`);
  assert.equal(firstHits, exactCases.length);
});

test('document source scope is applied before ranking and cannot include another user or collection', async () => {
  const { userId, collection } = await corpus([
    { source: 'file:stale', text: 'Presupuesto anual final: 100.' },
    { source: 'file:current', text: 'Presupuesto anual final: 200.' },
  ]);
  await corpus([{ source: 'file:current', text: 'SECRETO de otro usuario: presupuesto 999.' }], 'other-user', collection);
  await corpus([{ source: 'file:current', text: 'SECRETO de otra colección: presupuesto 888.' }], userId, 'another-chat');
  const hits = await rag.retrieve(userId, collection, 'presupuesto', 5, {
    useHybrid: true, documentMode: true, allowedSources: ['file:current'],
  });
  assert.deepEqual(hits.map(hit => hit.source), ['file:current']);
  assert.match(hits[0].text, /200/);
  const empty = await rag.retrieve(userId, collection, 'presupuesto', 5, { allowedSources: [] });
  assert.deepEqual(empty, [], 'an explicitly empty source scope is deny-all');
});

test('lexical degradation preserves document matching and scope without leaking internal ranking fields', async () => {
  const { userId, collection } = await corpus([
    { source: 'file:stale', text: 'Ingeniería requiere 4 equipos.' },
    { source: 'file:current', text: 'Ingeniería requiere 7 equipos.' },
  ]);
  unavailable = true;
  const { hits, trace } = await rag.retrieveWithTrace(userId, collection, 'ingenieria 7', 2, {
    useHybrid: true, documentMode: true, allowedSources: ['file:current'],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'file:current');
  assert.equal(hits[0].retrievalMode, 'bm25_degraded');
  assert.equal('_idx' in hits[0], false);
  assert.equal(trace.mode, 'bm25_degraded');
  assert.equal(trace.scoring.vector, false);
});

test('cited excerpts retain query evidence near the end of a long retrieved chunk', () => {
  const fact = 'Hoja: Costos. Fila 93. Expediente ZX900: presupuesto aprobado S/ 42.600.';
  const context = runtime.buildEvidenceBlock({
    query: '¿Cuál es el presupuesto del expediente ZX900?', collection: 'chat:evidence', docs: [],
    hits: [{ source: 'file:finance', title: 'Costos.xlsx', text: `${'Notas administrativas sin información relevante. '.repeat(65)}\n${fact}` }],
  });
  assert.match(context, /\[S1\] Costos.xlsx/);
  assert.ok(context.includes(fact), 'the cited excerpt must contain the actual answer and row locator');
});

test('document lexical normalization preserves exact values and leaves original evidence untouched', () => {
  assert.ok(documentTokens('Ingeniería').includes('ingenieria'));
  assert.ok(documentTokens('0 7 0,05 0,01 2.75 RQ-007').includes('0,05'));
  assert.equal(documentTokens('0,01').includes('0,05'), false);
  assert.ok(documentTokens('RQ-007').includes('rq-007'));
  const original = 'Hoja: Evaluación\nFila 7\tSignificancia: 0,05\tPromedio: 2.75\n';
  assert.equal(queryFocusedExcerpt(original, 'evaluacion 0,05', 300), original);
});

test('query-focused excerpts scan a whole large document while retaining literal table rows and strict budgets', () => {
  const row = 'Fila 991\tIdentificador RQ-007\tMonto S/ 18.450,75\tEstado: Aprobado';
  const text = `${'Descripción administrativa general de las áreas.\n'.repeat(9000)}${row}\n${'Notas de cierre sin datos.\n'.repeat(120)}`;
  const excerpt = queryFocusedExcerpt(text, 'Monto RQ-007', 550);
  assert.ok(excerpt.includes(row));
  assert.ok(excerpt.length <= 550);
  assert.ok(text.includes(excerpt), 'the entire excerpt is a verbatim document span');
  for (const budget of [0, -1, 1, 12, 80, 301]) {
    assert.ok(queryFocusedExcerpt(text, 'RQ-007', budget).length <= Math.max(0, budget));
  }
});

test('multi-file comparison covers relevant sources instead of filling its budget with one file', async () => {
  const docs = Array.from({ length: 8 }, (_, index) => ({
    source: 'file:A', text: `Presupuesto 2026 para investigación: partida ${index}, 300 soles.`,
  }));
  docs.push({ source: 'file:B', text: 'Presupuesto 2026 para investigación: 700 soles, para equipos y mantenimiento.' });
  docs.push({ source: 'file:irrelevant', text: 'Calendario de cumpleaños del equipo de soporte.', embedding: new Float32Array([0, 1]) });
  const { userId, collection } = await corpus(docs);
  const hits = await rag.retrieve(userId, collection, 'Compara el presupuesto 2026 de investigación', 2, {
    useHybrid: true, useMMR: true, documentMode: true, sourceDiversity: true,
  });
  assert.deepEqual(new Set(hits.map(hit => hit.source)), new Set(['file:A', 'file:B']));
});
