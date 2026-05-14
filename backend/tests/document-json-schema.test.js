'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-json-schema');
const { extractJsonSchema, buildJsonSchemaForFiles, renderJsonSchemaBlock, _internal } = engine;
const { classifyKey } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractJsonSchema('').total, 0);
  assert.equal(extractJsonSchema(null).total, 0);
});

test('classifyKey: categories', () => {
  assert.equal(classifyKey('$schema'), 'meta');
  assert.equal(classifyKey('string'), 'type');
  assert.equal(classifyKey('required'), 'validation');
  assert.equal(classifyKey('oneOf'), 'composition');
  assert.equal(classifyKey('properties'), 'structural');
});

test('detects $schema metadata', () => {
  const r = extractJsonSchema('{"$schema": "https://json-schema.org/draft/2020-12/schema"}');
  assert.ok(r.entries.some((e) => e.key === '$schema'));
});

test('detects $ref / $defs references', () => {
  const r = extractJsonSchema('{"$ref": "#/$defs/MyType", "$defs": {}}');
  assert.ok(r.entries.some((e) => e.key === '$ref'));
});

test('detects type: string/number/object', () => {
  const r = extractJsonSchema('{"type": "string"} {"type": "object"}');
  assert.equal(r.totals.type, 2);
});

test('detects validation keywords', () => {
  const r = extractJsonSchema('{"minLength": 3, "maxLength": 20, "pattern": "^[a-z]+$"}');
  assert.ok(r.entries.some((e) => e.key === 'minLength'));
  assert.ok(r.entries.some((e) => e.key === 'maxLength'));
  assert.ok(r.entries.some((e) => e.key === 'pattern'));
});

test('detects composition oneOf/anyOf/allOf', () => {
  const r = extractJsonSchema('{"oneOf": [], "anyOf": [], "allOf": []}');
  assert.equal(r.totals.composition, 3);
});

test('detects structural properties/items', () => {
  const r = extractJsonSchema('{"properties": {}, "items": {}, "additionalProperties": false}');
  assert.ok(r.totals.structural >= 3);
});

test('detects format keyword', () => {
  const r = extractJsonSchema('{"format": "email"}');
  assert.ok(r.entries.some((e) => e.key === 'format'));
});

test('detects enum and const', () => {
  const r = extractJsonSchema('{"enum": ["a", "b"], "const": "x"}');
  assert.ok(r.entries.some((e) => e.key === 'enum'));
  assert.ok(r.entries.some((e) => e.key === 'const'));
});

test('dedupes identical keys with same value', () => {
  const r = extractJsonSchema('{"type": "string"} {"type": "string"}');
  assert.equal(r.entries.filter((e) => e.key === 'string').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const keys = ['$schema', '$id', '$ref', 'title', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum', 'const', 'format', 'oneOf', 'anyOf', 'allOf', 'not', 'properties', 'items', 'additionalProperties', 'patternProperties', 'propertyNames', 'contains', 'minItems', 'maxItems'];
  for (const k of keys) text += `"${k}": ${k.startsWith('$') ? '"x"' : '{}'}`;
  const r = extractJsonSchema(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by category', () => {
  const r = extractJsonSchema('{"$schema": "x", "type": "string", "required": [], "oneOf": [], "properties": {}}');
  assert.ok(r.totals.meta >= 1);
  assert.ok(r.totals.type >= 1);
  assert.ok(r.totals.validation >= 1);
  assert.ok(r.totals.composition >= 1);
  assert.ok(r.totals.structural >= 1);
});

test('buildJsonSchemaForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.json', extractedText: '{"$schema": "x", "type": "string"}' },
    { name: 'b.json', extractedText: '{"type": "object", "properties": {}}' },
  ];
  const r = buildJsonSchemaForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderJsonSchemaBlock returns markdown when entries exist', () => {
  const files = [{ name: 'schema.json', extractedText: '{"$schema": "x", "type": "string"}' }];
  const r = buildJsonSchemaForFiles(files);
  const md = renderJsonSchemaBlock(r);
  assert.match(md, /^## JSON SCHEMA/);
});

test('renderJsonSchemaBlock empty when nothing surfaces', () => {
  assert.equal(renderJsonSchemaBlock({ perFile: [] }), '');
  assert.equal(renderJsonSchemaBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildJsonSchemaForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '{"type": "string"}' },
  ]);
  assert.equal(r.perFile.length, 1);
});
