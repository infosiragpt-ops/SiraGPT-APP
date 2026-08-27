'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  buildAntiEchoLines,
  detectInstructionEcho,
  buildEchoCorrectivePreamble,
  bestWindowJaccard,
} = require('../src/services/instruction-echo-guard');

// Fixture mimicking the real bug: a thesis-writing guide whose body is mostly
// instructions to the human author, including a similarity threshold.
const THESIS_GUIDE_SOURCE = [
  'GUÍA PARA LA ELABORACIÓN DE LA TESIS DE INVESTIGACIÓN',
  '',
  'CAPÍTULO I: PLANTEAMIENTO DEL PROBLEMA',
  'Elaborar el planteamiento del problema considerando los siguientes criterios de evaluación.',
  'La matriz de sistematización debe incluir los siguientes elementos: título, problemas secundarios y objetivos.',
  'El índice de similitud máximo permitido es 29% según la normativa institucional. Todo trabajo con similitud mayor a 29% será observado por Turnitin.',
  'Redactar la introducción en un rango mínimo de 2 páginas y máximo de 3 páginas, interlineado 1.5, márgenes 2.5 cm.',
  'Presentar las referencias en formato APA 7ma edición.',
  'La lista de cotejo para la sustentación incluye: dominio del tema, manejo del tiempo y defensa de resultados.',
].join('\n');

test('buildAntiEchoLines returns directives in both languages', () => {
  const en = buildAntiEchoLines('dame un resumen', { lang: 'en' });
  const es = buildAntiEchoLines('dame un resumen', { lang: 'es' });
  assert.ok(en.length >= 3);
  assert.ok(es.length >= 3);
  assert.match(en.join(' '), /ANTI-ECHO/);
  assert.match(es.join(' '), /ANTI-ECO/);
});

test('detectInstructionEcho flags a summary made of the guide instructions', () => {
  const echoed = [
    'Resumen del documento:',
    'La matriz de sistematización debe incluir los siguientes elementos: título, problemas secundarios y objetivos.',
    'Elaborar el planteamiento del problema considerando los siguientes criterios de evaluación.',
    'Redactar la introducción en un rango mínimo de 2 páginas y máximo de 3 páginas, interlineado 1.5, márgenes 2.5 cm.',
    'El índice de similitud máximo permitido es 29% según la normativa institucional.',
  ].join('\n\n');
  const verdict = detectInstructionEcho({ response: echoed, sourceText: THESIS_GUIDE_SOURCE });
  assert.strictEqual(verdict.echo, true, `expected echo, got ${JSON.stringify(verdict)}`);
  assert.match(verdict.reason, /instruction_echo/);
});

test('detectInstructionEcho passes a genuine content summary of the same document', () => {
  const genuine = [
    'El documento es una guía institucional para la elaboración y sustentación de tesis de investigación.',
    'Describe cómo estructurar el planteamiento del problema, la introducción y las referencias bibliográficas, y fija un umbral institucional de originalidad del 29% medido con Turnitin.',
    'Además establece requisitos de formato (extensión, interlineado, márgenes) y una lista de cotejo para la defensa oral.',
  ].join(' ');
  const verdict = detectInstructionEcho({ response: genuine, sourceText: THESIS_GUIDE_SOURCE });
  assert.strictEqual(verdict.echo, false, `unexpected echo: ${JSON.stringify(verdict)}`);
});

test('detectInstructionEcho ignores responses with no source text', () => {
  const verdict = detectInstructionEcho({ response: 'Cualquier cosa larga aquí.', sourceText: '' });
  assert.strictEqual(verdict.echo, false);
  assert.strictEqual(verdict.score, 0);
});

test('detectInstructionEcho is robust to accents and casing (verbatim containment)', () => {
  const source = 'EL ÍNDICE DE SIMILITUD MÁXIMO PERMITIDO ES 29% SEGÚN LA NORMATIVA.';
  const response = 'Según el documento: "el indice de similitud maximo permitido es 29% segun la normativa." Además menciona Turnitin y la matriz de sistematización que debe incluir título y objetivos.';
  const verdict = detectInstructionEcho({ response, sourceText: source });
  assert.ok(verdict.score > 0, 'containment score should be > 0');
});

test('bestWindowJaccard saturates when window fully contained in source', () => {
  const source = 'la matriz de sistematizacion debe incluir titulo objetivos y conclusiones del trabajo';
  const resp = 'la matriz de sistematizacion debe incluir titulo objetivos y conclusiones del trabajo tal como indica la guia';
  assert.ok(bestWindowJaccard(resp, source) > 0.8);
  assert.strictEqual(bestWindowJaccard('', ''), 0);
});

test('buildEchoCorrectivePreamble mentions content-vs-instructions in both languages', () => {
  const es = buildEchoCorrectivePreamble('es');
  const en = buildEchoCorrectivePreamble('en');
  assert.match(es, /instrucciones internas/);
  assert.match(en, /internal instructions/);
});
