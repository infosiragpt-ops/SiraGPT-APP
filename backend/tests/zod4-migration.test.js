'use strict';

/**
 * Backend on zod 4 (GHSA-mrhx-c7xc-m3w5: zod < 4.6.6 can exhaust memory; zod 3
 * has no fix). What the migration must hold:
 *  - one zod for the whole backend, with the fix;
 *  - every harness tool still registers: zod-to-json-schema returns an empty
 *    schema for a zod 4 schema, so all of them failed and runAgentTurn
 *    (which registers them without a try) failed every agentic turn;
 *  - the JSON Schema documents models and clients see keep the shape
 *    zod-to-json-schema gave under zod 3 (expected values below are its
 *    output);
 *  - request ids keep zod 3's uuid() acceptance (any 8-4-4-4-12 hex);
 *  - the time-boxed zod 3 audit exception is gone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const { zodToLegacyJsonSchema } = require('../src/utils/zod-json-schema');
const { createToolRegistry } = require('../src/services/agent-harness/tool-registry');
const { buildHarnessTools } = require('../src/services/agent-harness/run-agent-turn');
const sessionManager = require('../src/services/sandbox/session-manager');
const { toJsonSchema } = require('../src/services/contracts/schema-registry');
const schemas = require('../src/schemas');

function semver(version) {
  return String(version).split('-')[0].split('.').map(Number);
}
function atLeast(version, min) {
  const a = semver(version);
  const b = semver(min);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

test('the backend runs one zod with the fix for GHSA-mrhx-c7xc-m3w5 (>= 4.6.6)', () => {
  assert.ok(atLeast(require('zod/package.json').version, '4.6.6'), require('zod/package.json').version);
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const copies = Object.entries(lock.packages)
    .filter(([key]) => /(^|\/)node_modules\/zod$/.test(key))
    .map(([key, value]) => `${key}@${value.version}`);
  assert.deepEqual(copies.filter((copy) => !atLeast(copy.split('@').pop(), '4.6.6')), [], copies.join(', '));
});

function walk(node, visit, at = '$') {
  if (!node || typeof node !== 'object') return;
  visit(node, at);
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, visit, `${at}.${key}[${i}]`));
    else if (value && typeof value === 'object') walk(value, visit, `${at}.${key}`);
  }
}

test('every harness tool registers, with the zod 3 document shape', () => {
  const realGetSession = sessionManager.getSession;
  sessionManager.getSession = (id) => (id === 'sess-zod4' ? { id, workdir: '/tmp/zod4-migration' } : realGetSession(id));
  let defs;
  try {
    defs = buildHarnessTools(new Set(), { sandboxSessionId: 'sess-zod4', hasAttachments: true, workspaceId: 'ws-zod4' });
  } finally {
    sessionManager.getSession = realGetSession;
  }
  assert.ok(defs.length >= 20, `${defs.length} harness tools`);
  for (const name of ['web_fetch', 'web_search', 'create_artifact', 'run_javascript', 'sandbox_bash', 'document_edit', 'ws_edit']) {
    assert.ok(defs.some((def) => def.name === name), `${name} is built`);
  }
  const registry = createToolRegistry();
  for (const def of defs) {
    const { parameters } = registry.register(def);
    assert.equal(parameters.type, 'object', def.name);
    assert.equal('$schema' in parameters, false, def.name);
    walk(parameters, (node, at) => {
      const where = `${def.name} ${at}`;
      assert.equal('oneOf' in node, false, `${where}: anyOf, not oneOf`);
      assert.equal('propertyNames' in node, false, where);
      if (node.type === 'object' && node.properties) assert.ok('additionalProperties' in node, `${where}: additionalProperties is explicit`);
      if (node.type === 'integer') {
        assert.notEqual(node.minimum, Number.MIN_SAFE_INTEGER, where);
        assert.notEqual(node.maximum, Number.MAX_SAFE_INTEGER, where);
      }
      if (Array.isArray(node.required)) {
        for (const key of node.required) assert.ok(node.properties && key in node.properties, `${where}: required ${key} is a property`);
      }
    });
  }
});

test('z.toJSONSchema output is normalised to what zod-to-json-schema produced under zod 3', () => {
  const cases = [
    [z.object({ a: z.string() }), { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }],
    [z.object({ a: z.string() }).passthrough(), { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: true }],
    [z.object({ a: z.string().default('x'), n: z.number().int().default(3) }),
      { type: 'object', properties: { a: { type: 'string', default: 'x' }, n: { type: 'integer', default: 3 } }, additionalProperties: false }],
    [z.object({ any: z.any(), unk: z.unknown().optional() }), { type: 'object', properties: { any: {}, unk: {} }, additionalProperties: false }],
    [z.object({ i: z.number().int(), ib: z.number().int().min(1).max(50), f: z.number().min(0).max(1), pos: z.number().int().positive() }),
      { type: 'object', properties: { i: { type: 'integer' }, ib: { type: 'integer', minimum: 1, maximum: 50 }, f: { type: 'number', minimum: 0, maximum: 1 }, pos: { type: 'integer', exclusiveMinimum: 0 } }, required: ['i', 'ib', 'f', 'pos'], additionalProperties: false }],
    [z.object({ r: z.record(z.string(), z.unknown()), rs: z.record(z.string(), z.string()) }),
      { type: 'object', properties: { r: { type: 'object', additionalProperties: {} }, rs: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['r', 'rs'], additionalProperties: false }],
    [z.object({ s: z.string().min(1).max(10), re: z.string().regex(/^[a-z]+$/), email: z.string().email(), url: z.string().url() }),
      { type: 'object', properties: { s: { type: 'string', minLength: 1, maxLength: 10 }, re: { type: 'string', pattern: '^[a-z]+$' }, email: { type: 'string', format: 'email' }, url: { type: 'string', format: 'uri' } }, required: ['s', 're', 'email', 'url'], additionalProperties: false }],
    [z.object({ dua: z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), x: z.string() }), z.object({ kind: z.literal('b'), y: z.number() })]) }),
      { type: 'object', properties: { dua: { anyOf: [
        { type: 'object', properties: { kind: { type: 'string', const: 'a' }, x: { type: 'string' } }, required: ['kind', 'x'], additionalProperties: false },
        { type: 'object', properties: { kind: { type: 'string', const: 'b' }, y: { type: 'number' } }, required: ['kind', 'y'], additionalProperties: false },
      ] } }, required: ['dua'], additionalProperties: false }],
    [z.object({ tup: z.tuple([z.string(), z.number()]) }),
      { type: 'object', properties: { tup: { type: 'array', minItems: 2, maxItems: 2, items: [{ type: 'string' }, { type: 'number' }] } }, required: ['tup'], additionalProperties: false }],
    [z.object({ m: z.string().catch('fallback') }), { type: 'object', properties: { m: { type: 'string' } }, additionalProperties: false }],
    [z.string().min(8).regex(/[A-Za-z]/).regex(/[0-9]/), { type: 'string', minLength: 8, allOf: [{ pattern: '[A-Za-z]' }, { pattern: '[0-9]' }] }],
  ];
  for (const [schema, expected] of cases) assert.deepEqual(zodToLegacyJsonSchema(schema), expected);
  assert.throws(() => zodToLegacyJsonSchema({ safeParse() {} }), /zod 4 schema/);
});

test('route/MCP contracts (openApi3 + nullable cleanup) keep null as type null and arrays of anything without items', () => {
  assert.deepEqual(toJsonSchema(z.object({ counts: z.union([z.record(z.string(), z.any()), z.null()]).optional(), hits: z.array(z.unknown()), note: z.string().nullable() })), {
    type: 'object',
    properties: {
      counts: { anyOf: [{ type: 'object', additionalProperties: {} }, { type: 'null' }] },
      hits: { type: 'array' },
      note: { type: ['string', 'null'] },
    },
    required: ['hits', 'note'],
    additionalProperties: false,
  });
});

test('request ids keep zod 3 uuid() acceptance (any 8-4-4-4-12 hex), and still reject garbage', () => {
  const legacyId = '11111111-1111-1111-1111-111111111111'; // not an RFC variant: zod 4's uuid() rejects it
  const message = { role: 'user', content: 'hola' };
  assert.equal(schemas.inlineFileSchema.safeParse({ id: legacyId, name: 'a.txt' }).success, true);
  assert.equal(schemas.aiGenerateRequestSchema.safeParse({ messages: [message], projectId: legacyId }).success, true);
  assert.equal(schemas.aiGenerateRequestSchema.safeParse({ messages: [message], projectId: 'not-an-id' }).success, false);
  assert.equal(schemas.inlineFileSchema.safeParse({ id: '1111-2222', name: 'a.txt' }).success, false);
});

test('the time-boxed zod audit exception is gone', () => {
  const file = path.join(__dirname, '..', '..', 'scripts', 'audit-backend-exceptions.json');
  const { exceptions } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(exceptions.filter((entry) => entry.package === 'zod'), []);
});
