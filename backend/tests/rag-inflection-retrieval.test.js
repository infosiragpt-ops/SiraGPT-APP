'use strict';

/**
 * Lexical document retrieval across inflections and question words.
 *
 * documentTokens() feeds BOTH document retrievers (docintel evidence for the
 * user message and the hybrid operational RAG's BM25 leg). Users rarely ask
 * with the exact form the document uses: «¿cuál es el riesgo principal?» vs a
 * passage about «riesgos», «la evaluación» vs «evaluaciones», «nueva norma» vs
 * «nuevo reglamento». Each case below names the passage that must rank first.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { documentTokens, searchDocumentLexical } = require('../src/services/rag/document-retrieval');

const PASSAGES = [
  { id: 'intro', text: 'La presente tesis estudia la automedicación en usuarios de una botica de Trujillo durante 2027.' },
  { id: 'riesgos', text: 'Los riesgos identificados incluyen reacciones adversas, interacciones medicamentosas y resistencia antimicrobiana.' },
  { id: 'eval', text: 'Las evaluaciones de los participantes se realizaron con un cuestionario validado por tres expertos.' },
  { id: 'muestra', text: 'La muestra estuvo conformada por 120 usuarios seleccionados por muestreo aleatorio simple.' },
  { id: 'ciudades', text: 'El estudio se replicó en dos ciudades costeras con resultados similares.' },
  { id: 'norma', text: 'El nuevo reglamento sanitario exige receta médica para antibióticos.' },
  { id: 'en', text: 'Several studies report that self-medication risks increase with low health literacy.' },
  { id: 'acciones', text: 'Se proponen acciones educativas dirigidas a los dispensadores de farmacia.' },
];

const CASES = [
  ['¿Cuál es el riesgo principal?', 'riesgos'],
  ['¿Cómo se hizo la evaluación de los participantes?', 'eval'],
  ['¿En qué ciudad se replicó?', 'ciudades'],
  ['¿Qué exige la nueva norma sanitaria?', 'norma'],
  ['what does the study say about the risk?', 'en'],
  ['¿qué acción educativa se propone?', 'acciones'],
  ['¿cuántos usuarios tuvo la muestra?', 'muestra'],
];

function top1(query) {
  const hits = searchDocumentLexical(PASSAGES.map((p) => ({ text: p.text })), query, 3);
  return hits.length ? PASSAGES[hits[0].doc._idx].id : null;
}

test('inflected and accent-free questions find the right passage first', () => {
  const misses = CASES.filter(([query, expected]) => top1(query) !== expected)
    .map(([query, expected]) => `${query} → ${top1(query)} (expected ${expected})`);
  assert.deepEqual(misses, []);
});

test('surface forms are kept: exact matches still outrank stem-only matches', () => {
  const docs = [{ text: 'riesgos financieros del proyecto' }, { text: 'el riesgo financiero del proyecto' }];
  const [best] = searchDocumentLexical(docs, 'riesgo financiero', 2);
  assert.equal(best.doc._idx, 1);
});

test('question words no longer count as evidence terms', () => {
  assert.deepEqual(documentTokens('¿Cuál es? ¿Cómo? ¿Dónde? what which how'), []);
  assert.deepEqual(documentTokens('¿Cuál es el riesgo?'), ['riesgo', 'riesg']);
});

test('pre-tokenized terms are searched as-is, never stemmed a second time', () => {
  // docintel passes its capped term list (surface + stem). Joined back into a
  // string, «interes» was stemmed again to «inter» and matched the split part
  // of an unrelated compound.
  const docs = [
    { text: 'Convenio inter-institucional firmado en marzo.' },
    { text: 'Los intereses moratorios se calculan mensualmente.' },
  ];
  const terms = documentTokens('¿Cómo se calculan los intereses?');
  assert.deepEqual(terms, ['calculan', 'intereses', 'interes']);
  const hits = searchDocumentLexical(docs, terms, 2);
  assert.deepEqual(hits.map((hit) => hit.doc._idx), [1]);
  assert.equal(hits[0].coverage, 1);
});

test('identifiers, decimals and short tokens are never stemmed', () => {
  assert.deepEqual(documentTokens('0,05'), ['0,05']);
  assert.ok(documentTokens('INV-2024-001').includes('inv-2024-001'));
  assert.deepEqual(documentTokens('dato'), ['dato']);
  assert.deepEqual(documentTokens('análisis crisis tesis virus'), ['analisis', 'crisis', 'tesis', 'virus']);
  assert.deepEqual(documentTokens('evaluaciones'), ['evaluaciones', 'evaluacion']);
  assert.deepEqual(documentTokens('studies'), ['studies', 'study']);
});
