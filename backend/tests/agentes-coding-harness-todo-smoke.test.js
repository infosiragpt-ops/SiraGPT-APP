'use strict';

/**
 * AGENTES_CODING_V2 Phase 4f — API-only CI smoke.
 * Memory sandbox + injectable LLM writes a tiny todo-app fixture.
 * Offline only. No real models, no Docker, no Daytona, no OpenRouter.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sessionHarness = require('../src/services/agentes-coding/harness');
const { createCodingSandbox } = require('../src/services/agentes-coding/coding-sandbox');
const fixture = require('./fixtures/agentes-coding-todo');
const todoApp = require('./fixtures/agentes-coding-todo/src/app');

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

async function emptySession(extra = {}) {
  const sb = sandbox(extra);
  const session = await sb.createSession({ userId: 'coding-owner' });
  assert.equal(session.driver, 'memory');
  return { sb, session };
}

async function assertTodoFiles(sb, sessionId) {
  const listed = await sb.listFiles(sessionId, '.');
  const paths = listed.map((f) => f.path);
  assert.ok(paths.includes('package.json'), 'package.json missing');
  assert.ok(paths.includes('src/app.js'), 'src/app.js missing');
  const pkg = await sb.readFile(sessionId, 'package.json');
  const app = await sb.readFile(sessionId, 'src/app.js');
  assert.equal(pkg.toString('utf8'), fixture.FILES['package.json']);
  assert.equal(app.toString('utf8'), fixture.FILES['src/app.js']);
  assert.match(pkg.toString('utf8'), /"name": "todo-app"/);
  assert.match(app.toString('utf8'), /function add\(/);
}

function pendingId(run) {
  assert.ok(run.pendingPermissions && run.pendingPermissions.length >= 1, 'expected a pending permission');
  return run.pendingPermissions[0].id;
}

function noVendorLeak(payload) {
  assert.doesNotMatch(JSON.stringify(payload), /model_id|OpenRouter|daytona|sk-/i);
}

test('this suite never assigns process.env.AGENTES_CODING_V2', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(src, /process\.env\.AGENTES_CODING_V2\s*=/);
});

test('fixture + smoke stay native (no banned vendors, no /code, no network)', () => {
  const files = [
    __filename,
    path.join(__dirname, 'fixtures/agentes-coding-todo/index.js'),
    path.join(__dirname, 'fixtures/agentes-coding-todo/src/app.js'),
    path.join(__dirname, 'fixtures/agentes-coding-todo/package.json'),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /daytona|OpenRouter|\/code\/page/i, file);
    assert.doesNotMatch(src, /sk-[A-Za-z0-9]{10,}/, file);
    assert.doesNotMatch(src, /globalThis\.fetch|require\(['"]node-fetch['"]\)/, file);
    assert.doesNotMatch(src, /require\(['"]@openhands|require\(['"]opencode/i, file);
  }
});

test('fixture todo app adds, lists and completes locally (no harness)', () => {
  const item = todoApp.add('comprar leche');
  assert.deepEqual(item, { id: 1, title: 'comprar leche', done: false });
  assert.deepEqual(todoApp.list(), [item]);
  assert.deepEqual(todoApp.complete(1), { id: 1, title: 'comprar leche', done: true });
  assert.deepEqual(todoApp.main(['add', 'pan']), { id: 2, title: 'pan', done: false });
});

test('memory createSession + scripted llmTurn writes package.json and src/app.js, status done', async () => {
  const { sb, session } = await emptySession();
  const out = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: fixture.PROMPT,
    llmTurn: fixture.scriptedLlm(fixture.writeTurns()),
  });
  assert.match(out.id, /^hrn_[a-f0-9]+$/);
  assert.equal(out.status, 'done');
  assert.equal(out.text, fixture.DONE_TEXT);
  assert.equal(out.error, null);
  assert.equal(out.pendingPermissions.length, 0);
  assert.equal(out.steps[0].kind, 'plan');
  assert.equal(out.steps[0].label, 'Plan');
  const writes = out.steps.filter((s) => s.kind === 'tool_call' && s.tool === 'write');
  assert.equal(writes.length, 2);
  assert.ok(out.steps.some((s) => s.kind === 'tool_result' && s.tool === 'write' && s.ok));
  assert.equal(out.steps[out.steps.length - 1].kind, 'done');
  await assertTodoFiles(sb, session.id);
  noVendorLeak(out);
});

test('optional HITL allow_once on exec after writing the todo files', async () => {
  const { sb, session } = await emptySession();
  fixture.attachMemoryExec(sb._unsafeGetRaw(session.id));
  const paused = await sessionHarness.runSession(sb, session.id, {
    env: ON,
    prompt: fixture.PROMPT,
    llmTurn: fixture.scriptedLlm(fixture.writeThenExecTurns()),
  });
  assert.equal(paused.status, 'awaiting_permission');
  assert.equal(paused.pendingPermissions[0].tool, 'exec');
  assert.equal(paused.pendingPermissions[0].reason, 'exec_requires_approval');
  await assertTodoFiles(sb, session.id);

  const resumed = await sessionHarness.resolvePermission(
    sb,
    session.id,
    paused.id,
    pendingId(paused),
    'allow_once',
  );
  assert.equal(resumed.ok, true);
  assert.equal(resumed.decision, 'allow_once');
  assert.equal(resumed.run.status, 'done');
  const execResult = resumed.run.steps.find((s) => s.kind === 'tool_result' && s.tool === 'exec');
  assert.equal(execResult.ok, true);
  assert.match(execResult.preview, /comprar leche/);
  assert.equal(resumed.run.pendingPermissions.length, 0);
  await assertTodoFiles(sb, session.id);
  noVendorLeak(resumed);
});

test('POST /sessions then harness/run is 404 when the flag is off', { skip: !express }, async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: {},
    sandbox: createCodingSandbox({ env: { AGENTES_CODING_V2: '0' }, autoGc: false }),
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const paths = [
      ['POST', '/api/agentes-coding/sessions'],
      ['POST', '/api/agentes-coding/sessions/csb_x/harness/run'],
    ];
    for (const [method, urlPath] of paths) {
      const { status, body } = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          headers: { 'Content-Type': 'application/json', connection: 'close' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ prompt: fixture.PROMPT }));
      });
      assert.equal(status, 404, `${method} ${urlPath}`);
      assert.equal(body.error, 'not_found');
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP createSession + harness/run writes the todo fixture (flag on, injectable LLM)', { skip: !express }, async () => {
  const sb = sandbox();
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
    harnessLlm: fixture.scriptedLlm(fixture.writeTurns()),
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
    const created = await request('POST', '/api/agentes-coding/sessions', {});
    assert.equal(created.status, 201);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.session.driver, 'memory');
    const sessionId = created.json.session.id;
    assert.match(sessionId, /^csb_/);

    const ran = await request('POST', `/api/agentes-coding/sessions/${sessionId}/harness/run`, {
      prompt: fixture.PROMPT,
    });
    assert.equal(ran.status, 201);
    assert.equal(ran.json.ok, true);
    assert.equal(ran.json.run.status, 'done');
    assert.equal(ran.json.run.text, fixture.DONE_TEXT);

    const listed = await request('GET', `/api/agentes-coding/sessions/${sessionId}/files`);
    assert.equal(listed.status, 200);
    const paths = listed.json.files.map((f) => f.path);
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('src/app.js'));

    const pkg = await request('POST', `/api/agentes-coding/sessions/${sessionId}/read`, {
      path: 'package.json',
    });
    assert.equal(pkg.status, 200);
    assert.equal(pkg.json.content, fixture.FILES['package.json']);

    const appJs = await request('POST', `/api/agentes-coding/sessions/${sessionId}/read`, {
      path: 'src/app.js',
    });
    assert.equal(appJs.status, 200);
    assert.equal(appJs.json.content, fixture.FILES['src/app.js']);
    noVendorLeak(ran.json);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('HTTP HITL allow_once resumes the todo exec after the writes', { skip: !express }, async () => {
  const sb = sandbox();
  const createdSession = await sb.createSession({ userId: 'coding-owner' });
  fixture.attachMemoryExec(sb._unsafeGetRaw(createdSession.id));
  const app = express();
  app.use(express.json());
  app.use('/api/agentes-coding', createAgentesCodingRouter({
    env: ON,
    sandbox: sb,
    authenticate: (req, _res, next) => { req.user = { id: 'coding-owner' }; next(); },
    harnessLlm: fixture.scriptedLlm(fixture.writeThenExecTurns()),
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
    const ran = await request('POST', `/api/agentes-coding/sessions/${createdSession.id}/harness/run`, {
      prompt: fixture.PROMPT,
    });
    assert.equal(ran.status, 201);
    assert.equal(ran.json.run.status, 'awaiting_permission');
    const permId = ran.json.run.pendingPermissions[0].id;
    const resolved = await request(
      'POST',
      `/api/agentes-coding/sessions/${createdSession.id}/harness/${ran.json.run.id}/permissions/${permId}/resolve`,
      { decision: 'allow_once' },
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.decision, 'allow_once');
    assert.equal(resolved.json.run.status, 'done');
    assert.match(resolved.json.run.steps.find((s) => s.kind === 'tool_result' && s.tool === 'exec').preview, /comprar leche/);
    await assertTodoFiles(sb, createdSession.id);
    noVendorLeak(resolved.json);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
