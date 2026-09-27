const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateResponse,
  buildCorrectivePrompt,
  expectsShortResponse,
  looksLightweightPrompt,
  looksSubstantialPrompt,
} = require('../src/services/quality-guard');

test('quality guard allows a valid short greeting answer', () => {
  const verdict = evaluateResponse({
    userPrompt: 'hola',
    response: 'Hola.',
  });

  assert.equal(looksLightweightPrompt('hola'), true);
  assert.equal(verdict.weak, false);
  assert.equal(verdict.reason, null);
});

test('quality guard flags a generic short answer to a substantial prompt', () => {
  const verdict = evaluateResponse({
    userPrompt: 'explicame como hacer un resumen ejecutivo',
    response: 'Claro, puedo ayudarte con eso.',
  });

  assert.equal(looksSubstantialPrompt('explicame como hacer un resumen ejecutivo'), true);
  assert.equal(verdict.weak, true);
  assert.match(verdict.reason, /too-short-substantial|generic-thin|unstructured-thin/);
});

test('quality guard respects an explicit short-answer constraint', () => {
  const verdict = evaluateResponse({
    userPrompt: 'Responde únicamente: OK',
    response: 'OK',
  });

  assert.equal(expectsShortResponse('Responde únicamente: OK'), true);
  assert.equal(verdict.weak, false);
  assert.equal(verdict.reason, null);
});

test('quality guard flags simple evasive refusals', () => {
  const verdict = evaluateResponse({
    userPrompt: 'dame pasos para mejorar mi tesis',
    response: 'Lo siento, pero no puedo ayudarte con eso.',
  });

  assert.equal(verdict.weak, true);
  assert.match(verdict.reason, /^refusal-template:/);
});

test('quality guard corrective prompt asks for a complete Spanish rewrite', () => {
  const prompt = buildCorrectivePrompt('dame pasos para mejorar mi tesis', 'es');

  assert.match(prompt, /Reescribe la respuesta desde cero en espa/i);
  assert.match(prompt, /respuesta directa/i);
  assert.match(prompt, /pasos accionables/i);
  assert.match(prompt, /Pregunta original:/i);
  assert.match(prompt, /dame pasos para mejorar mi tesis/i);
});

// Prod 2026-09-27: «¿cuánto es 2+2?» → «2 + 2 = 4» was flagged too-short and
// a corrective pass held the reply for 8 s.
test('quality guard lets calculations and direct fact questions have short answers', () => {
  for (const [userPrompt, response] of [
    ['¿cuánto es 2+2?', '2 + 2 = 4'], ['ahora resuelve 3x + 5 = 20', 'x = 5'],
    ['¿cuál es la capital de Francia?', 'París.'], ['¿cuántos continentes hay?', 'Siete.'],
    ['¿quién escribió el Quijote?', 'Miguel de Cervantes.'], ['¿qué día es hoy?', 'Sábado.'],
  ]) {
    assert.deepEqual(evaluateResponse({ userPrompt, response }), { weak: false, reason: null }, `${userPrompt} → ${response}`);
  }
});

test('quality guard still flags short answers that do not answer', () => {
  for (const [userPrompt, response] of [
    ['¿cuánto es 2+2?', 'Claro.'], ['¿cuál es la capital de Francia?', 'La'],
    ['¿qué opinas de la IA?', 'Interesante.'], ['hazme un informe de ventas', 'Listo.'],
  ]) {
    assert.equal(evaluateResponse({ userPrompt, response }).weak, true, `${userPrompt} → ${response}`);
  }
});

