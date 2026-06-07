'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ca = require('../src/services/constraint-adherence');

function kinds(cs) { return cs.map((c) => c.kind); }
function find(cs, kind) { return cs.find((c) => c.kind === kind); }

describe('extractConstraints', () => {
  test('the reported case: "en un solo parrafo"', () => {
    const cs = ca.extractConstraints('dame un resumen en un solo parrafo');
    const p = find(cs, 'length_paragraphs');
    assert.ok(p);
    assert.equal(p.value, 1);
  });

  test('N paragraphs', () => {
    assert.equal(find(ca.extractConstraints('explícalo en tres párrafos'), 'length_paragraphs').value, 3);
  });

  test('one sentence', () => {
    assert.ok(find(ca.extractConstraints('resúmelo en una sola frase'), 'length_sentences'));
    assert.equal(find(ca.extractConstraints('answer in one sentence'), 'length_sentences').value, 1);
  });

  test('word limits with operator', () => {
    assert.deepEqual(
      (() => { const c = find(ca.extractConstraints('hazlo en máximo 200 palabras'), 'length_words'); return [c.value, c.op]; })(),
      [200, 'max']
    );
    assert.equal(find(ca.extractConstraints('at least 500 words'), 'length_words').op, 'min');
    assert.equal(find(ca.extractConstraints('un texto de 100 palabras'), 'length_words').op, 'about');
  });

  test('list item counts', () => {
    assert.equal(find(ca.extractConstraints('dame 5 puntos clave'), 'length_items').value, 5);
    assert.equal(find(ca.extractConstraints('una lista de 7 elementos'), 'length_items').value, 7);
  });

  test('language constraints', () => {
    assert.equal(find(ca.extractConstraints('responde en inglés'), 'language').value, 'en');
    assert.equal(find(ca.extractConstraints('escribe la respuesta en español'), 'language').value, 'es');
    assert.equal(find(ca.extractConstraints('answer in English please'), 'language').value, 'en');
  });

  test('must_include', () => {
    const cs = ca.extractConstraints('hazme un informe que incluya un gráfico de barras');
    const inc = find(cs, 'must_include');
    assert.ok(inc);
    assert.match(inc.value, /gr[áa]fico de barras/);
  });

  test('must_exclude — "a excepción de la carátula" / "sin"', () => {
    const cs1 = ca.extractConstraints('redacta el trabajo a excepción de la carátula');
    assert.ok(find(cs1, 'must_exclude'));
    const cs2 = ca.extractConstraints('dame el resumen sin conclusiones');
    assert.match(find(cs2, 'must_exclude').value, /conclusiones/);
    const cs3 = ca.extractConstraints("don't include the introduction");
    assert.ok(find(cs3, 'must_exclude'));
  });

  test('directness', () => {
    assert.ok(find(ca.extractConstraints('solo dame el resultado, sin explicaciones'), 'directness'));
    assert.ok(find(ca.extractConstraints('just give me the answer'), 'directness'));
  });

  test('plain prompt → no constraints', () => {
    assert.equal(ca.extractConstraints('cuéntame sobre la historia de Roma').length, 0);
  });
});

describe('verifyAdherence', () => {
  test('one-paragraph constraint: pass and fail', () => {
    const cs = ca.extractConstraints('en un solo parrafo');
    const okR = ca.verifyAdherence('Esto es un único párrafo sin saltos dobles.', cs);
    assert.equal(okR.satisfied, true);
    const badR = ca.verifyAdherence('Primer párrafo.\n\nSegundo párrafo.', cs);
    assert.equal(badR.satisfied, false);
    assert.equal(badR.violations[0].kind, 'length_paragraphs');
    assert.match(badR.fixInstruction, /constraint_fix/);
  });

  test('must_include: flags a missing term', () => {
    const cs = ca.extractConstraints('que incluya un gráfico de barras');
    const bad = ca.verifyAdherence('Aquí tienes el análisis en texto plano.', cs);
    assert.equal(bad.satisfied, false);
    const good = ca.verifyAdherence('Incluí un gráfico de barras con los datos.', cs);
    assert.equal(good.satisfied, true);
  });

  test('must_exclude: flags a present term', () => {
    const cs = ca.extractConstraints('sin conclusiones');
    const bad = ca.verifyAdherence('El texto y sus conclusiones finales.', cs);
    assert.equal(bad.satisfied, false);
    const good = ca.verifyAdherence('Solo el desarrollo, nada más.', cs);
    assert.equal(good.satisfied, true);
  });

  test('word max: tolerant pass, clear fail', () => {
    const cs = ca.extractConstraints('máximo 10 palabras');
    assert.equal(ca.verifyAdherence('una dos tres cuatro cinco seis siete', cs).satisfied, true);
    assert.equal(ca.verifyAdherence('una dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince', cs).satisfied, false);
  });

  test('language mismatch flagged', () => {
    const cs = ca.extractConstraints('responde en inglés');
    const bad = ca.verifyAdherence('Esta respuesta está claramente en español con muchas palabras.', cs);
    assert.equal(bad.satisfied, false);
    const good = ca.verifyAdherence('This answer is clearly written in English with several words.', cs);
    assert.equal(good.satisfied, true);
  });

  test('directness: preamble flagged', () => {
    const cs = ca.extractConstraints('solo dame la respuesta sin rodeos');
    assert.equal(ca.verifyAdherence('Claro, aquí tienes la respuesta...', cs).satisfied, false);
    assert.equal(ca.verifyAdherence('42.', cs).satisfied, true);
  });

  test('no constraints → satisfied with score 1', () => {
    const r = ca.verifyAdherence('cualquier cosa', []);
    assert.equal(r.satisfied, true);
    assert.equal(r.score, 1);
    assert.equal(r.checked, 0);
  });

  test('unverifiable constraints are skipped (tone)', () => {
    const cs = ca.extractConstraints('hazlo en tono formal');
    const r = ca.verifyAdherence('texto cualquiera', cs);
    assert.equal(r.checked, 0); // tone is verifiable:false
  });
});

describe('buildConstraintPromptBlock', () => {
  test('renders a MUST-satisfy checklist', () => {
    const cs = ca.extractConstraints('en un solo parrafo, en inglés, sin conclusiones');
    const block = ca.buildConstraintPromptBlock(cs);
    assert.match(block, /REQUISITOS EXPL[ÍI]CITOS/);
    assert.match(block, /párrafo/i);
    assert.ok(block.length <= 900);
  });
  test('empty constraints → empty block', () => {
    assert.equal(ca.buildConstraintPromptBlock([]), '');
  });
});

describe('counters', () => {
  test('countParagraphs / countWords / countSentences / countListItems', () => {
    assert.equal(ca.countParagraphs('a\n\nb\n\nc'), 3);
    assert.equal(ca.countWords('uno dos tres'), 3);
    assert.equal(ca.countSentences('Una. Dos. Tres.'), 3);
    assert.equal(ca.countListItems('- a\n- b\n1. c'), 3);
  });
});

describe('summarizeForLog', () => {
  test('single line', () => {
    const cs = ca.extractConstraints('en un solo parrafo');
    const r = ca.verifyAdherence('a\n\nb', cs);
    const line = ca.summarizeForLog(r);
    assert.match(line, /^\[constraint-adherence\]/);
    assert.ok(!line.includes('\n'));
  });
});
