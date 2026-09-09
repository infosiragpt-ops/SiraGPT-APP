'use strict';

/**
 * agentes-coding/harness jobs — Phase 4c durable runs.
 * Injectable memory queue + store only. No real Redis, no BullMQ connect,
 * no Daytona, no /agentes chrome.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sessionHarness = require('../src/services/agentes-coding/harness');
const {
  shouldUseDurable,
  createJobsBackend,
  createMemoryQueue,
  createMemoryRunStore,
  startHarnessWorker,
  serializeRun,
  hydrateRun,
} = require('../src/services/agentes-coding/harness/jobs');
const { createCodingSandbox, CodingSandboxError } = require('../src/services/agentes-coding/coding-sandbox');
const { CATALOG } = require('../src/services/agentes-coding/coding-sandbox/errors');
const { ACTIVE_STATUSES } = require('../src/services/agentes-coding/harness/store');

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
  const session = await sb.createSession({ userId: 'coding-owner' });
  const raw = sb._unsafeGetRaw(session.id);
  raw.execImpl = async (cmd) => {
    const text = String(cmd || '');
    const echoed = text.match(/^echo\s+([\s\S]+)$/);
    return { stdout: echoed ? echoed[1] : text, exitCode: 0 };
  };
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
    /[áéíóúñÁÉÍÓÚÑ]|desactiv|sesión|sandbox|ruta|harness|turno|Tope|tiempo|Cancelad|archivo|válid|prompt|ejecución|permiso|deneg|encol/i,
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

function walkJs(root) {
  const files = [];
  const walk = (dir) => {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (file.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  return files;
}

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('jobs implementation is in-repo BullMQ pattern fusion (no dump, no Daytona)', () => {
  const root = path.join(__dirname, '../src/services/agentes-coding/harness');
  for (const file of walkJs(root)) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i, file);
    assert.doesNotMatch(src, /sk-[A-Za-z0-9]{10,}/, file);
    assert.doesNotMatch(src, /temporalio|@temporalio/i, file);
    assert.doesNotMatch(src, /require\(['"]@openhands|require\(['"]doc-sandbox/i, file);
  }
  const jobsSrc = fs.readFileSync(
    path.join(root, 'jobs/queue.js'),
    'utf8',
  );
  assert.match(jobsSrc, /attempts:\s*1/);
  assert.match(jobsSrc, /createMemoryQueue/);
});

test('error catalog includes E_HARNESS_QUEUE in Spanish', () => {
  assert.ok(CATALOG.E_HARNESS_QUEUE);
  assert.match(CATALOG.E_HARNESS_QUEUE.message, /encol|harness/i);
  assert.equal(CATALOG.E_HARNESS_QUEUE.status, 503);
});

test('shouldUseDurable stays off without injected jobs or REDIS_URL', () => {
  assert.equal(shouldUseDurable({}), false);
  assert.equal(shouldUseDurable(ON), false);
  assert.equal(shouldUseDurable({ AGENTES_CODING_V2: '1', REDIS_URL: 'redis://127.0.0.1:6379' }), true);
  assert.equal(shouldUseDurable({
    AGENTES_CODING_V2: '1',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AGENTES_CODING_HARNESS_JOBS: '0',
  }), false);
  assert.equal(shouldUseDurable({ NODE_ENV: 'production', AGENTES_CODING_V2: '1', REDIS_URL: 'redis://x' }), false);
  assert.equal(shouldUseDurable(ON, { jobs: createJobsBackend() }), true);
});

test('startHarnessWorker is a no-op when the flag is off', () => {
  assert.equal(startHarnessWorker({ env: {} }), null);
  assert.equal(startHarnessWorker({ env: { AGENTES_CODING_V2: '0', REDIS_URL: 'redis://x' } }), null);
  assert.equal(startHarnessWorker({ env: { AGENTES_CODING_V2: '1' } }), null);
});

test('memory fallback still runs the in-process loop (no jobs backend)', async () => {
  const { sb, session } = await seeded();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: 'lee src/app.ts',
    llmTurn: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read', arguments: { path: 'src/app.ts' } }] },
      { text: 'ok', toolCalls: [] },
    ]),
  });
  assert.equal(out.status, 'done');
  assert.equal(out.steps[0].kind, 'plan');
  assert.match(out.steps[2].preview, /export const n/);
  assert.equal(ACTIVE_STATUSES.includes(out.status), false);
});

test('durable path with fake queue enqueues and completes a read loop', async () => {
  const { sb, session } = await seeded();
  const queue = createMemoryQueue();
  const store = createMemoryRunStore();
  const jobs = createJobsBackend({ queue, store });
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    jobs,
    prompt: 'lee README.md',
    llmTurn: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read', arguments: { path: 'README.md' } }] },
      { text: 'demo', toolCalls: [] },
    ]),
  });
  assert.equal(out.status, 'done');
  assert.equal(out.text, 'demo');
  const saved = await store.get(out.id);
  assert.equal(saved.status, 'done');
  assert.equal(saved.sessionId, session.id);
  assert.ok(saved.caps && saved.caps.maxSteps >= 1);
  assert.equal(queue.pendingCount(), 0);
});

test('HITL pause persists across a new runner instance reading the store', async () => {
  const { sb, session } = await seeded();
  const store = createMemoryRunStore();
  const first = createJobsBackend({ store, queue: createMemoryQueue() });
  const llm = scriptedLlm([
    { text: 'ejecuto', toolCalls: [{ name: 'exec', arguments: { command: 'echo ok' } }] },
    { text: 'listo', toolCalls: [] },
  ]);
  const paused = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    jobs: first,
    prompt: 'corre',
    llmTurn: llm,
  });
  assert.equal(paused.status, 'awaiting_permission');
  assert.equal(paused.pendingPermissions.length, 1);
  const permId = paused.pendingPermissions[0].id;

  sessionHarness.forget(sb, session.id);
  assert.equal(sb._unsafeGetRaw(session.id).harness.items.length, 0);

  const second = createJobsBackend({ store, queue: createMemoryQueue() });
  const listed = await sessionHarness.getRun(sb, session.id, paused.id, { jobs: second });
  assert.equal(listed.run.status, 'awaiting_permission');
  assert.equal(listed.run.pendingPermissions[0].id, permId);
  const snap = await store.get(paused.id);
  assert.ok(snap.pause && snap.pause.currentCall);
  assert.equal(hydrateRun(snap).status, 'awaiting_permission');
  assert.doesNotMatch(JSON.stringify(snap), /llmTurn|AbortController/);

  const resumed = await sessionHarness.resolvePermission(
    sb,
    session.id,
    paused.id,
    permId,
    'allow_once',
    { jobs: second, llmTurn: llm },
  );
  assert.equal(resumed.run.status, 'done');
  assert.equal(resumed.decision, 'allow_once');
  assert.equal(resumed.remembered, false);
  const after = await store.get(paused.id);
  assert.equal(after.status, 'done');
  assert.equal(after.pause, null);
});

test('reject persists cancelled + E_PERMISSION_DENIED across restart', async () => {
  const { sb, session } = await seeded();
  const store = createMemoryRunStore();
  const jobs = createJobsBackend({ store, queue: createMemoryQueue() });
  const paused = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    jobs,
    prompt: 'exec',
    llmTurn: scriptedLlm([
      { text: 'x', toolCalls: [{ name: 'exec', arguments: { command: 'echo no' } }] },
    ]),
  });
  sessionHarness.forget(sb, session.id);
  const again = createJobsBackend({ store, queue: createMemoryQueue() });
  const rejected = await sessionHarness.resolvePermission(
    sb,
    session.id,
    paused.id,
    paused.pendingPermissions[0].id,
    'reject',
    { jobs: again },
  );
  assert.equal(rejected.run.status, 'cancelled');
  assert.equal(rejected.decision, 'reject');
  assert.equal(rejected.run.error.code, 'E_PERMISSION_DENIED');
  const snap = await store.get(paused.id);
  assert.equal(snap.status, 'cancelled');
});

test('cancel of an awaiting durable run persists E_CANCELLED', async () => {
  const { sb, session } = await seeded();
  const store = createMemoryRunStore();
  const jobs = createJobsBackend({ store, queue: createMemoryQueue() });
  const paused = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    jobs,
    prompt: 'exec',
    llmTurn: scriptedLlm([
      { text: 'x', toolCalls: [{ name: 'exec', arguments: { command: 'echo x' } }] },
    ]),
  });
  const cancelled = await sessionHarness.cancelRun(sb, session.id, paused.id, { jobs });
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(cancelled.run.error.code, 'E_CANCELLED');
  const snap = await store.get(paused.id);
  assert.equal(snap.status, 'cancelled');
});

test('durable runForRequest refuses when the flag is off', async () => {
  const sb = createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false });
  const jobs = createJobsBackend();
  await assert.rejects(
    () => sessionHarness.runForRequest(
      sb,
      'csb_x',
      { prompt: 'hola' },
      { AGENTES_CODING_V2: '0' },
      { jobs },
    ),
    (err) => spanishError(err, 'E_FLAG_OFF'),
  );
});

test('serializeRun strips functions and keeps HITL fields', () => {
  const row = {
    id: 'hrn_abc',
    status: 'awaiting_permission',
    prompt: 'hola',
    steps: [{ seq: 1, kind: 'plan', label: 'Plan' }],
    text: '',
    tokensEstimate: 4,
    createdAt: 10,
    finishedAt: null,
    error: null,
    caps: { maxSteps: 8, maxTokens: 100, timeoutMs: 30 },
    permissions: [{ id: 'prm_1', tool: 'exec', status: 'pending' }],
    pause: {
      transcript: [{ role: 'user', content: 'hola' }],
      assistantText: 'x',
      step: 0,
      currentCall: { name: 'exec', arguments: { command: 'echo 1' } },
      remainingCalls: [],
      llmTurn: async () => ({}),
    },
    abort: new AbortController(),
  };
  const snap = serializeRun(row, { sessionId: 'csb_1', grants: ['exec'] });
  assert.equal(snap.sessionId, 'csb_1');
  assert.equal(snap.grants[0], 'exec');
  assert.equal(snap.pause.currentCall.name, 'exec');
  assert.equal(Object.prototype.hasOwnProperty.call(snap.pause, 'llmTurn'), false);
  const round = hydrateRun(snap);
  assert.ok(round.abort);
  assert.equal(round.status, 'awaiting_permission');
});

test('HTTP durable harness + flag-off 404 (injectable jobs)', { skip: !express }, async () => {
  const offApp = express();
  offApp.use(express.json());
  offApp.use('/api/agentes-coding', createAgentesCodingRouter({
    env: {},
    sandbox: sandbox(),
    harnessJobs: createJobsBackend(),
  }));
  const offServer = await new Promise((resolve) => {
    const s = offApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = offServer.address().port;
    const { status, body } = await new Promise((resolve, reject) => {
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
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        }));
      });
      req.on('error', reject);
      req.end('{"prompt":"x"}');
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  } finally {
    await new Promise((r) => offServer.close(r));
  }

  const { sb, session } = await seeded();
  const jobs = createJobsBackend();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
    harnessJobs: jobs,
    harnessLlm: scriptedLlm([
      { text: 'leo', toolCalls: [{ name: 'read', arguments: { path: 'README.md' } }] },
      { text: 'demo', toolCalls: [] },
    ]),
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const request = (method, urlPath, body) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
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
    assert.equal(ran.json.run.status, 'done');
    const got = await request('GET', `/api/agentes-coding/sessions/${session.id}/harness/${ran.json.run.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.run.id, ran.json.run.id);
    assert.doesNotMatch(JSON.stringify(ran.json), /model_id|OpenRouter/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
