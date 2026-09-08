'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestedOfficeFormat, isExplicitOfficeFormatRequest } = require('./format-intent');
const { applyRequestedColorGate, applyRequestedFormatGate } = require('./verify');
const { parsePptFollowupIntent, resolveTargetSlideCount } = require('./slide-intent');

test('documento Word / sin Excel is claimed as docx', () => {
  assert.equal(requestedOfficeFormat('Hazme un documento Word sobre el ciclo del agua. Word, no Excel no PPT.'), 'docx');
  assert.equal(requestedOfficeFormat('documento Word, no Excel no PPT'), 'docx');
  assert.equal(requestedOfficeFormat('Word, no Excel no PPT'), 'docx');
  assert.equal(isExplicitOfficeFormatRequest('documento Word'), true);
});

test('presentación create is claimed as pptx', () => {
  assert.equal(requestedOfficeFormat('crea una presentación del ciclo del agua'), 'pptx');
  assert.equal(requestedOfficeFormat('quiero una presentación, sin Excel'), 'pptx');
});

test('casual documento mention is NOT a format claim', () => {
  assert.equal(requestedOfficeFormat('qué dice el documento'), null);
  assert.equal(requestedOfficeFormat('me gustó la presentación de ayer'), null);
});

test('7 diapositivas is an add/count follow-up, color-only is not', () => {
  const seven = parsePptFollowupIntent('ponlas verdes y que tenga 7 diapositivas');
  assert.equal(seven.wantsAddSlide, true);
  assert.equal(seven.targetTotal, 7);
  assert.equal(resolveTargetSlideCount(seven, 6), 7);
  const only = parsePptFollowupIntent('ponlas todas de color verde #22C55E');
  assert.equal(only.wantsAddSlide, false);
});

test('format gate rejects xlsx when Word was requested', () => {
  const outputs = [{ name: 'ciclo.xlsx', buffer: Buffer.from('PK'), valid: true }];
  const gate = applyRequestedFormatGate(outputs, 'documento Word, no Excel no PPT');
  assert.equal(gate.ok, false);
  assert.equal(outputs[0].valid, false);
  assert.equal(outputs[0].verified, false);
  assert.match(outputs[0].validationReason, /requested_format_mismatch:xlsx!=docx/);
});

test('color gate refuses Validado when requested hex is absent', () => {
  const outputs = [{ name: 'ciclo.pptx', buffer: Buffer.from('PK\x03\x04not-a-real-pptx'), valid: true }];
  const gate = applyRequestedColorGate(outputs, '22C55E');
  assert.equal(gate.ok, false);
  assert.equal(outputs[0].verified, false);
  assert.match(outputs[0].validationReason, /requested_hex_missing:22C55E/);
});

const { shouldRunAgentRunner, isRunnerOnlyDocumentTurn } = require('./index');

test('Spanish create verbs claim AgentRunner for Word (live 2026-08-14)', () => {
  const phrases = [
    'Escribe un documento Word sobre el ciclo del agua, sin excel, sin ppt',
    'escribeme un documento word',
    'redacta un documento word',
    'generame un documento word',
    'prepara un documento word',
  ];
  for (const phrase of phrases) {
    assert.equal(shouldRunAgentRunner({ text: phrase }), true, 'claim: ' + phrase);
    assert.equal(isRunnerOnlyDocumentTurn(phrase), true, 'runner-only: ' + phrase);
  }
  assert.equal(shouldRunAgentRunner({ text: 'escríbeme un poema sobre el mar' }), false);
});

test('escribe + sin/ni excel/ppt is Word, never xlsx', () => {
  const phrases = [
    'Escribe un resumen del ciclo del agua sin Excel ni PPT',
    'Escribe un documento sobre el agua, sin excel, sin ppt',
    'escribeme un informe sin Excel ni PowerPoint',
    'Escribe… sin Excel ni PPT',
  ];
  for (const phrase of phrases) {
    assert.equal(requestedOfficeFormat(phrase), 'docx', phrase);
  }
});

test('Escribe un documento Word… sin convertirlo a Excel ni PPT is docx', () => {
  const phrase = 'Escribe un documento Word… sin convertirlo a Excel ni PPT';
  assert.equal(requestedOfficeFormat(phrase), 'docx');
  assert.notEqual(requestedOfficeFormat(phrase), 'xlsx');
  assert.notEqual(requestedOfficeFormat(phrase), 'pptx');
});
