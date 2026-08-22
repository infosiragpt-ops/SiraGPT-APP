'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { slideCountSatisfied, honestSlideShortfallMessage } = require('./verify');
const { singleEditadoName } = require('./office-helpers');

describe('slide count gate', () => {
  it('treats actual == requested as SUCCESS', () => {
    assert.equal(slideCountSatisfied(6, 6), true);
    assert.equal(honestSlideShortfallMessage('6 diapositivas', 6, 6), '');
  });

  it('treats actual > requested as SUCCESS', () => {
    assert.equal(slideCountSatisfied(7, 6), true);
  });

  it('fails only when actual < requested', () => {
    assert.equal(slideCountSatisfied(5, 6), false);
    assert.match(honestSlideShortfallMessage('6 diapositivas', 5, 6), /tiene 5/);
  });
});

describe('single -editado name', () => {
  it('adds one -editado suffix', () => {
    assert.equal(singleEditadoName('ciclo_del_agua.pptx'), 'ciclo_del_agua-editado.pptx');
  });

  it('does not stack -editado-editado', () => {
    assert.equal(singleEditadoName('ciclo_del_agua-editado.pptx'), 'ciclo_del_agua-editado.pptx');
    assert.equal(singleEditadoName('ciclo_del_agua-editado-editado.pptx'), 'ciclo_del_agua-editado.pptx');
  });
});
