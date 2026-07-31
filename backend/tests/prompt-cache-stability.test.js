'use strict';

/**
 * prompt-cache-stability — OpenClaw-adapted determinism helpers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeStructuredPromptSection,
  normalizePromptCapabilityIds,
  stableStringify,
} = require('../src/services/agents/prompt-cache-stability');

test('normalizeStructuredPromptSection: CRLF → LF, trailing ws stripped, trimmed', () => {
  assert.equal(normalizeStructuredPromptSection('a\r\nb  \nc\t\n'), 'a\nb\nc');
  assert.equal(normalizeStructuredPromptSection('  hola  '), 'hola');
  assert.equal(normalizeStructuredPromptSection(null), '');
  assert.equal(normalizeStructuredPromptSection(undefined), '');
});

test('normalizePromptCapabilityIds: dedupe + lowercase + sorted', () => {
  assert.deepEqual(
    normalizePromptCapabilityIds(['Web_Search', 'web_search', ' Finalize ', 'browser']),
    ['browser', 'finalize', 'web_search'],
  );
  assert.deepEqual(normalizePromptCapabilityIds([]), []);
  assert.deepEqual(normalizePromptCapabilityIds(['', '  ', null]), []);
});

test('stableStringify: deterministic key ordering regardless of insertion', () => {
  const a = { z: 1, a: 2, m: { q: 1, b: 2 } };
  const b = { a: 2, m: { b: 2, q: 1 }, z: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('stableStringify: handles Error, Uint8Array, bigint, non-finite, circular', () => {
  const err = new Error('boom');
  const errJson = stableStringify(err);
  assert.match(errJson, /"message":"boom"/);

  const bytes = stableStringify(new Uint8Array([1, 2, 3]));
  assert.match(bytes, /"type":"Uint8Array"/);

  assert.equal(stableStringify(10n), '"10"');
  assert.equal(stableStringify(Infinity), '"Infinity"');
  assert.equal(stableStringify(NaN), '"NaN"');

  const cyc = { name: 'x' };
  cyc.self = cyc;
  assert.match(stableStringify(cyc), /\[Circular\]/);
});

test('stableStringify: skips functions and undefined values in objects', () => {
  const value = { keep: 1, fn: () => {}, gone: undefined };
  assert.equal(stableStringify(value), '{"keep":1}');
});

test('prompted tools block is byte-identical regardless of registry order', () => {
  const { buildPromptedToolsBlock } = require('../src/services/agents/prompted-tool-calling');
  const t1 = { name: 'web_search', description: 'busca', parameters: { type: 'object', properties: {} } };
  const t2 = { name: 'finalize', description: 'cierra', parameters: { type: 'object', properties: {} } };
  const t3 = { name: 'read_url', description: 'lee', parameters: { type: 'object', properties: {} } };
  const blockA = buildPromptedToolsBlock([t1, t2, t3]);
  const blockB = buildPromptedToolsBlock([t3, t1, t2]);
  assert.equal(blockA, blockB);
  assert.match(blockA, /web_search/);
  assert.match(blockA, /finalize/);
});