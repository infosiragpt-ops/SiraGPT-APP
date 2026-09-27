'use strict';

/**
 * Admin → Logs noise control + clear connection-test verdicts.
 *   - «not configured» / «feature disabled» is a configuration state, never a
 *     user-facing error (client-event intake, turn tracker, generation rows);
 *   - GET /api/elevenlabs/voices|models answer 200 `{ configured:false }`
 *     without a key (the /agentes pickers asked on every page load → 400 noise)
 *     and read the key per request (admin-connections bridge applies it later);
 *   - POST /api/admin/connections/:id/test answers 200 `{ ok:false, reason }`
 *     when the PROVIDER rejects the key — only our own faults are 5xx.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { buildRouteTestApp, mockResolvedModule, reloadModule } = require('./http-test-utils');
const { CONFIG_STATE_RE, isConfigStateMessage } = require('../src/services/observability/config-state');
const {
  isExpectedConfigClientEvent,
  sanitizeClientEvent,
} = require('../src/services/client-event-log');
const {
  describeConnectionProbeFailure,
  redactProbeDetail,
} = require('../src/services/connection-probe-reason');

describe('config-state — «not configured» is not an error', () => {
  it('matches the platform phrasings (EN/ES, codes) and nothing else', () => {
    for (const text of [
      'ElevenLabs API key not configured',
      'OPENAI_API_KEY not configured — agents unavailable',
      'telegram_not_configured',
      'El servicio de voz no está configurado.',
      'Feature disabled on this server',
      '{"code":"provider_not_configured"}',
      'Stripe not configured',
    ]) assert.ok(isConfigStateMessage(text), text);
    for (const text of ['Invalid API key', 'Internal server error', 'quota exceeded', 'Account disabled by admin']) {
      assert.equal(isConfigStateMessage(text), false, text);
    }
    assert.ok(CONFIG_STATE_RE instanceof RegExp);
  });

  it('the telemetry intake drops config-state API events (old bundles keep sending them)', () => {
    const voices = sanitizeClientEvent({
      source: 'api', severity: 'warn', status: 400, method: 'GET', endpoint: '/elevenlabs/voices',
      message: 'ElevenLabs API key not configured',
    });
    assert.equal(isExpectedConfigClientEvent(voices), true);
    const real = sanitizeClientEvent({ source: 'api', status: 502, endpoint: '/admin/connections/x/test', message: 'Server error' });
    assert.equal(isExpectedConfigClientEvent(real), false);
    const render = sanitizeClientEvent({ source: 'render', message: 'not configured' });
    assert.equal(isExpectedConfigClientEvent(render), false, 'only API answers are config states');
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/telemetry.js'), 'utf8');
    assert.match(route, /\|\| isExpectedConfigClientEvent\(event\);/);
  });
});

describe('connection probe verdicts («Probar»)', () => {
  const d = (probe) => describeConnectionProbeFailure(probe);
  it('says what the provider answered, in Spanish', () => {
    assert.equal(d({ providerKey: 'openai', status: 401, error: 'HTTP 401 {"error":{"message":"Incorrect API key provided: sk-proj-****abcd"}}' }), 'La API de OpenAI rechazó la clave (401).');
    assert.equal(d({ providerKey: 'openrouter', status: 402, error: 'HTTP 402 Insufficient credits' }), 'La cuenta de OpenRouter no tiene saldo o créditos (402).');
    assert.equal(d({ providerKey: 'openai', status: 429, error: 'You exceeded your current quota' }), 'La cuenta de OpenAI no tiene saldo o créditos (429).');
    assert.equal(d({ providerKey: 'xai', status: 429, error: 'rate limited' }), 'La API de xAI está limitando las peticiones (429). Prueba de nuevo en un momento.');
    assert.equal(d({ providerKey: 'gemini', status: 400, error: 'API key not valid. Please pass a valid API key.' }), 'La API de Gemini rechazó la clave (400).');
    assert.equal(d({ providerKey: 'custom', providerLabel: 'Custom', status: 404, error: 'HTTP 404' }), 'La API del proveedor no encontró la ruta /models (404): revisa la URL base.');
    assert.equal(d({ providerKey: 'deepseek', status: 503, error: 'HTTP 503' }), 'La API de DeepSeek respondió con un error de su servidor (503). Prueba más tarde.');
    assert.equal(d({ providerKey: 'meta', status: 0, error: 'The operation was aborted due to timeout' }), 'La API de Meta no respondió a tiempo.');
    assert.equal(d({ providerKey: 'anthropic', status: 0, error: 'getaddrinfo ENOTFOUND api.anthropic.com' }), 'No se pudo resolver el dominio de Anthropic: revisa la URL base.');
    assert.equal(d({ providerKey: 'elevenlabs', status: 0, error: 'missing_api_key' }), 'Falta la API key de ElevenLabs.');
    assert.equal(d({ providerKey: 'custom', error: 'missing_url' }), 'Falta la URL base de la conexión.');
    assert.equal(d({ providerKey: 'custom', providerLabel: 'Mi gateway', status: 0, error: 'bad_json: Unexpected token <' }), 'Mi gateway respondió algo que no es JSON: revisa la URL base.');
  });

  it('never echoes a key back', () => {
    const out = redactProbeDetail('Incorrect API key provided: sk-proj-AbCdEf123456. Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk and AIzaSyA-1234567890abcdefg');
    assert.doesNotMatch(out, /sk-proj-AbCdEf|eyJhbGci|AIzaSyA-1234/);
    assert.match(out, /\[clave\]/);
  });
});

describe('POST /api/admin/connections/:id/test — provider rejection is an answer, not a 5xx', () => {
  const restores = [];
  let app;
  let lastUpdate = null;
  let syncResult = { ok: false, status: 401, error: 'HTTP 401 {"error":{"message":"Incorrect API key provided: sk-proj-Zz99887766"}}' };
  let findUnique = async () => ({ id: 'conn-1', providerKey: 'openai', providerLabel: 'OpenAI', url: 'https://api.openai.com/v1', authType: 'Bearer', apiKey: 'enc', modelIds: [] });

  before(() => {
    restores.push(mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: (req, _res, next) => { req.user = { id: 'admin-1', isAdmin: true, isSuperAdmin: true }; next(); },
    }));
    restores.push(mockResolvedModule(require.resolve('../src/services/admin-route-policy'), (_req, _res, next) => next()));
    restores.push(mockResolvedModule(require.resolve('../src/config/database'), {
      adminConnection: {
        findUnique: (...args) => findUnique(...args),
        update: async (args) => { lastUpdate = args; return {}; },
      },
    }));
    restores.push(mockResolvedModule(require.resolve('../src/utils/encryption'), { encrypt: (v) => v, decrypt: () => 'sk-test' }));
    restores.push(mockResolvedModule(require.resolve('../src/services/admin-connections-bridge'), {
      applyAdminConnections: async () => {},
      reconcileCatalog: async () => ({}),
    }));
    restores.push(mockResolvedModule(require.resolve('../src/services/model-sync-service'), {
      syncConnectionModels: async () => syncResult,
    }));
    restores.push(mockResolvedModule(require.resolve('../src/middleware/response-cache'), { invalidate: () => {} }));
    app = buildRouteTestApp('/api/admin/connections', reloadModule('../src/routes/admin-connections'));
  });

  after(() => {
    while (restores.length) restores.pop()();
    delete require.cache[require.resolve('../src/routes/admin-connections')];
  });

  it('401 from OpenAI → 200 { ok:false, reason } and the row stores the reason', async () => {
    const res = await request(app).post('/api/admin/connections/conn-1/test').expect(200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.status, 401);
    assert.equal(res.body.reason, 'La API de OpenAI rechazó la clave (401).');
    assert.doesNotMatch(JSON.stringify(res.body), /sk-proj-Zz99887766/);
    assert.equal(lastUpdate.data.lastSyncOk, false);
    assert.equal(lastUpdate.data.lastSyncError, 'La API de OpenAI rechazó la clave (401).');
  });

  it('a success still answers the model list', async () => {
    syncResult = { ok: true, count: 2, created: 2, updated: 0, models: [{ name: 'gpt-x', displayName: 'GPT X', type: 'text', provider: 'OpenAI' }] };
    const res = await request(app).post('/api/admin/connections/conn-1/test').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.count, 2);
  });

  it('our own fault (DB down) is still a 5xx', async () => {
    findUnique = async () => { throw new Error('db down'); };
    await request(app).post('/api/admin/connections/conn-1/test').expect(500);
  });
});

describe('GET /api/elevenlabs/voices|models — no key is an empty catalog, not a 400', () => {
  const restores = [];
  let app;
  let oldKey;
  before(() => {
    oldKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    restores.push(mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: (req, _res, next) => { req.user = { id: 'u1' }; next(); },
    }));
    restores.push(mockResolvedModule(require.resolve('../src/config/database'), {
      apiUsage: { aggregate: async () => ({ _sum: { tokens: 0 } }), create: async () => ({}) },
    }));
    restores.push(mockResolvedModule(require.resolve('@elevenlabs/elevenlabs-js'), {
      ElevenLabsClient: class {
        constructor({ apiKey }) { this.apiKey = apiKey; }
        get voices() { return { getAll: async () => ({ voices: [{ voiceId: 'v1', name: 'Jane', key: this.apiKey }] }) }; }
        get models() { return { list: async () => [{ modelId: 'eleven_multilingual_v2' }] }; }
      },
    }));
    app = buildRouteTestApp('/api/elevenlabs', reloadModule('../src/routes/elevenlabs'));
  });
  after(() => {
    while (restores.length) restores.pop()();
    delete require.cache[require.resolve('../src/routes/elevenlabs')];
    if (oldKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldKey;
  });

  it('answers 200 { configured:false } without a key', async () => {
    const voices = await request(app).get('/api/elevenlabs/voices').expect(200);
    assert.deepEqual(voices.body, { configured: false, voices: [] });
    const models = await request(app).get('/api/elevenlabs/models').expect(200);
    assert.deepEqual(models.body, { configured: false, models: [] });
  });

  it('picks up a key applied AFTER the router loaded (Admin → Conexiones bridge)', async () => {
    process.env.ELEVENLABS_API_KEY = 'xi-runtime-key';
    const voices = await request(app).get('/api/elevenlabs/voices').expect(200);
    assert.equal(voices.body.configured, true);
    assert.equal(voices.body.voices[0].name, 'Jane');
    assert.equal(voices.body.voices[0].key, 'xi-runtime-key');
    delete process.env.ELEVENLABS_API_KEY;
  });

  it('action endpoints keep a stable, filterable «not configured» code', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/elevenlabs.js'), 'utf8');
    assert.doesNotMatch(src, /const ELEVENLABS_API_KEY = process\.env\.ELEVENLABS_API_KEY/);
    assert.match(src, /code: 'provider_not_configured'/);
  });
});
