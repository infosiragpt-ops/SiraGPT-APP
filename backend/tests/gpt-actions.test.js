'use strict';

// Unit tests for backend/src/services/gpts/gpt-actions.js — GPT Actions:
// validation/normalisation, secret encryption round-trip + redaction, the
// JSON-schema builder, the SSRF-hardened executor (with injected fetch+lookup),
// and the agent-tool builder. No real network or DNS.
//
// ENCRYPTION_KEY must be set BEFORE requiring the module's encryption path
// (encryption.js process.exit(1)s without it). We set a deterministic 64-hex
// key here so the encrypt/decrypt round-trip is exercised for real.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');

const actions = require('../src/services/gpts/gpt-actions');

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(bodyText, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) },
    body: null,
    async text() { return bodyText; },
  };
}

const VALID_ACTION = {
  name: 'get_weather',
  description: 'Obtiene el clima actual de una ciudad.',
  method: 'GET',
  url: 'https://api.example.com/weather',
  params: [{ name: 'city', in: 'query', type: 'string', required: true, description: 'Ciudad' }],
  auth: { type: 'none' },
};

// ── Validation ──────────────────────────────────────────────────────────────

test('validateActionDefinition accepts a well-formed action', () => {
  const v = actions.validateActionDefinition(VALID_ACTION);
  assert.equal(v.ok, true);
  assert.equal(v.normalized.name, 'get_weather');
  assert.equal(v.normalized.method, 'GET');
  assert.equal(v.normalized.params.length, 1);
});

test('validateActionDefinition rejects missing name/description/url', () => {
  const v = actions.validateActionDefinition({ method: 'GET' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 3);
});

test('validateActionDefinition rejects non-public / non-https URLs (SSRF)', () => {
  for (const url of [
    'http://localhost/x',
    'http://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/internal',
    'ftp://example.com/x',
    'http://metadata.google.internal/',
    // IPv4-mapped IPv6 must not smuggle a loopback/metadata address past us.
    'http://[::ffff:127.0.0.1]/admin',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::1]/x',
  ]) {
    const v = actions.validateActionDefinition({ ...VALID_ACTION, url });
    assert.equal(v.ok, false, `should reject ${url}`);
  }
});

test('validateActionDefinition rejects reserved tool names', () => {
  for (const name of ['finalize', 'Final_Answer', 'multi_tool_use']) {
    const v = actions.validateActionDefinition({ ...VALID_ACTION, name });
    assert.equal(v.ok, false, `should reject reserved name ${name}`);
  }
});

test('validateActionDefinition rejects a URL placeholder with no path param', () => {
  const v = actions.validateActionDefinition({
    ...VALID_ACTION,
    url: 'https://api.example.com/users/{id}',
    params: [],
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('{id}')));
});

test('sanitizeActionName makes a tool-safe function name', () => {
  assert.equal(actions.sanitizeActionName('Get Weather!'), 'get_weather');
  assert.equal(actions.sanitizeActionName('123 go'), 'a_123_go');
  assert.equal(actions.sanitizeActionName('  --- '), '');
});

// ── Secret persistence: encrypt / preserve / redact ─────────────────────────

test('normalizeActionsForStore encrypts a new secret and never stores plaintext', () => {
  const stored = actions.normalizeActionsForStore([
    { ...VALID_ACTION, auth: { type: 'bearer', secret: 'super-secret-token' } },
  ]);
  assert.equal(stored.length, 1);
  assert.ok(stored[0].id, 'minted an id');
  assert.equal(stored[0].auth.type, 'bearer');
  assert.ok(stored[0].auth.encryptedValue, 'has encryptedValue');
  assert.equal(stored[0].auth.secret, undefined, 'no plaintext secret stored');
  assert.notEqual(stored[0].auth.encryptedValue, 'super-secret-token');
});

test('normalizeActionsForStore preserves an existing secret on edit (no new secret)', () => {
  const first = actions.normalizeActionsForStore([
    { ...VALID_ACTION, auth: { type: 'api_key', in: 'header', name: 'X-Key', secret: 'k1' } },
  ]);
  const id = first[0].id;
  const enc = first[0].auth.encryptedValue;
  // Edit: same id, description changed, NO new secret provided.
  const edited = actions.normalizeActionsForStore(
    [{ ...VALID_ACTION, id, description: 'Cambiada', auth: { type: 'api_key', in: 'header', name: 'X-Key' } }],
    first,
  );
  assert.equal(edited[0].id, id, 'id preserved');
  assert.equal(edited[0].auth.encryptedValue, enc, 'secret preserved');
  assert.equal(edited[0].description, 'Cambiada');
});

test('normalizeActionsForStore drops invalid actions and caps the count', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...VALID_ACTION, name: `act_${i}` }));
  many.push({ name: '', description: '', url: 'http://localhost' }); // invalid
  const stored = actions.normalizeActionsForStore(many);
  assert.ok(stored.length <= actions.MAX_ACTIONS_PER_GPT);
  assert.ok(stored.every((a) => a.name && a.url));
});

test('redactActionsForClient strips the secret and exposes hasSecret', () => {
  const stored = actions.normalizeActionsForStore([
    { ...VALID_ACTION, auth: { type: 'bearer', secret: 'tok' } },
  ]);
  const redacted = actions.redactActionsForClient(stored);
  assert.equal(redacted[0].auth.encryptedValue, undefined);
  assert.equal(redacted[0].auth.secret, undefined);
  assert.equal(redacted[0].auth.hasSecret, true);
});

// ── Parameters schema ───────────────────────────────────────────────────────

test('buildParametersSchema emits a valid OpenAI tool schema', () => {
  const { normalized } = actions.validateActionDefinition({
    ...VALID_ACTION,
    params: [
      { name: 'city', in: 'query', type: 'string', required: true },
      { name: 'days', in: 'query', type: 'number', required: false },
    ],
  });
  const schema = actions.buildParametersSchema(normalized);
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.city.type, 'string');
  assert.equal(schema.properties.days.type, 'number');
  assert.deepEqual(schema.required, ['city']);
  assert.equal(schema.additionalProperties, false);
});

// ── Executor (SSRF-hardened) ────────────────────────────────────────────────

test('executeActionRequest builds a GET with query params and returns the body', async () => {
  const { normalized } = actions.validateActionDefinition(VALID_ACTION);
  const fetchImpl = fakeFetch(() => jsonResponse('{"temp":21}'));
  const res = await actions.executeActionRequest(normalized, { city: 'Lima' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(res.status, 200);
  assert.match(res.body, /temp/);
  assert.match(fetchImpl.calls[0].url, /city=Lima/);
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
});

test('executeActionRequest substitutes path params', async () => {
  const { normalized } = actions.validateActionDefinition({
    ...VALID_ACTION,
    url: 'https://api.example.com/users/{id}',
    params: [{ name: 'id', in: 'path', type: 'string', required: true }],
  });
  const fetchImpl = fakeFetch(() => jsonResponse('{}'));
  await actions.executeActionRequest(normalized, { id: 'abc 7' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.match(fetchImpl.calls[0].url, /\/users\/abc%207/);
});

test('executeActionRequest sends a JSON body for POST body params + bearer auth', async () => {
  const stored = actions.normalizeActionsForStore([
    {
      ...VALID_ACTION,
      method: 'POST',
      url: 'https://api.example.com/notes',
      params: [{ name: 'text', in: 'body', type: 'string', required: true }],
      auth: { type: 'bearer', secret: 'tok-123' },
    },
  ]);
  // Re-attach the encrypted secret as the persisted record would carry it.
  const action = stored[0];
  const fetchImpl = fakeFetch(() => jsonResponse('{"id":1}', { status: 201 }));
  const res = await actions.executeActionRequest(action, { text: 'hola' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(res.status, 201);
  const init = fetchImpl.calls[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(JSON.parse(init.body).text, 'hola');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['Authorization'], 'Bearer tok-123');
});

test('executeActionRequest applies api_key auth in header and query', async () => {
  const headerAction = actions.normalizeActionsForStore([
    { ...VALID_ACTION, auth: { type: 'api_key', in: 'header', name: 'X-Key', secret: 'h-secret' } },
  ])[0];
  let fetchImpl = fakeFetch(() => jsonResponse('{}'));
  await actions.executeActionRequest(headerAction, { city: 'x' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(fetchImpl.calls[0].init.headers['X-Key'], 'h-secret');

  const queryAction = actions.normalizeActionsForStore([
    { ...VALID_ACTION, auth: { type: 'api_key', in: 'query', name: 'apikey', secret: 'q-secret' } },
  ])[0];
  fetchImpl = fakeFetch(() => jsonResponse('{}'));
  await actions.executeActionRequest(queryAction, { city: 'x' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.match(fetchImpl.calls[0].url, /apikey=q-secret/);
});

test('executeActionRequest blocks a redirect to a private address (manual re-validation)', async () => {
  const { normalized } = actions.validateActionDefinition(VALID_ACTION);
  const fetchImpl = fakeFetch((url, _init, i) => {
    if (i === 0) return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://169.254.169.254/' : null) }, body: null, async text() { return ''; } };
    return jsonResponse('{}');
  });
  await assert.rejects(
    actions.executeActionRequest(normalized, { city: 'x' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP }),
  );
});

test('executeActionRequest strips the auth secret on a cross-origin redirect', async () => {
  const action = actions.normalizeActionsForStore([{ ...VALID_ACTION, auth: { type: 'bearer', secret: 'super-secret-token' } }])[0];
  const fetchImpl = fakeFetch((url, _init, i) => {
    if (i === 0) return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://evil.example.org/' : null) }, body: null, async text() { return ''; } };
    return jsonResponse('{"ok":true}');
  });
  await actions.executeActionRequest(action, { city: 'Lima' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer super-secret-token');
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, undefined, 'auth must not follow a cross-origin redirect');
});

test('executeActionRequest keeps auth on a same-origin redirect', async () => {
  const action = actions.normalizeActionsForStore([{ ...VALID_ACTION, auth: { type: 'bearer', secret: 'tok' } }])[0];
  const fetchImpl = fakeFetch((url, _init, i) => {
    if (i === 0) return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://api.example.com/weather/v2' : null) }, body: null, async text() { return ''; } };
    return jsonResponse('{"ok":true}');
  });
  await actions.executeActionRequest(action, { city: 'Lima' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(fetchImpl.calls[1].init.headers.Authorization, 'Bearer tok', 'same-origin redirect keeps auth');
});

test('executeActionRequest is blocked when DNS resolves to a private address', async () => {
  const { normalized } = actions.validateActionDefinition(VALID_ACTION);
  const fetchImpl = fakeFetch(() => jsonResponse('{}'));
  const rebindLookup = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    actions.executeActionRequest(normalized, { city: 'x' }, { fetch: fetchImpl, lookup: rebindLookup }),
  );
  assert.equal(fetchImpl.calls.length, 0, 'never fetched');
});

test('executeActionRequest throws on a missing required param', async () => {
  const { normalized } = actions.validateActionDefinition(VALID_ACTION);
  const fetchImpl = fakeFetch(() => jsonResponse('{}'));
  await assert.rejects(
    actions.executeActionRequest(normalized, {}, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP }),
    /city/,
  );
});

test('executeActionRequest caps an oversized response body', async () => {
  const { normalized } = actions.validateActionDefinition(VALID_ACTION);
  const big = 'x'.repeat(actions.ACTION_MAX_RESPONSE_CHARS + 5000);
  const fetchImpl = fakeFetch(() => jsonResponse(big));
  const res = await actions.executeActionRequest(normalized, { city: 'x' }, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(res.truncated, true);
  assert.ok(res.body.length <= actions.ACTION_MAX_RESPONSE_CHARS + 32);
});

// ── Tool builder ────────────────────────────────────────────────────────────

test('buildActionTools yields executable tools and never throws on failure', async () => {
  const stored = actions.normalizeActionsForStore([VALID_ACTION]);
  const fetchImpl = fakeFetch(() => { throw new Error('network boom'); });
  const tools = actions.buildActionTools(stored, { fetch: fetchImpl, lookup: PUBLIC_LOOKUP });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'get_weather');
  assert.equal(typeof tools[0].execute, 'function');
  assert.equal(tools[0].parameters.type, 'object');
  const out = await tools[0].execute({ city: 'x' });
  assert.equal(out.error, true, 'failure surfaced as a result, not a throw');
});

test('buildActionTools dedupes by name and skips invalid actions', () => {
  const tools = actions.buildActionTools([
    VALID_ACTION,
    { ...VALID_ACTION }, // duplicate name
    { name: '', description: '', url: 'http://localhost' }, // invalid
  ]);
  assert.equal(tools.length, 1);
});
