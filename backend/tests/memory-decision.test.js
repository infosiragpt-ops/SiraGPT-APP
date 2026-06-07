'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const memoryDecision = require('../src/services/memory-decision');

test('shouldRecall: triggers on explicit "remember / como te dije" cues', () => {
  assert.equal(memoryDecision.shouldRecall('¿recuerdas lo que te dije ayer?').recall, true);
  assert.equal(memoryDecision.shouldRecall('como te comenté, hazlo otra vez').recall, true);
  assert.equal(memoryDecision.shouldRecall('remember what I told you about the API').recall, true);
  assert.equal(memoryDecision.shouldRecall('ya te dije mi color favorito').recall, true);
});

test('shouldRecall: triggers on identity/preference questions', () => {
  assert.equal(memoryDecision.shouldRecall('¿cómo me llamo?').recall, true);
  assert.equal(memoryDecision.shouldRecall('cuál es mi lenguaje preferido').recall, true);
  assert.equal(memoryDecision.shouldRecall("what's my name?").recall, true);
  assert.equal(memoryDecision.shouldRecall('what do I prefer for testing').recall, true);
});

test('shouldRecall: does NOT trigger on generic task prompts (decides not necessary)', () => {
  assert.equal(memoryDecision.shouldRecall('escribe una función que ordene un array').recall, false);
  assert.equal(memoryDecision.shouldRecall('explain how TCP works').recall, false);
  assert.equal(memoryDecision.shouldRecall('genera un informe en word sobre ventas').recall, false);
  assert.equal(memoryDecision.shouldRecall('').recall, false);
});

test('shouldStore: captures explicit "recuerda que X" instructions', () => {
  const r = memoryDecision.shouldStore('recuerda que siempre debes responder en español formal');
  assert.equal(r.store, true);
  assert.equal(r.facts.length >= 1, true);
  assert.equal(r.facts[0].category, 'instruction');
  assert.match(r.facts[0].fact, /siempre debes responder en espanol formal|siempre debes responder en español formal/i);
});

test('shouldStore: captures identity (name) facts ES + EN', () => {
  const es = memoryDecision.shouldStore('hola, me llamo Luis y trabajo en SiraGPT');
  assert.equal(es.store, true);
  assert.ok(es.facts.some((f) => f.category === 'identity' && /Luis/.test(f.fact)));

  const en = memoryDecision.shouldStore('my name is Carlos');
  assert.equal(en.store, true);
  assert.ok(en.facts.some((f) => f.category === 'identity' && /Carlos/.test(f.fact)));
});

test('shouldStore: captures preferences', () => {
  const r = memoryDecision.shouldStore('prefiero TypeScript sobre JavaScript');
  assert.equal(r.store, true);
  assert.ok(r.facts.some((f) => f.category === 'preference' && /TypeScript/i.test(f.fact)));
});

test('shouldStore: ignores hedged / uncertain statements', () => {
  assert.equal(memoryDecision.shouldStore('no estoy seguro pero quizá prefiero el modo oscuro').store, false);
  assert.equal(memoryDecision.shouldStore('maybe I like dark mode').store, false);
});

test('shouldStore: does not store generic prompts', () => {
  assert.equal(memoryDecision.shouldStore('crea una tabla comparativa de frameworks').store, false);
  assert.equal(memoryDecision.shouldStore('').store, false);
});

test('clampFact: trims to first clause and caps length', () => {
  assert.equal(memoryDecision.clampFact('uso vim. y también emacs'), 'uso vim');
  const long = 'x'.repeat(300);
  assert.equal(memoryDecision.clampFact(long).length, 200);
});

test('decide: combines recall + store and caps facts at 3', () => {
  const d = memoryDecision.decide('recuerda que me llamo Ana, prefiero React y trabajo en QA; y dime cómo me llamo');
  assert.equal(d.recall, true);
  assert.equal(d.store, true);
  assert.ok(d.facts.length <= 3);
  assert.equal(typeof d.reason, 'string');
});
