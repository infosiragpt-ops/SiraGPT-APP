'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const b = require('../src/services/belief-state-tracker');

describe('belief-state-tracker', () => {
  beforeEach(() => b._reset());

  test('observes Spanish done belief', () => {
    const r = b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug del login ya está arreglado' });
    assert.ok(r.observed.length >= 1);
    assert.equal(r.observed[0].status, 'done');
  });

  test('observes English done belief', () => {
    const r = b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'The migration is now deployed' });
    assert.ok(r.observed.length >= 1);
    assert.equal(r.observed[0].status, 'done');
  });

  test('observes pending belief', () => {
    const r = b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El reporte sigue pendiente' });
    assert.ok(r.observed.find((o) => o.status === 'pending'));
  });

  test('regression contradicts prior done', () => {
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug del login ya está arreglado' });
    const r = b.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'El bug del login se rompió otra vez' });
    assert.ok(r.contradicted.length >= 1);
    assert.equal(r.contradicted[0].status, 'done');
  });

  test('re-asserting a contradicted belief clears its contradiction (active again)', () => {
    // done → regressed (done now contradicted) → done re-asserted.
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug del login ya está arreglado' });
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'El bug del login se rompió otra vez' });
    const r = b.observe({ userId: 'u', chatId: 'c', turnIndex: 2, prompt: 'El bug del login ya está arreglado' });

    const done = b.list({ userId: 'u', chatId: 'c' }).find((x) => x.status === 'done');
    assert.ok(done, 'the done belief still exists');
    assert.equal(done.contradictedAt, null, 're-assertion must clear contradictedAt');
    assert.equal(done.contradictedBy, null, 're-assertion must clear contradictedBy');
    assert.ok(
      r.observed.find((o) => o.status === 'done' && o.isNew === false),
      're-assertion is an observation of the existing belief, not a new one'
    );

    // The re-stated belief belongs in the ACTIVE section, never under the
    // "do not assume still true" section (which used to tell the model the
    // opposite of the user's latest message).
    const block = b.buildBeliefBlock({ userId: 'u', chatId: 'c' });
    assert.match(block, /Currently active beliefs[\s\S]*\*\*done\*\*/);
    const contradictedSection = block.split('do not assume still true')[1] || '';
    assert.doesNotMatch(contradictedSection, /→ done/);
  });

  test('list returns beliefs sorted by current strength', () => {
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El reporte sigue pendiente' });
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'El reporte sigue pendiente' });
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 2, prompt: 'El bug ya está arreglado' });
    const list = b.list({ userId: 'u', chatId: 'c' });
    assert.ok(list.length >= 2);
    assert.ok(list[0].currentStrength >= list[list.length - 1].currentStrength);
  });

  test('buildBeliefBlock empty when no beliefs', () => {
    assert.equal(b.buildBeliefBlock({ userId: 'u', chatId: 'c' }), '');
  });

  test('buildBeliefBlock contains active + contradicted sections', () => {
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug ya está arreglado' });
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 1, prompt: 'El bug se rompió otra vez' });
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 2, prompt: 'El despliegue está listo' });
    const block = b.buildBeliefBlock({ userId: 'u', chatId: 'c' });
    assert.match(block, /USER BELIEF STATE/);
  });

  test('reset clears chat beliefs', () => {
    b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug ya está arreglado' });
    const r = b.reset({ userId: 'u', chatId: 'c' });
    assert.ok(r.cleared >= 1);
    assert.equal(b.list({ userId: 'u', chatId: 'c' }).length, 0);
  });

  test('contradict marks belief as contradicted', () => {
    const obs = b.observe({ userId: 'u', chatId: 'c', turnIndex: 0, prompt: 'El bug ya está arreglado' });
    const id = obs.observed[0].id;
    const r = b.contradict({ userId: 'u', chatId: 'c', beliefId: id });
    assert.equal(r.contradicted, 1);
    const list = b.list({ userId: 'u', chatId: 'c' });
    assert.ok(list[0].contradictedAt);
  });
});
