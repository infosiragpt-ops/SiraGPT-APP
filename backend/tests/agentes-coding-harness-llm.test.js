'use strict';

/**
 * agentes-coding/harness/llm — Phase 4d production-shaped adapter.
 * Injectable complete / createClient only. No real network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sessionHarness = require('../src/services/agentes-coding/harness');
const {
  resolveCodingModel,
  listCodingModelAliases,
  createHarnessLlmTurn,
  resolveHarnessLlmTurn,
  toProviderMessages,
  toOpenAiTools,
  ALIAS_RAPIDO,
  ALIAS_PRO,
  UNKNOWN_ALIAS,
  PROVIDER_DOWN,
  PROVIDER_TIMEOUT,
} = require('../src/services/agentes-coding/harness/llm');
const { defaultLlmTurn } = require('../src/services/agentes-coding/harness/runner');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');

const ON = { AGENTES_CODING_V2: '1' };
const OFF = { AGENTES_CODING_V2: '0' };

let express = null;
let createAgentesCodingRouter = null;
try {
  express = require('express');
  ({ createAgentesCodingRouter } = require('../src/routes/agentes-coding'));
} catch (_) {
  express = null;
  createAgentesCodingRouter = null;
}

function sandbox(extra = {}) {
  return createCodingSandbox({
    env: { ...ON, ...(extra.env || {}) },
    autoGc: false,
    ...extra,
  });
}

async function seeded() {
  const sb = sandbox();
  const session = await sb.createSession({ userId: 'coding-owner' });
  await sb.writeFile(session.id, 'README.md', '# demo\n');
  return { sb, session };
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(err.message, /[áéíóúñÁÉÍÓÚÑ]|modelo|alias|tiempo|proveedor|configurad/i);
  assert.doesNotMatch(err.message, /sk-|Bearer |AKIA|BEGIN /);
  return true;
}

function scriptedLlm(turns) {
  let i = 0;
  return async function llmTurn() {
    const next = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
}

function fakeChoice(text, toolCalls) {
  return {
    choices: [{
      message: {
        content: text,
        tool_calls: (toolCalls || []).map((call, idx) => ({
          id: `call_${idx}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments || {}),
          },
        })),
      },
    }],
  };
}

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('adapter source stays native (no banned vendors, no secrets)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/agentes-coding/harness/llm.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i);
  assert.doesNotMatch(src, /sk-[A-Za-z0-9]{10,}/);
  assert.doesNotMatch(src, /globalThis\.fetch|require\(['"]node-fetch['"]\)/);
});

test('alias table resolves brand names and rejects unknowns', () => {
  assert.equal(resolveCodingModel('Sira Rápido').alias, ALIAS_RAPIDO);
  assert.equal(resolveCodingModel('sira-rapido').tier, 'rapido');
  assert.equal(resolveCodingModel('Sira Pro').alias, ALIAS_PRO);
  assert.equal(resolveCodingModel('sira-pro').tier, 'pro');
  assert.equal(resolveCodingModel('').alias, ALIAS_RAPIDO);
  assert.equal(resolveCodingModel(null).alias, ALIAS_RAPIDO);
  assert.deepEqual(listCodingModelAliases(), [ALIAS_RAPIDO, ALIAS_PRO]);
  assert.throws(() => resolveCodingModel('gpt-4o'), (err) => spanishError(err, 'E_PARAMS'));
  assert.throws(() => resolveCodingModel('claude-sonnet'), (err) => spanishError(err, 'E_PARAMS'));
  assert.throws(() => resolveCodingModel('unknown-model'), (err) => spanishError(err, 'E_PARAMS'));
  const unknown = (() => {
    try { resolveCodingModel('gpt-4o'); } catch (err) { return err; }
    return null;
  })();
  assert.equal(unknown.message, UNKNOWN_ALIAS);
  assert.doesNotMatch(unknown.message, /gpt-4o|deepseek|model_id/i);
});

test('toProviderMessages flattens tool rows as data', () => {
  const out = toProviderMessages([
    { role: 'system', content: 'sys' },
    { role: 'tool', content: 'dato' },
  ]);
  assert.equal(out[1].role, 'user');
  assert.match(out[1].content, /TOOL_RESULT/);
  assert.match(out[1].content, /dato/);
});

test('toOpenAiTools projects the sandbox quartet', () => {
  const tools = toOpenAiTools([
    { name: 'read', description: 'Lee', args: ['path'] },
  ]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'read');
  assert.ok(tools[0].function.parameters.properties.path);
});

test('injectable complete wins and never opens a network client', async () => {
  let created = 0;
  const seen = [];
  const turn = createHarnessLlmTurn({
    env: ON,
    modelAlias: 'Sira Pro',
    createClient() {
      created += 1;
      throw new Error('createClient must not run when complete is injected');
    },
    async complete(payload, extras) {
      seen.push({ payload, extras });
      return fakeChoice('ok', [{ name: 'read', arguments: { path: 'README.md' } }]);
    },
  });
  const out = await turn({
    messages: [{ role: 'user', content: 'lee' }],
    tools: [{ name: 'read', description: 'Lee', args: ['path'] }],
  });
  assert.equal(created, 0);
  assert.equal(out.text, 'ok');
  assert.equal(out.toolCalls[0].name, 'read');
  assert.equal(out.toolCalls[0].arguments.path, 'README.md');
  assert.equal(seen[0].extras.alias, ALIAS_PRO);
  assert.doesNotMatch(JSON.stringify({ text: out.text, toolCalls: out.toolCalls }), /sk-|Bearer /);
});

test('resolveHarnessLlmTurn: injectable llmTurn wins over the adapter', async () => {
  let adapterCalls = 0;
  const injected = async () => ({ text: 'inyectado', toolCalls: [] });
  const turn = resolveHarnessLlmTurn({
    env: ON,
    llmTurn: injected,
    async complete() {
      adapterCalls += 1;
      return fakeChoice('adapter');
    },
  });
  const out = await turn({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.text, 'inyectado');
  assert.equal(adapterCalls, 0);
});

test('resolveHarnessLlmTurn: flag off keeps the local stub', async () => {
  let adapterCalls = 0;
  const turn = resolveHarnessLlmTurn({
    env: OFF,
    async complete() {
      adapterCalls += 1;
      return fakeChoice('adapter');
    },
  });
  const out = await turn({ messages: [{ role: 'user', content: 'hola' }] });
  assert.match(out.text, /no ejecuté herramientas/i);
  assert.equal(adapterCalls, 0);
  const stub = defaultLlmTurn();
  const stubOut = await stub({ messages: [{ role: 'user', content: 'hola' }] });
  assert.match(stubOut.text, /no ejecuté herramientas/i);
});

test('provider 5xx maps to Spanish E_PROVIDER without leaking secrets', async () => {
  const turn = createHarnessLlmTurn({
    env: ON,
    async complete() {
      const err = new Error('upstream 503 Authorization: Bearer sk-secretvalue0123456789');
      err.status = 503;
      throw err;
    },
  });
  await assert.rejects(
    () => turn({ messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      spanishError(err, 'E_PROVIDER');
      assert.equal(err.message, PROVIDER_DOWN);
      assert.doesNotMatch(err.message, /sk-secret|Bearer |503 Authorization/i);
      return true;
    },
  );
});

test('adapter timeout maps to Spanish E_TIMEOUT', async () => {
  const turn = createHarnessLlmTurn({
    env: ON,
    timeoutMs: 25,
    async complete(_payload, extras) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(fakeChoice('tarde')), 80);
        extras.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
          reject(err);
        });
      });
    },
  });
  await assert.rejects(
    () => turn({ messages: [{ role: 'user', content: 'x' }] }),
    (err) => {
      spanishError(err, 'E_TIMEOUT');
      assert.equal(err.message, PROVIDER_TIMEOUT);
      return true;
    },
  );
});

test('missing client is E_PROVIDER in Spanish', async () => {
  const turn = createHarnessLlmTurn({
    env: ON,
    createClient: () => null,
  });
  await assert.rejects(
    () => turn({ messages: [{ role: 'user', content: 'x' }] }),
    (err) => spanishError(err, 'E_PROVIDER'),
  );
});

test('runSession without llmTurn uses the adapter when the flag is on', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'resume',
    modelAlias: 'Sira Rápido',
    providerComplete: async () => fakeChoice('desde el adaptador'),
  });
  assert.equal(out.status, 'done');
  assert.equal(out.text, 'desde el adaptador');
  assert.equal(out.modelAlias, ALIAS_RAPIDO);
  assert.doesNotMatch(JSON.stringify(out), /model_id|deepseek|sk-/i);
});

test('injected llmTurn still wins on runForRequest', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runForRequest(sb, session.id, {
    prompt: 'lee README.md',
    modelAlias: 'Sira Pro',
  }, ON, {
    llmTurn: scriptedLlm([
      { text: 'inyectado', toolCalls: [] },
    ]),
    providerComplete: async () => fakeChoice('no-debes-verme'),
  });
  assert.equal(out.run.text, 'inyectado');
  assert.equal(out.run.modelAlias, ALIAS_PRO);
  assert.doesNotMatch(JSON.stringify(out), /deepseek|model_id|sk-/i);
});

test('unknown modelAlias is E_PARAMS and does not start a run', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionHarness.runForRequest(sb, session.id, {
      prompt: 'hola',
      modelAlias: 'gpt-4o',
    }, ON, { llmTurn: scriptedLlm([{ text: 'no', toolCalls: [] }]) }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
  const listed = await sessionHarness.listRuns(sb, session.id);
  assert.equal(listed.runs.length, 0);
});

test('flag-off runForRequest is unchanged (E_FLAG_OFF)', async () => {
  const sb = createCodingSandbox({ env: OFF, autoGc: false });
  await assert.rejects(
    () => sessionHarness.runForRequest(sb, 'csb_x', { prompt: 'hola', modelAlias: 'Sira Pro' }, OFF),
    (err) => {
      assert.equal(err.code, 'E_FLAG_OFF');
      assert.match(err.message, /desactiv/i);
      return true;
    },
  );
});

test('error catalog still covers E_PROVIDER / E_TIMEOUT in Spanish', () => {
  assert.match(CATALOG.E_PROVIDER.message, /proveedor|disponible/i);
  assert.match(CATALOG.E_TIMEOUT.message, /tiempo/i);
});

test('HTTP modelAlias unknown is 400; injectable still wins', { skip: !express }, async () => {
  const { sb, session } = await seeded();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
    harnessLlm: scriptedLlm([{ text: 'http-inyectado', toolCalls: [] }]),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (body) => new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/agentes-coding/sessions/${session.id}/harness/run`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  try {
    const bad = await request({ prompt: 'hola', modelAlias: 'gpt-4o' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'E_PARAMS');
    assert.doesNotMatch(JSON.stringify(bad.json), /gpt-4o|deepseek|sk-/i);

    const ok = await request({ prompt: 'hola', modelAlias: 'Sira Pro' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.run.text, 'http-inyectado');
    assert.equal(ok.json.run.modelAlias, ALIAS_PRO);
    assert.doesNotMatch(JSON.stringify(ok.json), /deepseek|model_id|sk-/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP harness run stays 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/agentes-coding/sessions/csb_x/harness/run',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ prompt: 'x', modelAlias: 'Sira Pro' }));
    });
    assert.equal(result.status, 404);
    assert.equal(result.json.error, 'not_found');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
