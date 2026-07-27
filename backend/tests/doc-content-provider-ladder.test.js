'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resolveContentClient,
  resolveContentClients,
  hasAnyContentKey,
  sanitizeResponseFormat,
  stripSchemaConstraints,
  wrapClientForProvider,
} = require('../src/services/document-pipeline/content/llm-client');

test('ladder picks Cerebras (gpt-oss-120b) when only CEREBRAS_API_KEY is live', () => {
  const env = { CEREBRAS_API_KEY: 'k', FREE_IA_MODEL_ID: 'gpt-oss-120b' };
  const r = resolveContentClient({ env });
  assert.equal(r.provider, 'Cerebras');
  assert.equal(r.model, 'gpt-oss-120b');
  assert.ok(r.client);
});

test('ladder falls through a DEAD OpenAI key to the next live provider', () => {
  // OpenAI present but no live check — the ladder order is Cerebras first, so
  // when both exist Cerebras wins; when only OpenRouter+OpenAI exist, OpenRouter wins.
  const env = { OPENROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oai-dead' };
  const r = resolveContentClient({ env });
  assert.equal(r.provider, 'OpenRouter');
  assert.equal(r.model, 'openai/gpt-4o-mini');
});

test('OpenAI is used only when it is the sole configured provider', () => {
  const r = resolveContentClient({ env: { OPENAI_API_KEY: 'oai' } });
  assert.equal(r.provider, 'OpenAI');
});

test('DOC_CONTENT_PROVIDER forces the head of the ladder when its key exists', () => {
  const env = { CEREBRAS_API_KEY: 'c', OPENROUTER_API_KEY: 'or', DOC_CONTENT_PROVIDER: 'OpenRouter' };
  assert.equal(resolveContentClient({ env }).provider, 'OpenRouter');
  assert.deepEqual(resolveContentClients({ env }).map((entry) => entry.provider), ['OpenRouter', 'Cerebras']);
});

test('content provider list exposes every configured failover without keys', () => {
  const env = { CEREBRAS_API_KEY: 'c', OPENROUTER_API_KEY: 'or', OPENAI_API_KEY: 'oai' };
  const providers = resolveContentClients({ env });
  assert.deepEqual(providers.map((entry) => entry.provider), ['Cerebras', 'OpenRouter', 'OpenAI']);
  assert.equal(providers.some((entry) => Object.prototype.hasOwnProperty.call(entry, 'apiKey')), false);
});

test('returns null when NO provider key is configured (degraded/fallback mode)', () => {
  assert.equal(resolveContentClient({ env: {} }), null);
  assert.equal(hasAnyContentKey({}), false);
  assert.equal(hasAnyContentKey({ CEREBRAS_API_KEY: 'k' }), true);
});

test('per-deployment model overrides are honoured', () => {
  const env = { CEREBRAS_API_KEY: 'c', DOC_CONTENT_CEREBRAS_MODEL: 'zai-glm-4.7' };
  assert.equal(resolveContentClient({ env }).model, 'zai-glm-4.7');
});

// ── Cerebras JSON-schema compatibility shim ────────────────────────────────
// The real root cause of "documentos de relleno": Cerebras 400s on the
// minItems/maxItems keywords our SECTION_CONTENT_SCHEMA uses, so every section
// fell to template filler. These lock in the strip that fixed it.
const RICH_RF = {
  type: 'json_schema',
  json_schema: {
    name: 'section_content',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paragraph: { type: 'string', minLength: 80, maxLength: 900 },
        bullets: { type: 'array', minItems: 4, maxItems: 6, uniqueItems: true, items: { type: 'string', minLength: 3 } },
        notes: { type: 'string', pattern: '^.+$' },
      },
      required: ['paragraph', 'bullets', 'notes'],
    },
  },
};

test('Cerebras: unsupported JSON-schema keywords are stripped, structure kept', () => {
  const clean = sanitizeResponseFormat(RICH_RF, 'Cerebras');
  const j = JSON.stringify(clean);
  for (const kw of ['minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern']) {
    assert.ok(!j.includes(kw), `${kw} should be stripped for Cerebras`);
  }
  // shape preserved
  assert.equal(clean.json_schema.strict, true);
  assert.equal(clean.json_schema.schema.type, 'object');
  assert.equal(clean.json_schema.schema.additionalProperties, false);
  assert.deepEqual(clean.json_schema.schema.required, ['paragraph', 'bullets', 'notes']);
  assert.equal(clean.json_schema.schema.properties.bullets.items.type, 'string');
});

test('non-Cerebras providers keep the full constraint set (pass-through by ref)', () => {
  const same = sanitizeResponseFormat(RICH_RF, 'OpenAI');
  assert.strictEqual(same, RICH_RF);
  assert.ok(JSON.stringify(same).includes('minItems'));
});

test('sanitize does not mutate the caller schema', () => {
  sanitizeResponseFormat(RICH_RF, 'Cerebras');
  assert.ok(JSON.stringify(RICH_RF).includes('minItems'), 'original must stay intact');
});

test('stripSchemaConstraints recurses through nested arrays/objects', () => {
  const nested = { a: { b: [{ minItems: 1, items: { minLength: 2, type: 'string' } }] }, keep: true };
  const out = stripSchemaConstraints(nested);
  assert.equal(JSON.stringify(out).includes('minItems'), false);
  assert.equal(JSON.stringify(out).includes('minLength'), false);
  assert.equal(out.keep, true);
  assert.equal(out.a.b[0].items.type, 'string');
});

test('wrapClientForProvider sanitises response_format inside create() for Cerebras', async () => {
  let seen = null;
  const fakeClient = { chat: { completions: { create: async (body) => { seen = body; return { choices: [{ message: { content: '{}' } }] }; } } } };
  const wrapped = wrapClientForProvider(fakeClient, 'Cerebras');
  await wrapped.chat.completions.create({ model: 'm', response_format: RICH_RF, messages: [] });
  assert.ok(seen, 'create must be invoked');
  assert.ok(!JSON.stringify(seen.response_format).includes('minItems'), 'minItems must be stripped before the call');
});

test('wrapClientForProvider is a no-op for non-Cerebras providers', async () => {
  let seen = null;
  const fakeClient = { chat: { completions: { create: async (body) => { seen = body; return {}; } } } };
  const wrapped = wrapClientForProvider(fakeClient, 'OpenAI');
  await wrapped.chat.completions.create({ model: 'm', response_format: RICH_RF, messages: [] });
  assert.ok(JSON.stringify(seen.response_format).includes('minItems'), 'OpenAI keeps constraints');
});
