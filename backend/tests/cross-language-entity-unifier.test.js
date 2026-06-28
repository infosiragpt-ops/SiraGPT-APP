'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tracker = require('../src/services/cross-turn-entity-tracker');
const unifier = require('../src/services/cross-language-entity-unifier');

describe('cross-language-entity-unifier', () => {
  beforeEach(() => tracker._reset());

  test('fingerprint strips scaffold words', () => {
    assert.equal(unifier.fingerprint('el cliente Acme Corp'), 'acme|corp');
    assert.equal(unifier.fingerprint('the Acme customer'), 'acme');
  });

  test('detectKind recognises client / file hints', () => {
    assert.equal(unifier.detectKind('el cliente Acme'), 'client');
    assert.equal(unifier.detectKind('the customer Acme'), 'client');
    assert.equal(unifier.detectKind('el archivo reporte.pdf'), 'file');
  });

  test('unify returns clusters keyed by fingerprint', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'Trabaja con el cliente Acme Corp' });
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 1, text: 'For the Acme Corp customer the SLA matters' });
    const clusters = unifier.unify({ userId: 'u', chatId: 'c' });
    const acme = clusters.find((c) => c.fingerprint.includes('acme'));
    assert.ok(acme, 'expected an Acme cluster');
    assert.ok(acme.cardinality >= 1);
  });

  test('resolve finds cluster by surface fingerprint', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'Trabaja con Acme Corporation' });
    const r = unifier.resolve({ userId: 'u', chatId: 'c', surface: 'the Acme Corp' });
    assert.ok(r);
    assert.ok(r.confidence > 0);
  });

  test('buildUnifierBlock yields content when clusters exist', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'Acme Corp es nuestro mejor cliente' });
    const block = unifier.buildUnifierBlock({ userId: 'u', chatId: 'c' });
    assert.match(block, /CROSS-LANGUAGE/);
  });

  test('buildUnifierBlock empty when no entities', () => {
    const block = unifier.buildUnifierBlock({ userId: 'u', chatId: 'c' });
    assert.equal(block, '');
  });

  test('resolve returns null for unknown surface', () => {
    const r = unifier.resolve({ userId: 'u', chatId: 'c', surface: 'xyzzy' });
    assert.equal(r, null);
  });

  test('mentions counted once per cluster, not once per shared-fingerprint surface', () => {
    const orig = tracker.listEntities;
    // One entity whose canonical + aliases all collapse to "acme|corp".
    tracker.listEntities = () => ([
      { id: 'e1', canonicalSurface: 'Acme Corp', aliases: ['el cliente Acme Corp', 'the Acme Corp'], kind: 'client', mentions: 5 },
    ]);
    try {
      const clusters = unifier.unify({ userId: 'u', chatId: 'c' });
      const acme = clusters.find((c) => c.fingerprint.includes('acme'));
      assert.ok(acme, 'expected an Acme cluster');
      // The entity's 5 mentions must be counted ONCE — not once per surface (15).
      assert.equal(acme.mentions, 5, 'mentions counted per entity per cluster, not per surface');
      assert.equal(acme.cardinality, 1, 'a single entity is a single member');
    } finally {
      tracker.listEntities = orig;
    }
  });
});
