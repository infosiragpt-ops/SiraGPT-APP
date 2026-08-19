'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const conf = require('../src/services/attribution-confidence-aggregator');

describe('attribution-confidence-aggregator', () => {
  test('empty input returns neutral baseline', () => {
    const r = conf.aggregate({});
    assert.ok(r.score >= 0.5 && r.score <= 0.7);
    assert.ok(['B', 'C'].includes(r.grade));
  });

  test('strong intent boosts confidence', () => {
    const r = conf.aggregate({
      engineBundle: { attribution: { summary: { topIntents: [{ text: 'fix', weight: 0.9 }, { text: 'analyze', weight: 0.1 }] } } },
    });
    assert.ok(r.score > 0.7);
  });

  test('safety refuse reduces confidence + routes recommendation', () => {
    const r = conf.aggregate({ safetyResult: { verdict: 'refuse' } });
    assert.ok(r.score < 0.5);
    assert.match(r.recommendation, /Refuse/);
  });

  test('hard_shift drift reduces confidence', () => {
    const r1 = conf.aggregate({ driftObservation: { classification: 'baseline' } });
    const r2 = conf.aggregate({ driftObservation: { classification: 'hard_shift' } });
    assert.ok(r2.score < r1.score);
  });

  test('multi-hop reduces confidence', () => {
    const r1 = conf.aggregate({ engineBundle: { multiHop: { depth: 0 } } });
    const r2 = conf.aggregate({ engineBundle: { multiHop: { depth: 3 } } });
    assert.ok(r2.score < r1.score);
  });

  test('belief contradictions reduce confidence', () => {
    const r1 = conf.aggregate({ beliefResult: { contradicted: [] } });
    const r2 = conf.aggregate({ beliefResult: { contradicted: [{}, {}] } });
    assert.ok(r2.score < r1.score);
  });

  test('high faithfulness boosts confidence', () => {
    const r1 = conf.aggregate({ faithfulness: { score: 0.3 } });
    const r2 = conf.aggregate({ faithfulness: { score: 0.95 } });
    assert.ok(r2.score > r1.score);
  });

  test('anti-patterns reduce confidence', () => {
    const r1 = conf.aggregate({ antipatternResult: { hasAntipattern: false, patterns: [] } });
    const r2 = conf.aggregate({ antipatternResult: { hasAntipattern: true, patterns: [{ severity: 'medium' }] } });
    assert.ok(r2.score < r1.score);
  });

  test('grade A for very high, F for very low', () => {
    assert.equal(conf.gradeFromScore(0.95), 'A');
    assert.equal(conf.gradeFromScore(0.1), 'F');
  });

  test('buildConfidenceBlock contains score and recommendation', () => {
    const r = conf.aggregate({ safetyResult: { verdict: 'refuse' } });
    const block = conf.buildConfidenceBlock(r);
    assert.match(block, /UNDERSTANDING CONFIDENCE/);
    assert.match(block, /Refuse/);
  });
});
