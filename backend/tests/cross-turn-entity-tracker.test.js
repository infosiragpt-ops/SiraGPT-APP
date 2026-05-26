'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tracker = require('../src/services/cross-turn-entity-tracker');

describe('cross-turn-entity-tracker', () => {
  beforeEach(() => tracker._reset());

  test('register extracts entities and assigns ids', () => {
    const r = tracker.register({
      userId: 'u1',
      chatId: 'c1',
      turnIndex: 0,
      text: 'Trabaja en backend/src/routes/ai.js junto con Login Component',
    });
    assert.ok(r.length >= 1);
    for (const e of r) {
      assert.ok(e.id);
      assert.ok(e.isNew === true);
    }
  });

  test('repeated mentions increment counter, not duplicate', () => {
    tracker.register({ userId: 'u1', chatId: 'c1', turnIndex: 0, text: 'Edita backend/src/routes/ai.js' });
    const r2 = tracker.register({ userId: 'u1', chatId: 'c1', turnIndex: 1, text: 'sigue con backend/src/routes/ai.js' });
    assert.ok(r2.length >= 1);
    const ent = tracker.listEntities({ userId: 'u1', chatId: 'c1' }).find((e) => e.canonicalSurface.includes('ai.js'));
    assert.ok(ent);
    assert.ok(ent.mentions >= 2);
  });

  test('resolveReference returns best alias match', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'Configura el Login Component' });
    const ref = tracker.resolveReference({ userId: 'u', chatId: 'c', surface: 'Login Component' });
    assert.ok(ref);
    assert.ok(ref.score >= 0.5);
  });

  test('resolveReference falls back to kind hint when no token overlap', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'Mira el archivo Reporte.pdf' });
    const ref = tracker.resolveReference({ userId: 'u', chatId: 'c', surface: 'ese archivo' });
    assert.ok(ref);
  });

  test('listEntities returns recency-sorted entries', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'modifica config.json' });
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 1, text: 'mira README.md' });
    const list = tracker.listEntities({ userId: 'u', chatId: 'c' });
    assert.ok(list.length >= 2);
    assert.ok(list[0].lastTurnIndex >= list[list.length - 1].lastTurnIndex);
  });

  test('forgetEntity removes by id', () => {
    const reg = tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'edita algun.js' });
    assert.ok(reg.length >= 1);
    const id = reg[0].id;
    const r = tracker.forgetEntity({ userId: 'u', chatId: 'c', entityId: id });
    assert.equal(r.removed, 1);
  });

  test('resetChat clears all entries', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'algo.js' });
    const r = tracker.resetChat({ userId: 'u', chatId: 'c' });
    assert.ok(r.cleared >= 1);
    assert.equal(tracker.listEntities({ userId: 'u', chatId: 'c' }).length, 0);
  });

  test('buildReferenceResolutionBlock returns block when references resolve', () => {
    tracker.register({ userId: 'u', chatId: 'c', turnIndex: 0, text: 'configura el cliente principal' });
    const block = tracker.buildReferenceResolutionBlock({
      userId: 'u',
      chatId: 'c',
      prompt: 'el cliente principal necesita más atención',
    });
    assert.match(block, /CROSS-TURN ENTITY/);
  });

  test('stats reports counts', () => {
    tracker.register({ userId: 'u1', chatId: 'c1', turnIndex: 0, text: 'a.js' });
    tracker.register({ userId: 'u2', chatId: 'c2', turnIndex: 0, text: 'b.js' });
    const s = tracker.stats();
    assert.ok(s.chats >= 2);
    assert.ok(s.entities >= 2);
  });
});
