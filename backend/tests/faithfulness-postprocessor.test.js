'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const pp = require('../src/services/faithfulness-postprocessor');

describe('faithfulness-postprocessor', () => {
  test('empty response → action=none', () => {
    const r = pp.postprocess({ response: '', context: [{ text: 'anything' }] });
    assert.equal(r.action, 'none');
    assert.equal(r.repair, null);
  });

  test('grounded response → action=pass', () => {
    const r = pp.postprocess({
      response: 'Revenue reached 1,234 USD with 42% growth.',
      context: [{ text: 'In Q4, revenue reached 1,234 USD and grew 42%.' }],
    });
    assert.equal(r.action, 'pass');
    assert.equal(r.repair, null);
    assert.equal(r.ok, true);
  });

  test('ungrounded response defaults to annotate mode', () => {
    const r = pp.postprocess({
      response: 'The company has 9,876 employees and is HQed in Atlantis.',
      context: [{ text: 'The company is mid-size.' }],
    });
    assert.equal(r.action, 'annotate');
    assert.match(r.response, /Auto-fidelity check/);
    assert.ok(r.repair);
    assert.ok(r.repair.flaggedCounts.total > 0);
  });

  test('regenerate mode emits systemAddendum', () => {
    const r = pp.postprocess({
      response: 'The company has 9,876 employees and is HQed in Atlantis.',
      context: [{ text: 'The company is mid-size.' }],
      mode: 'regenerate',
    });
    assert.equal(r.action, 'regenerate');
    assert.match(r.systemAddendum, /REGENERATION REQUEST/);
  });

  test('custom threshold overrides default', () => {
    const r = pp.postprocess({
      response: 'Numbers: 999 and 7777',
      context: [{ text: 'no numbers here' }],
      threshold: 0.99,
    });
    assert.ok(r.action !== 'pass');
  });

  test('buildRepairInstruction surfaces grade and score', () => {
    const repair = pp.buildRepairInstruction({
      score: 0.3,
      grade: 'F',
      advisory: 'low',
      unsupported: [{ kind: 'number', text: '999', severity: 'high' }],
    });
    assert.equal(repair.grade, 'F');
    assert.match(repair.userFooter, /F/);
  });
});
