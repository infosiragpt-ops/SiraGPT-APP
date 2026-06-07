'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ttc = require('../src/services/test-time-compute');

const dec = (compute) => ({ compute });

describe('shouldApply', () => {
  test('direct + low effort → no compute', () => {
    assert.equal(ttc.shouldApply(dec({ mode: 'direct', reasoningEffort: 'low', reflection: false })), false);
  });
  test('extended → apply', () => {
    assert.equal(ttc.shouldApply(dec({ mode: 'extended', reasoningEffort: 'high', reflection: true })), true);
  });
  test('self_consistency → apply', () => {
    assert.equal(ttc.shouldApply(dec({ mode: 'self_consistency', samples: 3 })), true);
  });
  test('garbage → false', () => {
    assert.equal(ttc.shouldApply(null), false);
    assert.equal(ttc.shouldApply({}), false);
    assert.equal(ttc.shouldApply(dec({ mode: 'nope' })), false);
  });
});

describe('buildReasoningDirective', () => {
  test('direct → empty', () => {
    assert.equal(ttc.buildReasoningDirective(dec({ mode: 'direct', reasoningEffort: 'low' })), '');
  });
  test('extended (es default) mentions razonamiento and is capped', () => {
    const b = ttc.buildReasoningDirective(dec({ mode: 'extended', reasoningEffort: 'high', reflection: true }));
    assert.match(b, /ESFUERZO DE RAZONAMIENTO/);
    assert.match(b, /paso a paso/i);
    assert.ok(b.length <= ttc.MAX_DIRECTIVE_CHARS);
  });
  test('extended (en) switches language', () => {
    const b = ttc.buildReasoningDirective(dec({ mode: 'extended', reasoningEffort: 'high' }), { language: 'en' });
    assert.match(b, /REASONING EFFORT/);
    assert.match(b, /step by step/i);
  });
  test('self_consistency interpolates sample count', () => {
    const b = ttc.buildReasoningDirective(dec({ mode: 'self_consistency', samples: 5, reasoningEffort: 'high' }));
    assert.match(b, /5 enfoques/);
  });
  test('best_of_n mentions versions + drafting', () => {
    const b = ttc.buildReasoningDirective(dec({ mode: 'best_of_n', samples: 3, reasoningEffort: 'high' }), { language: 'en' });
    assert.match(b, /3 versions/);
    assert.match(b, /strongest/i);
  });
  test('respects maxChars override', () => {
    const b = ttc.buildReasoningDirective(dec({ mode: 'extended', reasoningEffort: 'high' }), { maxChars: 40 });
    assert.ok(b.length <= 40);
  });
});

describe('planSampling', () => {
  test('self_consistency → majority_vote with >=2 samples', () => {
    const p = ttc.planSampling(dec({ mode: 'self_consistency', samples: 3 }));
    assert.equal(p.strategy, 'majority_vote');
    assert.ok(p.samples >= 2);
  });
  test('best_of_n → judge_best', () => {
    const p = ttc.planSampling(dec({ mode: 'best_of_n', samples: 2 }));
    assert.equal(p.strategy, 'judge_best');
  });
  test('direct → single', () => {
    const p = ttc.planSampling(dec({ mode: 'direct' }));
    assert.equal(p.strategy, 'single');
    assert.equal(p.samples, 1);
  });
});

describe('aggregateSamples', () => {
  test('majority vote picks the most common answer', () => {
    const samples = ['The answer is 42.', 'the answer is 42', 'It is 7.'];
    const out = ttc.aggregateSamples(samples, { strategy: 'majority_vote' });
    assert.equal(out.method, 'majority_vote');
    assert.equal(out.support, 2);
    assert.match(out.answer, /42/);
  });
  test('judge_best uses scoreFn when provided', () => {
    const samples = ['short', 'a much longer and more complete answer'];
    const out = ttc.aggregateSamples(samples, { strategy: 'judge_best' }, { scoreFn: (t) => t.length });
    assert.equal(out.method, 'judge_best');
    assert.match(out.answer, /longer/);
  });
  test('single sample passthrough', () => {
    const out = ttc.aggregateSamples(['only one'], { strategy: 'majority_vote' });
    assert.equal(out.method, 'single');
    assert.equal(out.answer, 'only one');
  });
  test('empty → empty', () => {
    const out = ttc.aggregateSamples([], { strategy: 'majority_vote' });
    assert.equal(out.method, 'empty');
    assert.equal(out.answer, '');
  });
  test('filters non-string / empty entries', () => {
    const out = ttc.aggregateSamples(['', null, { text: 'real' }, '   '], { strategy: 'judge_best' });
    assert.equal(out.answer, 'real');
  });
});
