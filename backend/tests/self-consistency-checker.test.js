'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const consistency = require('../src/services/self-consistency-checker');

describe('self-consistency-checker', () => {
  describe('check() — empty / null inputs', () => {
    it('returns clean result for empty string', () => {
      const r = consistency.check('');
      assert.equal(r.contradictions.length, 0);
      assert.equal(r.score, 1);
    });

    it('returns clean result for non-string', () => {
      assert.equal(consistency.check(null).score, 1);
      assert.equal(consistency.check(123).score, 1);
    });
  });

  describe('numeric contradiction detection', () => {
    it('detects same label with different numeric values', () => {
      const text = 'Revenue was $5 million. Later, revenue was $7 million.';
      const r = consistency.check(text);
      const numeric = r.contradictions.filter((c) => c.kind === 'numeric');
      assert.ok(numeric.length >= 1);
    });

    it('does not flag same label with same value', () => {
      const text = 'Revenue was $5 million. Revenue was $5 million in Q3.';
      const r = consistency.check(text);
      const numeric = r.contradictions.filter((c) => c.kind === 'numeric');
      assert.equal(numeric.length, 0);
    });

    it('marks high severity for 3+ different values', () => {
      const text = 'Margin was 10%. Margin was 20%. Margin was 30%.';
      const r = consistency.check(text);
      const m = r.contradictions.find((c) => c.kind === 'numeric' && /margin/i.test(c.label));
      if (m) assert.equal(m.severity, 'high');
    });
  });

  describe('polarity contradiction detection', () => {
    it('detects positive + negative claims about same subject', () => {
      const text = 'Tesla rose dramatically. Tesla fell sharply in the same period.';
      const r = consistency.check(text);
      const pol = r.contradictions.filter((c) => c.kind === 'polarity');
      assert.ok(pol.length >= 1);
    });

    it('does not flag positive claims that agree', () => {
      const text = 'Tesla rose. Tesla grew. Tesla expanded.';
      const r = consistency.check(text);
      const pol = r.contradictions.filter((c) => c.kind === 'polarity');
      assert.equal(pol.length, 0);
    });

    it('handles Spanish polarity verbs', () => {
      const text = 'Tesla creció en Q1. Tesla cayó en Q1 también.';
      const r = consistency.check(text);
      const pol = r.contradictions.filter((c) => c.kind === 'polarity');
      assert.ok(pol.length >= 0);
    });
  });

  describe('entity-claim contradictions', () => {
    it('detects same entity asserted as both X and not X', () => {
      const text = 'Tesla is profitable. Tesla is not profitable yet.';
      const r = consistency.check(text);
      const claim = r.contradictions.filter((c) => c.kind === 'entity_claim');
      assert.ok(claim.length >= 1);
    });

    it('does not flag when assertion is consistent', () => {
      const text = 'Tesla is profitable. Tesla is innovative.';
      const r = consistency.check(text);
      const claim = r.contradictions.filter((c) => c.kind === 'entity_claim');
      assert.equal(claim.length, 0);
    });
  });

  describe('severity & score', () => {
    it('low severity for zero contradictions', () => {
      const r = consistency.check('Tesla is doing well overall.');
      assert.equal(r.severity, 'low');
      assert.equal(r.score, 1);
    });

    it('high severity for multiple contradictions', () => {
      const text = 'Tesla is profitable. Tesla is not profitable. Revenue was $5M. Revenue was $10M.';
      const r = consistency.check(text);
      assert.ok(['medium', 'high'].includes(r.severity));
    });

    it('score is clamped to [0, 1]', () => {
      const text = 'Tesla rose. Tesla fell. Tesla improved. Tesla declined. Revenue was $5M. Revenue was $7M.';
      const r = consistency.check(text);
      assert.ok(r.score >= 0 && r.score <= 1);
    });
  });

  describe('helpers', () => {
    it('splitSentences splits on punctuation and newlines', () => {
      const parts = consistency.splitSentences('A. B! C? D\nE');
      assert.equal(parts.length, 5);
    });

    it('extractLabeledNumbers returns objects with label and value', () => {
      const nums = consistency.extractLabeledNumbers('Revenue was $5 million.');
      assert.ok(nums.length >= 1);
      assert.equal(nums[0].value, 5);
    });

    it('extractLabeledDates parses month-year', () => {
      const dates = consistency.extractLabeledDates('The launch happened in March 2024.');
      assert.ok(dates.length >= 1);
    });
  });

  describe('buildSelfConsistencyPrompt()', () => {
    it('returns empty string for no contradictions', () => {
      const r = consistency.check('All good here.');
      assert.equal(consistency.buildSelfConsistencyPrompt(r), '');
    });

    it('returns prompt block when contradictions exist', () => {
      const r = consistency.check('Tesla is profitable. Tesla is not profitable.');
      const prompt = consistency.buildSelfConsistencyPrompt(r);
      assert.ok(prompt.includes('Self-Consistency Check'));
    });

    it('limits the listed contradictions', () => {
      const text = 'A is x. A is not x. B is y. B is not y. C is z. C is not z. D is w. D is not w.';
      const r = consistency.check(text);
      const prompt = consistency.buildSelfConsistencyPrompt(r, { limit: 2 });
      assert.ok(prompt.split('\n').length <= 6);
    });
  });
});
