'use strict';

/**
 * agentes-coding/harness — Phase 4a sandbox tool loop.
 * Injectable LLM + memory driver only. No real models, no Docker, no Daytona.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sessionHarness = require('../src/services/agentes-coding/harness');
const { TOOL_DEFINITIONS, canonicalTool, argsDigest } = require('../src/services/agentes-coding/harness/tools');
const { resolveCaps, estimateTokens, defaultLlmTurn } = require('../src/services/agentes-coding/harness/runner');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');

const ON = { AGENTES_CODING_V2: '1' };

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

async function seeded(files = {
  'src/app.ts': 'export const n = 1;\n',
  'README.md': '# demo\n',
}) {
  const sb = sandbox();
  const session = await sb.createSession();
  for (const [p, body] of Object.entries(files)) {
    await sb.writeFile(session.id, p, body);
  }
  return { sb, session };
}

function spanishError(err, code) {
  assert.ok(err instanceof CodingSandboxError, err && err.stack);
  assert.equal(err.code, code);
  assert.match(
    err.message,
    /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|ruta|harness|turno|Tope|tiempo|Cancelad|archivo|válid|prompt|ejecución/i,
  );
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

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('implementation stays a native stub (no banned vendors, no /code, no dump)', () => {
  const root = path.join(__dirname, '../src/services/agentes-coding/harness');
  for (const file of fs.readdirSync(root)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i, file);
    assert.doesNotMatch(src, /sk-[A-Za-z0-9]{10,}/, file);
    assert.doesNotMatch(src, /globalThis\.fetch|require\(['"]node-fetch['"]\)/, file);
    assert.doesNotMatch(src, /require\(['"]@openhands|require\(['"]opencode/i, file);
  }
});

test('error catalog includes harness codes in Spanish', () => {
  for (const code of ['E_HARNESS_FAILED', 'E_HARNESS_NOT_FOUND']) {
    assert.ok(CATALOG[code], code);
    assert.match(CATALOG[code].message, /[áéíóúñÁÉÍÓÚÑ]|harness|turno|ejecución/i);
  }
  assert.match(CATALOG.E_FLAG_OFF.message, /desactiv/i);
  assert.match(CATALOG.E_CANCELLED.message, /cancelad/i);
});

test('SiraCode tool aliases map onto the sandbox quartet', () => {
  assert.equal(canonicalTool('read_file'), 'read');
  assert.equal(canonicalTool('write_file'), 'write');
  assert.equal(canonicalTool('bash'), 'exec');
  assert.equal(canonicalTool('list_files'), 'list');
  assert.equal(canonicalTool('webfetch'), null);
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ['read', 'write', 'exec', 'list']);
  assert.deepEqual(argsDigest('write', { path: 'a.ts', content: 'hello' }), { path: 'a.ts', bytes: 5 });
});

test('runForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  await assert.rejects(
    () => sessionHarness.runForRequest(sb, 'csb_x', { prompt: 'hola' }, { AGENTES_CODING_V2: '0' }),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('happy path: injectable LLM reads a jailed file and emits plan → tool → result', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'lee src/app.ts',
    llmTurn: scriptedLlm([
      { text: 'Voy a leer el archivo.', toolCalls: [{ name: 'read', arguments: { path: 'src/app.ts' } }] },
      { text: 'El archivo exporta n.', toolCalls: [] },
    ]),
  });
  assert.match(out.id, /^hrn_[a-f0-9]+$/);
  assert.equal(out.status, 'done');
  assert.equal(out.steps[0].kind, 'plan');
  assert.equal(out.steps[0].label, 'Plan');
  assert.equal(out.steps[1].kind, 'tool_call');
  assert.equal(out.steps[1].tool, 'read');
  assert.equal(out.steps[2].kind, 'tool_result');
  assert.equal(out.steps[2].ok, true);
  assert.match(out.steps[2].preview, /export const n/);
  assert.equal(out.steps[3].kind, 'done');
  assert.equal(out.text, 'El archivo exporta n.');
  assert.ok(out.tokensEstimate > 0);
  assert.equal(out.error, null);
  assert.doesNotMatch(JSON.stringify(out), /model_id|OpenRouter|sk-/i);
});

test('default stub LLM never calls a network model', async () => {
  const { sb, session } = await seeded();
  const stub = defaultLlmTurn();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'explica el repo',
    llmTurn: stub,
  });
  assert.equal(out.status, 'done');
  assert.equal(out.steps.filter((s) => s.kind === 'tool_call').length, 0);
  assert.match(out.text, /no ejecuté herramientas/i);
});

test('write + list stay inside the session jail', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'crea nota',
    llmTurn: scriptedLlm([
      {
        text: 'escribo',
        toolCalls: [{ name: 'write_file', arguments: { path: 'notes/ok.md', content: 'hola' } }],
      },
      { text: 'listo', toolCalls: [{ name: 'ls', arguments: { path: 'notes' } }] },
      { text: 'hecho', toolCalls: [] },
    ]),
  });
  assert.equal(out.status, 'done');
  const listed = await sb.listFiles(session.id, 'notes');
  assert.equal(listed[0].path, 'notes/ok.md');
  const buf = await sb.readFile(session.id, 'notes/ok.md');
  assert.equal(buf.toString('utf8'), 'hola');
  const listResult = out.steps.find((s) => s.kind === 'tool_result' && s.tool === 'list');
  assert.equal(listResult.ok, true);
  assert.match(listResult.preview, /notes\/ok\.md/);
});

test('path jail records E_PATH_ESCAPE on the tool result', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'lee fuera',
    llmTurn: scriptedLlm([
      { text: '', toolCalls: [{ name: 'read', arguments: { path: '../etc/passwd' } }] },
      { text: 'no pude', toolCalls: [] },
    ]),
  });
  assert.equal(out.status, 'done');
  const result = out.steps.find((s) => s.kind === 'tool_result');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PATH_ESCAPE');
  assert.match(result.preview, /ruta|workspace/i);
});

test('step cap is E_QUOTA in Spanish and the run is stored', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionHarness.runSession(sb, session.id, {
      env: ON,
      prompt: 'bucle',
      maxSteps: 2,
      llmTurn: async () => ({
        text: 'otra',
        toolCalls: [{ name: 'list', arguments: { path: '.' } }],
      }),
    }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
  const listed = await sessionHarness.listRuns(sb, session.id);
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].status, 'quota');
  assert.equal(listed.runs[0].error.code, 'E_QUOTA');
});

test('token cap is E_QUOTA', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionHarness.runSession(sb, session.id, {
      env: ON,
      prompt: 'hola',
      maxTokens: 64,
      llmTurn: async () => ({ text: 'x'.repeat(80), toolCalls: [] }),
    }),
    (err) => spanishError(err, 'E_QUOTA'),
  );
});

test('time cap is E_TIMEOUT in Spanish', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionHarness.runSession(sb, session.id, {
      env: ON,
      prompt: 'espera',
      timeoutMs: 30,
      llmTurn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { text: 'tarde', toolCalls: [] };
      },
    }),
    (err) => spanishError(err, 'E_TIMEOUT'),
  );
  const listed = await sessionHarness.listRuns(sb, session.id);
  assert.equal(listed.runs[0].status, 'error');
  assert.equal(listed.runs[0].error.code, 'E_TIMEOUT');
});

test('cancel aborts an in-flight run with E_CANCELLED', async () => {
  const { sb, session } = await seeded();
  let released;
  const started = new Promise((resolve) => { released = resolve; });
  const llmTurn = async ({ signal }) => {
    released();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: 'tarde', toolCalls: [] }), 4000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  const pending = sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'cancela',
    llmTurn,
    timeoutMs: 5000,
  });
  await started;
  const raw = sb._unsafeGetRaw(session.id);
  const runId = raw.harness.items[0].id;
  const cancelled = await sessionHarness.cancelRun(sb, session.id, runId);
  assert.equal(cancelled.run.status, 'cancelled');
  await assert.rejects(() => pending, (err) => spanishError(err, 'E_CANCELLED'));
});

test('missing run id is E_HARNESS_NOT_FOUND', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionHarness.getRun(sb, session.id, 'hrn_missing'),
    (err) => spanishError(err, 'E_HARNESS_NOT_FOUND'),
  );
});

test('empty prompt is E_PARAMS', async () => {
  const { sb, session } = await seeded();
  await assert.rejects(
    () => sessionHarness.runSession(sb, session.id, { env: ON, prompt: '   ' }),
    (err) => spanishError(err, 'E_PARAMS'),
  );
});

test('caps resolve from env with bounds', () => {
  const caps = resolveCaps({
    AGENTES_CODING_HARNESS_MAX_STEPS: '3',
    AGENTES_CODING_HARNESS_MAX_TOKENS: '200',
    AGENTES_CODING_HARNESS_TIMEOUT_MS: '500',
  }, {});
  assert.equal(caps.maxSteps, 3);
  assert.equal(caps.maxTokens, 200);
  assert.equal(caps.timeoutMs, 500);
  assert.ok(estimateTokens('abcd') >= 1);
});

test('POST /sessions/:id/harness/run is 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({ env: {}, sandbox: sandbox() }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const paths = [
      ['POST', '/api/agentes-coding/sessions/csb_x/harness/run'],
      ['GET', '/api/agentes-coding/sessions/csb_x/harness'],
      ['GET', '/api/agentes-coding/sessions/csb_x/harness/hrn_x'],
    ];
    for (const [method, urlPath] of paths) {
      const sendBody = method === 'POST';
      const { status, body } = await new Promise((resolve, reject) => {
        const headers = { connection: 'close' };
        if (sendBody) headers['Content-Type'] = 'application/json';
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }));
        });
        req.on('error', reject);
        req.end(sendBody ? '{"prompt":"x"}' : undefined);
      });
      assert.equal(status, 404, `${method} ${urlPath}`);
      assert.equal(body.error, 'not_found');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP harness run when flag is on uses injectable LLM', { skip: !express }, async () => {
  const { sb, session } = await seeded();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (_req, _res, next) => next(),
    harnessLlm: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read', arguments: { path: 'README.md' } }] },
      { text: 'demo', toolCalls: [] },
    ]),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (method, urlPath, body) => new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
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
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const ran = await request('POST', `/api/agentes-coding/sessions/${session.id}/harness/run`, {
      prompt: 'resume el readme',
    });
    assert.equal(ran.status, 201);
    assert.equal(ran.json.ok, true);
    assert.equal(ran.json.run.status, 'done');
    assert.match(ran.json.run.steps[2].preview, /demo/);
    const listed = await request('GET', `/api/agentes-coding/sessions/${session.id}/harness`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.runs.length, 1);
    const got = await request('GET', `/api/agentes-coding/sessions/${session.id}/harness/${ran.json.run.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.run.id, ran.json.run.id);
    assert.doesNotMatch(JSON.stringify(ran.json), /model_id|OpenRouter/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('route source mounts /harness behind the flag helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/agentes-coding.js'), 'utf8');
  assert.match(src, /\/sessions\/:id\/harness\/run/);
  assert.match(src, /\/sessions\/:id\/harness\/:runId/);
  assert.match(src, /isAgentesCodingV2Enabled/);
  assert.match(src, /error: 'not_found'/);
  assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i);
  assert.doesNotMatch(src, /sk-[A-Za-z0-9]{8,}/);
});
