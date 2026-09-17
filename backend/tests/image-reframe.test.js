'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const directive = require('../src/services/agents/image-directive');
const {
  detectMediaIntents,
  detectImageEditIntent,
} = require('../src/services/agents/media-intent');

const REFRAME_TO_EDIT = [
  'ahora la misma imagen pero vertical porfavor',
  'ahora la misma imagen pero vertical por favor',
  'la misma imagen pero vertical',
  'la misma imagen en vertical',
  'la misma foto pero vertical',
  'esa misma imagen en formato vertical',
  'esta misma imagen pero retrato',
  'the same image but vertical',
  'the same image but portrait',
  'same image but 9:16',
  'hazla vertical',
  'hazla horizontal',
  'la misma imagen pero horizontal',
  'ahora la misma imagen en 9:16',
  'pásala a vertical',
  'pasala a vertical',
  'la misma imagen pero cuadrada',
];

const STAY_GENERATE = [
  'crea una imagen de una playa horizontal',
  'crea una imagen de una Bava horizontal',
  'créame una imagen vertical de un perro',
  'genera una imagen 16:9 de un atardecer',
  'dame una foto vertical de un gato',
  'hazme una imagen orisontal para la portada',
];

test('same-scene orientation follow-ups are reframes, not new generations', () => {
  for (const phrase of REFRAME_TO_EDIT) {
    const frame = directive.detectImageReframe(phrase);
    assert.ok(frame, `expected reframe for: ${phrase}`);
    assert.equal(detectImageEditIntent(phrase), true, `edit intent: ${phrase}`);
    const intents = detectMediaIntents(phrase);
    assert.equal(intents[0]?.tool, 'edit_image', `tool for: ${phrase}`);
  }
});

test('first-time generation with an orientation stays generate_image', () => {
  for (const phrase of STAY_GENERATE) {
    assert.equal(directive.detectImageReframe(phrase), null, `not reframe: ${phrase}`);
    const intents = detectMediaIntents(phrase);
    assert.equal(intents[0]?.tool, 'generate_image', `tool for: ${phrase}`);
  }
});

test('user screenshot phrase routes to portrait edit', () => {
  const phrase = 'ahora la misma imagen pero vertical porfavor';
  const reframe = directive.detectImageReframe(phrase);
  assert.equal(reframe.frame, '3:4');
  assert.equal(reframe.orientation, 'portrait');
  const resolved = directive.resolveReframeDirective(phrase);
  assert.equal(resolved.operation, 'reframe');
  assert.match(resolved.prompt, /same scene/i);
  assert.match(resolved.prompt, /3:4/);
  assert.match(resolved.prompt, /Do not invent/i);
});

test('reframe prompt forbids inventing a new subject', () => {
  const prompt = directive.resolveReframeDirective('la misma imagen pero vertical').prompt;
  assert.match(prompt, /Do not invent/);
  assert.match(prompt, /source image/i);
});
