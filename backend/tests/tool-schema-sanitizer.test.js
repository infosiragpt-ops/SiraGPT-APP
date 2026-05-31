'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeJsonSchema,
  sanitizeToolParameters,
  sanitizeOpenAITool,
  sanitizeTools,
  profileFor,
} = require('../src/services/ai-product-os/tool-schema-sanitizer');

test('profileFor maps providers to profiles', () => {
  assert.equal(profileFor('openai'), 'default');
  assert.equal(profileFor('deepseek'), 'default');
  assert.equal(profileFor('xai'), 'default');
  assert.equal(profileFor(undefined), 'default');
  assert.equal(profileFor('anthropic'), 'anthropic');
  assert.equal(profileFor('claude-sonnet-4-6'), 'anthropic');
  assert.equal(profileFor('google'), 'gemini');
  assert.equal(profileFor('gemini-2.5-flash'), 'gemini');
});

test('total: garbage input yields an object schema (params)', () => {
  assert.deepEqual(sanitizeToolParameters(undefined), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeToolParameters(null), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeToolParameters(42), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeToolParameters('nope'), { type: 'object', properties: {} });
  assert.deepEqual(sanitizeToolParameters([]), { type: 'object', properties: {} });
});

test('bare object gains an empty properties map', () => {
  assert.deepEqual(sanitizeJsonSchema({ type: 'object' }), { type: 'object', properties: {} });
});

test('implicit object (properties without type) gains type:object', () => {
  const out = sanitizeJsonSchema({ properties: { a: { type: 'string' } } });
  assert.equal(out.type, 'object');
  assert.deepEqual(out.properties.a, { type: 'string' });
});

test('union type array collapses, lifting null to nullable', () => {
  const out = sanitizeJsonSchema({
    type: 'object',
    properties: { name: { type: ['string', 'null'], description: 'x' } },
  });
  assert.deepEqual(out.properties.name, { description: 'x', type: 'string', nullable: true });
});

test('type array of only null defaults to nullable string', () => {
  const out = sanitizeJsonSchema({ type: ['null'] });
  assert.equal(out.type, 'string');
  assert.equal(out.nullable, true);
});

test('anyOf null-union collapses to the non-null branch', () => {
  const out = sanitizeJsonSchema({
    type: 'object',
    properties: { age: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] } },
  });
  assert.deepEqual(out.properties.age, { type: 'integer', minimum: 0, nullable: true });
});

test('oneOf null-union collapses too', () => {
  const out = sanitizeJsonSchema({ oneOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(out, { type: 'string', nullable: true });
});

test('non-null multi-branch anyOf is preserved (default profile)', () => {
  const out = sanitizeJsonSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] });
  assert.ok(Array.isArray(out.anyOf));
  assert.equal(out.anyOf.length, 2);
});

test('nested array items are sanitized recursively', () => {
  const out = sanitizeJsonSchema({
    type: 'object',
    properties: {
      rows: { type: 'array', items: { type: 'object' } },
    },
  });
  assert.deepEqual(out.properties.rows.items, { type: 'object', properties: {} });
});

test('array tuple items collapse to the first item schema', () => {
  const out = sanitizeJsonSchema({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] });
  assert.deepEqual(out.items, { type: 'string' });
});

test('array without items gets a permissive items schema', () => {
  const out = sanitizeJsonSchema({ type: 'array' });
  assert.deepEqual(out.items, {});
});

test('required is pruned to existing string properties', () => {
  const out = sanitizeJsonSchema({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a', 'ghost', 7],
  });
  assert.deepEqual(out.required, ['a']);
});

test('required referencing no real property is dropped', () => {
  const out = sanitizeJsonSchema({ type: 'object', properties: {}, required: ['ghost'] });
  assert.ok(!('required' in out));
});

test('a clean schema is preserved (value-equal)', () => {
  const clean = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 15 },
    },
    required: ['query'],
    additionalProperties: false,
  };
  assert.deepEqual(sanitizeJsonSchema(clean), clean);
});

test('does not mutate its input', () => {
  const input = { type: 'object', properties: { x: { type: ['string', 'null'] } } };
  const snapshot = JSON.parse(JSON.stringify(input));
  sanitizeJsonSchema(input);
  assert.deepEqual(input, snapshot);
});

test('idempotent', () => {
  const input = {
    type: 'object',
    properties: {
      a: { type: ['string', 'null'] },
      b: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      c: { type: 'array', items: { type: 'object' } },
    },
    required: ['a'],
  };
  const once = sanitizeJsonSchema(input);
  const twice = sanitizeJsonSchema(once);
  assert.deepEqual(twice, once);
});

test('gemini profile strips unsupported keywords', () => {
  const out = sanitizeJsonSchema(
    {
      type: 'object',
      additionalProperties: true,
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { a: { type: 'string', default: 'x', title: 'A' } },
    },
    { provider: 'gemini' },
  );
  assert.ok(!('additionalProperties' in out));
  assert.ok(!('$schema' in out));
  assert.ok(!('default' in out.properties.a));
  assert.ok(!('title' in out.properties.a));
  assert.equal(out.properties.a.type, 'string');
});

test('gemini profile converts const to single-value enum', () => {
  const out = sanitizeJsonSchema({ const: 'fixed' }, { provider: 'gemini' });
  assert.deepEqual(out.enum, ['fixed']);
  assert.ok(!('const' in out));
});

test('default profile keeps additionalProperties and const', () => {
  const out = sanitizeJsonSchema({ type: 'object', additionalProperties: false, properties: {} });
  assert.equal(out.additionalProperties, false);
  const c = sanitizeJsonSchema({ const: 7 });
  assert.equal(c.const, 7);
});

test('sanitizeOpenAITool normalizes function.parameters', () => {
  const tool = {
    type: 'function',
    function: { name: 'foo', description: 'd', parameters: { type: 'object' } },
  };
  const out = sanitizeOpenAITool(tool);
  assert.equal(out.function.name, 'foo');
  assert.deepEqual(out.function.parameters, { type: 'object', properties: {} });
  // original untouched
  assert.ok(!('properties' in tool.function.parameters));
});

test('sanitizeOpenAITool handles the bare {name,parameters} shape', () => {
  const out = sanitizeOpenAITool({ name: 'bar', parameters: { type: 'object' } });
  assert.deepEqual(out.parameters, { type: 'object', properties: {} });
});

test('sanitizeOpenAITool tolerates a tool with no parameters', () => {
  const out = sanitizeOpenAITool({ name: 'noargs' });
  assert.deepEqual(out, { name: 'noargs' });
});

test('sanitizeTools maps an array and passes through non-arrays', () => {
  const out = sanitizeTools([{ name: 'a', parameters: { type: 'object' } }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].parameters, { type: 'object', properties: {} });
  assert.equal(sanitizeTools(null), null);
});

test('deep nesting does not throw', () => {
  let schema = { type: 'object', properties: {} };
  let cursor = schema;
  for (let i = 0; i < 50; i += 1) {
    cursor.properties.child = { type: 'object', properties: {} };
    cursor = cursor.properties.child;
  }
  assert.doesNotThrow(() => sanitizeJsonSchema(schema));
});
