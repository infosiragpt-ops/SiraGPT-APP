'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('../src/services/faithfulness-scorer');

describe('faithfulness-scorer', () => {
  test('empty response → score 1 and empty=true', () => {
    const r = fs.scoreFaithfulness({ response: '', context: [{ text: 'anything' }] });
    assert.equal(r.score, 1);
    assert.equal(r.empty, true);
  });

  test('all numbers grounded → high score', () => {
    const r = fs.scoreFaithfulness({
      response: 'Revenue reached 1,234 USD with 42% growth.',
      context: [{ text: 'In Q4, revenue reached 1,234 USD and grew 42%.' }],
    });
    assert.ok(r.score >= 0.7);
    assert.equal(r.numbers.filter((n) => !n.supported).length, 0);
  });

  test('ungrounded number is flagged', () => {
    const r = fs.scoreFaithfulness({
      response: 'The company has 9,876 employees.',
      context: [{ text: 'The company is mid-size.' }],
    });
    assert.ok(r.unsupported.some((u) => u.kind === 'number'));
    assert.ok(r.score < 0.9);
  });

  test('ungrounded URL flagged as high severity', () => {
    const r = fs.scoreFaithfulness({
      response: 'See https://example.com/fake-doc for details.',
      context: [{ text: 'See the attached spec.' }],
    });
    assert.ok(r.unsupported.some((u) => u.kind === 'url' && u.severity === 'high'));
  });

  test('grade dropdown follows score', () => {
    assert.equal(fs.scoreFaithfulness({ response: '', context: [] }).grade, 'A');
    const bad = fs.scoreFaithfulness({
      response: 'The 12345 widgets at https://fake.org cost 999 USD.',
      context: [{ text: 'Widget overview.' }],
    });
    assert.ok(['D', 'F'].includes(bad.grade));
  });

  test('extractNumbers skips trivial small integers', () => {
    const ns = fs.extractNumbers('Step 1: do this. Step 2: do that. We had 12345 events.');
    assert.ok(ns.length >= 1);
    assert.ok(ns.some((n) => n.value.includes('12345')));
  });

  test('splitClaims yields at least one sentence', () => {
    const cs = fs.splitClaims('The company grew. Revenue tripled. Margins fell.');
    assert.ok(cs.length >= 1);
  });

  test('renderFaithfulnessBlock contains score and grade', () => {
    const r = fs.scoreFaithfulness({
      response: 'Revenue was 100 USD with 999% growth.',
      context: [{ text: 'Revenue was 100 USD.' }],
    });
    const block = fs.renderFaithfulnessBlock(r);
    assert.match(block, /FAITHFULNESS/);
    assert.match(block, new RegExp(r.grade));
  });
});
