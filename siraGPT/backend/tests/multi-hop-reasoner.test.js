'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const r = require('../src/services/multi-hop-reasoner');

describe('multi-hop-reasoner', () => {
  test('empty prompt → not multi-hop', () => {
    const out = r.detectHops({ prompt: '' });
    assert.equal(out.isMultiHop, false);
    assert.equal(out.depth, 0);
  });

  test('simple single-clause prompt → not multi-hop', () => {
    const out = r.detectHops({ prompt: 'Hola, ¿qué tal?' });
    assert.equal(out.isMultiHop, false);
  });

  test('anaphora to prior turn fires hop', () => {
    const out = r.detectHops({
      prompt: 'Aplica eso al archivo nuevo, igual que antes',
      history: [{ role: 'user', content: 'Refactoriza este código para que sea más simple' }],
    });
    assert.ok(out.isMultiHop);
    assert.ok(out.hops.some((h) => h.kind.startsWith('anaphora')));
  });

  test('comparison pattern emits comparison hop', () => {
    const out = r.detectHops({ prompt: 'Compara el rendimiento de React vs Vue para este caso' });
    assert.ok(out.hops.some((h) => h.kind === 'comparison'));
  });

  test('sequential markers emit chain.then hop', () => {
    const out = r.detectHops({ prompt: 'Primero crea el archivo, luego edita la función, después ejecuta los tests' });
    assert.ok(out.hops.some((h) => h.kind === 'chain.then'));
  });

  test('multiple named entities emit implicit.multi_entity hop', () => {
    const out = r.detectHops({ prompt: 'Trabaja en Foo Service y Bar Module al mismo tiempo' });
    assert.ok(out.hops.some((h) => h.kind === 'implicit.multi_entity'));
  });

  test('renderHopsBlock yields readable text for multi-hop', () => {
    const out = r.detectHops({ prompt: 'Compara A vs B y dime cuál es mejor' });
    const block = r.renderHopsBlock(out);
    assert.match(block, /MULTI-HOP/);
  });

  test('renderHopsBlock returns empty string when no hops', () => {
    const block = r.renderHopsBlock({ isMultiHop: false, hops: [] });
    assert.equal(block, '');
  });

  test('confidence stays in [0,1]', () => {
    const out = r.detectHops({ prompt: 'Como hicimos antes, arregla eso y luego compáralo con lo nuevo' });
    for (const h of out.hops) {
      assert.ok(h.confidence >= 0 && h.confidence <= 1);
    }
  });
});
