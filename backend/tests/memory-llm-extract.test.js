'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ex = require('../src/services/memory-llm-extract');

test('extractFacts: parses + normalizes LLM facts (injected completeJson)', async () => {
  const fake = async () => ({
    facts: [
      { fact: '  El usuario se mudó a Barcelona  ', category: 'identity', confidence: 0.9 },
      { fact: 'Prefiere trabajar de noche', category: 'preference', confidence: 1.4 }, // clamped
      { fact: 'x', category: 'identity' }, // too short → dropped
    ],
  });
  const facts = await ex.extractFacts('el año pasado me mudé a Barcelona y suelo trabajar de noche', { completeJsonFn: fake });
  assert.equal(facts.length, 2);
  assert.equal(facts[0].fact, 'El usuario se mudó a Barcelona');
  assert.equal(facts[0].category, 'identity');
  assert.equal(facts[1].confidence, 1); // clamped to [0,1]
});

test('extractFacts: invalid category falls back to general', async () => {
  const fake = async () => ({ facts: [{ fact: 'El usuario usa Linux', category: 'weird' }] });
  const facts = await ex.extractFacts('uso linux', { completeJsonFn: fake });
  assert.equal(facts[0].category, 'general');
  assert.equal(facts[0].polarity, 'positive');
});

test('extractFacts: fail-open to [] on null / garbage / throw', async () => {
  assert.deepEqual(await ex.extractFacts('hola', { completeJsonFn: async () => null }), []);
  assert.deepEqual(await ex.extractFacts('hola', { completeJsonFn: async () => ({ nope: 1 }) }), []);
  assert.deepEqual(await ex.extractFacts('hola', { completeJsonFn: async () => { throw new Error('boom'); } }), []);
  assert.deepEqual(await ex.extractFacts('', { completeJsonFn: async () => ({ facts: [{ fact: 'X' }] }) }), []);
});

test('extractFacts: dedups and caps at 5', async () => {
  const fake = async () => ({
    facts: [
      { fact: 'El usuario usa vim' }, { fact: 'el usuario usa vim' }, // dup (case)
      { fact: 'A fact one' }, { fact: 'B fact two' }, { fact: 'C fact three' },
      { fact: 'D fact four' }, { fact: 'E fact five' }, { fact: 'F fact six' },
    ],
  });
  const facts = await ex.extractFacts('algo', { completeJsonFn: fake });
  assert.ok(facts.length <= 5);
  const lc = facts.map((f) => f.fact.toLowerCase());
  assert.equal(new Set(lc).size, lc.length); // no dups
});

test('normalizeFact: rejects junk', () => {
  assert.equal(ex.normalizeFact(null), null);
  assert.equal(ex.normalizeFact({ fact: 'ok' }).fact, 'ok');
  assert.equal(ex.normalizeFact({ fact: 'a' }), null); // too short
});

test('available: false without CEREBRAS key', () => {
  assert.equal(ex.available({}), false);
});
