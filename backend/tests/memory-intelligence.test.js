'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mi = require('../src/services/memory-intelligence');

test('extractFacts: precise name capture stops at conjunctions (no greedy blob)', () => {
  const facts = mi.extractFacts('hola, me llamo Luis y prefiero TypeScript');
  const name = facts.find((f) => f.attribute === 'name');
  const pref = facts.find((f) => f.category === 'preference');
  assert.ok(name, 'should extract a name fact');
  assert.equal(name.value, 'Luis');
  assert.match(name.fact, /se llama Luis/);
  assert.ok(pref, 'should extract a preference fact');
  assert.match(pref.value, /TypeScript/i);
  assert.equal(pref.polarity, 'positive');
});

test('extractFacts: name is title-cased and not contaminated by the rest', () => {
  const facts = mi.extractFacts('mi nombre es ana, trabajo en SiraGPT');
  const name = facts.find((f) => f.attribute === 'name');
  const company = facts.find((f) => f.attribute === 'company');
  assert.equal(name.value, 'Ana');
  assert.ok(company);
  assert.match(company.fact, /trabaja en SiraGPT/);
});

test('extractFacts: dislikes get negative polarity', () => {
  const facts = mi.extractFacts('no me gusta el modo claro');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].category, 'preference');
  assert.equal(facts[0].polarity, 'negative');
  assert.match(facts[0].fact, /no le gusta/i);
});

test('extractFacts: explicit "recuerda que" stored verbatim as instruction', () => {
  const facts = mi.extractFacts('recuerda que debes responder siempre en español formal');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].category, 'instruction');
  assert.equal(facts[0].confidence >= 0.9, true);
  assert.match(facts[0].fact, /espa/i);
});

test('extractFacts: role and location', () => {
  const role = mi.extractFacts('trabajo como ingeniero de datos');
  assert.ok(role.some((f) => f.attribute === 'role' && /ingeniero de datos/i.test(f.value)));
  const loc = mi.extractFacts('vivo en Lima');
  assert.ok(loc.some((f) => f.attribute === 'location' && /Lima/i.test(f.value)));
});

test('extractFacts: ignores hedged statements', () => {
  assert.equal(mi.extractFacts('quizá prefiero el modo oscuro').length, 0);
  assert.equal(mi.extractFacts('no estoy seguro pero me llamo X').length, 0);
  assert.equal(mi.extractFacts('').length, 0);
});

test('extractFacts: does not store generic task prompts', () => {
  assert.equal(mi.extractFacts('escribe una función que ordene un array').length, 0);
  assert.equal(mi.extractFacts('crea una tabla comparativa').length, 0);
});

test('extractFacts: caps facts per turn', () => {
  const facts = mi.extractFacts('me llamo Ana, trabajo en QA, vivo en Lima, prefiero React, recuerda que uso vim');
  assert.ok(facts.length <= 4);
});

test('assessRecall: explicit + identity cues, with confidence', () => {
  const a = mi.assessRecall('¿recuerdas lo que te dije?');
  assert.equal(a.should, true);
  assert.equal(a.confidence >= 0.85, true);
  const b = mi.assessRecall('¿cómo me llamo?');
  assert.equal(b.should, true);
  assert.ok(Array.isArray(b.topics));
  assert.equal(mi.assessRecall('explica cómo funciona TCP').should, false);
});

test('detectForget: catches olvida/borra/ya no + forget/delete', () => {
  assert.equal(mi.detectForget('olvida que trabajo en QA').should, true);
  assert.equal(mi.detectForget('ya no uso React').should, true);
  assert.equal(mi.detectForget('forget about my old name').should, true);
  assert.equal(mi.detectForget('dame un resumen').should, false);
  const t = mi.detectForget('olvida lo de mi nombre');
  assert.ok(t.targets[0].query.length > 0);
});

test('captureValue: stops at boundary + caps length', () => {
  assert.equal(mi.captureValue('TypeScript y Go'), 'TypeScript');
  assert.equal(mi.captureValue('vim. y emacs'), 'vim');
  assert.equal(mi.captureValue('x'.repeat(120)).length <= 83, true);
});

test('analyze: one-call combines store + recall + forget', () => {
  const r = mi.analyze('recuerda que me llamo Ana y dime qué prefiero');
  assert.equal(typeof r.store, 'object');
  assert.ok(Array.isArray(r.store.facts));
  assert.equal(r.recall.should, true);
  assert.equal(r.forget.should, false);
});
