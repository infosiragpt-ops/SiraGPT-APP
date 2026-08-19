'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cc = require('../src/services/confidence-calibration');

const D = (bucket) => ({ bucket });
const R = (level) => ({ level });

describe('calibrate — postures', () => {
  test('clear, grounded question → answer, high confidence', () => {
    const r = cc.calibrate({ prompt: 'explica la fotosíntesis', difficulty: D('moderate'), risk: R('low'), hasGrounding: true });
    assert.equal(r.posture, 'answer');
    assert.equal(r.band, 'high');
  });

  test('real-time need without web search → ground_or_abstain', () => {
    const r = cc.calibrate({ prompt: 'cuál es el precio actual del dólar hoy', difficulty: D('simple'), risk: R('low'), hasWebSearch: false });
    assert.equal(r.posture, 'ground_or_abstain');
    assert.ok(r.missingInfo.includes('real_time_data'));
  });

  test('real-time WITH web search → not flagged missing', () => {
    const r = cc.calibrate({ prompt: 'cuál es el precio actual del dólar hoy', difficulty: D('simple'), risk: R('low'), hasWebSearch: true });
    assert.ok(!r.missingInfo.includes('real_time_data'));
  });

  test('private account data → ground_or_abstain', () => {
    const r = cc.calibrate({ prompt: 'cuánto tengo en mi saldo y mi cuenta', difficulty: D('simple'), risk: R('low') });
    assert.equal(r.posture, 'ground_or_abstain');
    assert.ok(r.missingInfo.includes('private_account_data'));
  });

  test('reference to a doc not in scope (no grounding, no history) → ground_or_abstain', () => {
    const r = cc.calibrate({ prompt: 'resume el documento', difficulty: D('moderate'), risk: R('low'), hasGrounding: false, hasHistory: false });
    assert.ok(r.missingInfo.includes('referenced_artifact_not_in_scope'));
  });

  test('referenced doc IS resolvable when grounding present → no missing', () => {
    const r = cc.calibrate({ prompt: 'resume el documento', hasGrounding: true });
    assert.ok(!r.missingInfo.includes('referenced_artifact_not_in_scope'));
  });

  test('dangling imperative on first turn (no history) → clarify', () => {
    const r = cc.calibrate({ prompt: 'hazlo', difficulty: D('simple'), risk: R('low'), hasHistory: false });
    assert.equal(r.posture, 'clarify');
    assert.ok(r.ambiguities.includes('underspecified_target'));
  });

  test('same dangling imperative WITH history → answer (resolvable)', () => {
    const r = cc.calibrate({ prompt: 'hazlo', difficulty: D('simple'), risk: R('low'), hasHistory: true });
    assert.equal(r.posture, 'answer');
    assert.equal(r.ambiguities.length, 0);
  });

  test('semantic needs_clarification → clarify', () => {
    const r = cc.calibrate({ prompt: 'algo sobre eso', difficulty: D('moderate'), risk: R('low'), needsClarification: true });
    assert.equal(r.posture, 'clarify');
  });

  test('triage clarify → clarify', () => {
    const r = cc.calibrate({ prompt: 'compáralos', difficulty: D('moderate'), risk: R('low'), triageAction: 'clarify' });
    assert.equal(r.posture, 'clarify');
  });

  test('high-risk ungrounded medium confidence → answer_with_caveat', () => {
    const r = cc.calibrate({ prompt: 'qué dosis de este fármaco es segura', difficulty: D('moderate'), risk: R('high'), hasGrounding: false });
    assert.ok(['answer_with_caveat', 'ground_or_abstain'].includes(r.posture));
    assert.ok(r.confidence < 0.85);
  });

  test('trivial small talk is never forced to clarify', () => {
    const r = cc.calibrate({ prompt: 'hola', difficulty: D('trivial'), risk: R('low'), needsClarification: true });
    assert.equal(r.posture, 'answer');
  });

  test('garbage input never throws', () => {
    assert.doesNotThrow(() => cc.calibrate(null));
    const r = cc.calibrate({});
    assert.ok(cc.POSTURES.includes(r.posture));
  });
});

describe('buildPostureDirective', () => {
  test('answer → empty', () => {
    assert.equal(cc.buildPostureDirective({ posture: 'answer' }), '');
  });
  test('clarify → asks for ONE question, capped', () => {
    const b = cc.buildPostureDirective({ posture: 'clarify', confidence: 0.4 });
    assert.match(b, /POSTURA DE RESPUESTA/);
    assert.match(b, /UNA sola pregunta|UNA pregunta/);
    assert.ok(b.length <= 900);
  });
  test('ground_or_abstain mentions the missing kind', () => {
    const b = cc.buildPostureDirective({ posture: 'ground_or_abstain', confidence: 0.45, missingInfo: ['real_time_data'] });
    assert.match(b, /tiempo real/);
    assert.match(b, /NO inventes/);
  });
  test('answer_with_caveat asks to state confidence', () => {
    const b = cc.buildPostureDirective({ posture: 'answer_with_caveat', confidence: 0.55, missingInfo: [] });
    assert.match(b, /confianza/i);
  });
  test('english variant', () => {
    const b = cc.buildPostureDirective({ posture: 'clarify', confidence: 0.4 }, { language: 'en' });
    assert.match(b, /RESPONSE POSTURE/);
    assert.match(b, /ONE concrete/);
  });
});

describe('summarizeForLog', () => {
  test('single line', () => {
    const line = cc.summarizeForLog(cc.calibrate({ prompt: 'hazlo' }));
    assert.match(line, /^\[confidence-calibration\]/);
    assert.ok(!line.includes('\n'));
  });
});
